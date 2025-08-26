import EventEmitter from 'node:events';

import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

import logger from '../utils/logger.js';

/**
 * Enterprise-grade Session Pool Manager
 * Manages WhatsApp client connections with automatic failover and load balancing
 */
export class SessionPool extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      maxPoolSize: config.maxPoolSize || 100,
      minPoolSize: config.minPoolSize || 10,
      acquireTimeout: config.acquireTimeout || 30_000,
      idleTimeout: config.idleTimeout || 300_000,
      evictionInterval: config.evictionInterval || 60_000,
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
      healthCheckInterval: config.healthCheckInterval || 30_000,
      ...config,
    };

    this.pool = new Map();
    this.activeConnections = new Map();
    this.pendingAcquisitions = [];
    this.stats = {
      created: 0,
      destroyed: 0,
      acquired: 0,
      released: 0,
      errors: 0,
      currentSize: 0,
      activeSize: 0,
    };

    // Redis for distributed session state
    this.redis = new IORedis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD,
      db: process.env.REDIS_DB || 1,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      enableOfflineQueue: true,
      maxRetriesPerRequest: 3,
    });

    this.redis.on('error', (error) => {
      logger.error('SessionPool Redis error:', error);
      this.emit('redis:error', error);
    });

    this.redis.on('connect', () => {
      logger.info('SessionPool Redis connected');
      this.emit('redis:connected');
    });

    this._startEvictionTimer();
    this._startHealthCheck();
  }

  /**
   * Acquire a session from the pool
   */
  async acquire(sessionId, options = {}) {
    const startTime = Date.now();
    const timeout = options.timeout || this.config.acquireTimeout;

    try {
      // Check if session exists in pool
      let session = this.pool.get(sessionId);

      if (!session) {
        // Try to restore from Redis
        session = await this._restoreSession(sessionId);

        if (!session) {
          // Create new session
          session = await this._createSession(sessionId, options);
        }
      }

      // Check session health
      if (!(await this._isHealthy(session))) {
        await this._recreateSession(sessionId, options);
        session = this.pool.get(sessionId);
      }

      // Mark as active
      this.activeConnections.set(sessionId, {
        session,
        acquiredAt: Date.now(),
        timeout,
      });

      this.stats.acquired++;
      this.stats.activeSize = this.activeConnections.size;

      logger.debug(`Session ${sessionId} acquired in ${Date.now() - startTime}ms`);
      this.emit('session:acquired', { sessionId, duration: Date.now() - startTime });

      return session;
    } catch (error) {
      this.stats.errors++;
      logger.error(`Failed to acquire session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Release a session back to the pool
   */
  async release(sessionId) {
    try {
      const activeSession = this.activeConnections.get(sessionId);

      if (!activeSession) {
        logger.warn(`Attempted to release non-active session: ${sessionId}`);
        return;
      }

      this.activeConnections.delete(sessionId);
      this.stats.released++;
      this.stats.activeSize = this.activeConnections.size;

      // Save session state to Redis
      await this._persistSession(sessionId, activeSession.session);

      logger.debug(`Session ${sessionId} released`);
      this.emit('session:released', { sessionId });

      // Process pending acquisitions
      this._processPendingAcquisitions();
    } catch (error) {
      logger.error(`Failed to release session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Destroy a session and remove from pool
   */
  async destroy(sessionId) {
    try {
      const session = this.pool.get(sessionId);

      if (session) {
        // Cleanup WhatsApp client
        if (session.client) {
          await session.client.destroy();
        }

        this.pool.delete(sessionId);
        this.activeConnections.delete(sessionId);

        // Remove from Redis
        await this.redis.del(`session:${sessionId}`);
        await this.redis.srem('sessions:active', sessionId);

        this.stats.destroyed++;
        this.stats.currentSize = this.pool.size;
        this.stats.activeSize = this.activeConnections.size;

        logger.info(`Session ${sessionId} destroyed`);
        this.emit('session:destroyed', { sessionId });
      }
    } catch (error) {
      logger.error(`Failed to destroy session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Create a new session
   */
  async _createSession(sessionId, options = {}) {
    try {
      const session = {
        id: sessionId,
        poolId: uuidv4(),
        createdAt: Date.now(),
        lastUsed: Date.now(),
        healthy: true,
        retries: 0,
        options,
        client: null, // Will be initialized by SessionManager
      };

      this.pool.set(sessionId, session);

      // Register in Redis
      await this.redis.sadd('sessions:active', sessionId);
      await this._persistSession(sessionId, session);

      this.stats.created++;
      this.stats.currentSize = this.pool.size;

      logger.info(`Created new session: ${sessionId}`);
      this.emit('session:created', { sessionId });

      return session;
    } catch (error) {
      logger.error(`Failed to create session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Restore session from Redis
   */
  async _restoreSession(sessionId) {
    try {
      const data = await this.redis.get(`session:${sessionId}`);

      if (!data) {
        return null;
      }

      const session = JSON.parse(data);
      session.restored = true;
      session.restoredAt = Date.now();

      this.pool.set(sessionId, session);
      this.stats.currentSize = this.pool.size;

      logger.info(`Restored session from Redis: ${sessionId}`);
      this.emit('session:restored', { sessionId });

      return session;
    } catch (error) {
      logger.error(`Failed to restore session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Persist session to Redis
   */
  async _persistSession(sessionId, session) {
    try {
      const data = {
        ...session,
        client: null, // Don't serialize client object
        persistedAt: Date.now(),
      };

      await this.redis.setex(
        `session:${sessionId}`,
        this.config.idleTimeout / 1000,
        JSON.stringify(data),
      );
    } catch (error) {
      logger.error(`Failed to persist session ${sessionId}:`, error);
    }
  }

  /**
   * Check session health
   */
  async _isHealthy(session) {
    if (!session || !session.client) {
      return false;
    }

    try {
      // Check if WhatsApp client is connected
      const state = await session.client.getState();
      return state === 'CONNECTED';
    } catch {
      return false;
    }
  }

  /**
   * Recreate unhealthy session
   */
  async _recreateSession(sessionId, options) {
    logger.warn(`Recreating unhealthy session: ${sessionId}`);
    await this.destroy(sessionId);
    return this._createSession(sessionId, options);
  }

  /**
   * Start eviction timer for idle sessions
   */
  _startEvictionTimer() {
    setInterval(() => {
      const now = Date.now();
      const { idleTimeout } = this.config;

      for (const [sessionId, session] of this.pool.entries()) {
        // Skip active sessions
        if (this.activeConnections.has(sessionId)) {
          continue;
        }

        // Check if session is idle
        if (now - session.lastUsed > idleTimeout) {
          logger.info(`Evicting idle session: ${sessionId}`);
          this.destroy(sessionId).catch((error) => {
            logger.error(`Failed to evict session ${sessionId}:`, error);
          });
        }
      }
    }, this.config.evictionInterval);
  }

  /**
   * Start health check timer
   */
  _startHealthCheck() {
    setInterval(async () => {
      const unhealthySessions = [];

      for (const [sessionId, session] of this.pool.entries()) {
        if (!(await this._isHealthy(session))) {
          unhealthySessions.push(sessionId);
        }
      }

      if (unhealthySessions.length > 0) {
        logger.warn(`Found ${unhealthySessions.length} unhealthy sessions`);
        this.emit('health:unhealthy', { sessions: unhealthySessions });
      }

      // Update metrics
      this.emit('metrics:update', this.getMetrics());
    }, this.config.healthCheckInterval);
  }

  /**
   * Process pending acquisition requests
   */
  _processPendingAcquisitions() {
    while (this.pendingAcquisitions.length > 0 && this.pool.size < this.config.maxPoolSize) {
      const pending = this.pendingAcquisitions.shift();
      pending.resolve();
    }
  }

  /**
   * Get pool metrics
   */
  getMetrics() {
    return {
      ...this.stats,
      poolUtilization:
        this.pool.size > 0 ? (this.activeConnections.size / this.pool.size) * 100 : 0,
      avgAcquisitionTime:
        this.stats.acquired > 0 ? this.stats.totalAcquisitionTime / this.stats.acquired : 0,
    };
  }

  /**
   * Shutdown pool
   */
  async shutdown() {
    logger.info('Shutting down SessionPool...');

    // Clear timers
    clearInterval(this.evictionTimer);
    clearInterval(this.healthCheckTimer);

    // Destroy all sessions
    const destroyPromises = [];
    for (const sessionId of this.pool.keys()) {
      destroyPromises.push(this.destroy(sessionId));
    }

    await Promise.all(destroyPromises);

    // Close Redis connection
    await this.redis.quit();

    logger.info('SessionPool shutdown complete');
  }
}

export default SessionPool;
