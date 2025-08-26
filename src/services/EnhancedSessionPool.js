import logger from '../utils/logger.js';
import { circuitBreakerManager } from '../patterns/CircuitBreaker.js';

/**
 * Enhanced Session Pool for managing multiple WhatsApp sessions
 * Handles load balancing, resource limits, and session lifecycle
 */
class EnhancedSessionPool {
  constructor() {
    this.pools = new Map(); // Pool per user
    this.globalSessions = new Map(); // All sessions globally
    this.maxSessionsPerUser = 5;
    this.globalMaxSessions = 100;
    this.sessionMetrics = new Map();
    this.circuitBreaker = circuitBreakerManager.getBreaker('SessionPool', {
      failureThreshold: 10,
      resetTimeout: 30000
    });
  }

  /**
   * Initialize the session pool
   */
  async initialize() {
    logger.info('🏊 Initializing Enhanced Session Pool');
    this.startMetricsCollection();
    this.startHealthCheck();
  }

  /**
   * Acquire a session for a user
   */
  async acquireSession(userId, plubotId) {
    const sessionId = `${userId}-${plubotId}`;
    
    return this.circuitBreaker.execute(async () => {
      // Check if session already exists
      if (this.globalSessions.has(sessionId)) {
        const existing = this.globalSessions.get(sessionId);
        if (existing.status === 'ready' || existing.status === 'authenticated') {
          logger.info(`♻️ Reusing existing session ${sessionId}`);
          this.updateMetrics(sessionId, 'reused');
          return existing;
        }
      }

      // Check global capacity
      if (this.globalSessions.size >= this.globalMaxSessions) {
        logger.error(`🚫 Global session limit reached (${this.globalMaxSessions})`);
        throw new Error('System at maximum capacity. Please try again later.');
      }

      // Check user capacity
      const userPool = this.getOrCreateUserPool(userId);
      if (userPool.size >= this.maxSessionsPerUser) {
        logger.warn(`⚠️ User ${userId} at session limit, removing oldest`);
        await this.removeOldestUserSession(userId);
      }

      // Create new session
      return this.createPooledSession(userId, plubotId);
    });
  }

  /**
   * Get or create user pool
   */
  getOrCreateUserPool(userId) {
    if (!this.pools.has(userId)) {
      this.pools.set(userId, new Map());
    }
    return this.pools.get(userId);
  }

  /**
   * Create a new pooled session
   */
  async createPooledSession(userId, plubotId) {
    const sessionId = `${userId}-${plubotId}`;
    logger.info(`🆕 Creating new pooled session ${sessionId}`);

    const session = {
      id: sessionId,
      userId,
      plubotId,
      status: 'pending',
      createdAt: Date.now(),
      lastActive: Date.now(),
      messagesProcessed: 0,
      errors: 0,
      uptime: 0,
      // Add toJSON method to prevent circular reference
      toJSON() {
        return {
          id: this.id,
          userId: this.userId,
          plubotId: this.plubotId,
          status: this.status,
          createdAt: this.createdAt,
          lastActive: this.lastActive,
          messagesProcessed: this.messagesProcessed,
          errors: this.errors,
          uptime: this.uptime
        };
      }
    };
    
    const userPool = this.getOrCreateUserPool(userId);
    userPool.set(plubotId, session);
    this.globalSessions.set(sessionId, session);
    
    logger.info(`🏊 Session ${sessionId} added to pool (User: ${userId}, Total: ${this.globalSessions.size})`);
    
    this.updateMetrics(sessionId, 'created');
    
    return session;
  }

  /**
   * Release a session back to the pool
   */
  releaseSession(sessionId) {
    const session = this.globalSessions.get(sessionId);
    if (session) {
      session.lastActive = Date.now();
      logger.info(`🔄 Session ${sessionId} released back to pool`);
      this.updateMetrics(sessionId, 'released');
    }
  }

  /**
   * Remove oldest session for a user
   */
  async removeOldestUserSession(userId) {
    const userPool = this.pools.get(userId);
    if (!userPool || userPool.size === 0) return;

    let oldest = null;
    let oldestTime = Date.now();

    for (const [plubotId, session] of userPool) {
      if (session.lastActive < oldestTime) {
        oldest = { plubotId, session };
        oldestTime = session.lastActive;
      }
    }

    if (oldest) {
      logger.info(`🗑️ Removing oldest session ${oldest.session.id}`);
      await this.removeSession(oldest.session.id);
    }
  }

  /**
   * Remove a session from the pool
   */
  async removeSession(sessionId) {
    const session = this.globalSessions.get(sessionId);
    if (!session) return;

    // Remove from user pool
    const userPool = this.pools.get(session.userId);
    if (userPool) {
      userPool.delete(session.plubotId);
      if (userPool.size === 0) {
        this.pools.delete(session.userId);
      }
    }

    // Remove from global pool
    this.globalSessions.delete(sessionId);
    this.sessionMetrics.delete(sessionId);
    
    logger.info(`✅ Session ${sessionId} removed from pool`);
  }

  /**
   * Get session statistics
   */
  getStatistics() {
    const stats = {
      totalSessions: this.globalSessions.size,
      totalUsers: this.pools.size,
      sessionsPerUser: {},
      sessionsByStatus: {},
      averageUptime: 0,
      totalMessagesProcessed: 0,
      circuitBreakerStatus: this.circuitBreaker.getStatus()
    };

    // Calculate per-user stats
    for (const [userId, pool] of this.pools) {
      stats.sessionsPerUser[userId] = pool.size;
    }

    // Calculate status distribution
    let totalUptime = 0;
    for (const session of this.globalSessions.values()) {
      stats.sessionsByStatus[session.status] = (stats.sessionsByStatus[session.status] || 0) + 1;
      
      const uptime = Date.now() - session.createdAt;
      totalUptime += uptime;
      
      if (session.metrics) {
        stats.totalMessagesProcessed += session.metrics.messagesProcessed || 0;
      }
    }

    if (this.globalSessions.size > 0) {
      stats.averageUptime = Math.floor(totalUptime / this.globalSessions.size / 1000); // in seconds
    }

    return stats;
  }

  /**
   * Update session metrics
   */
  updateMetrics(sessionId, action) {
    if (!this.sessionMetrics.has(sessionId)) {
      this.sessionMetrics.set(sessionId, {
        actions: [],
        created: Date.now()
      });
    }

    const metrics = this.sessionMetrics.get(sessionId);
    metrics.actions.push({
      action,
      timestamp: Date.now()
    });

    // Keep only last 100 actions
    if (metrics.actions.length > 100) {
      metrics.actions = metrics.actions.slice(-100);
    }
  }

  /**
   * Start metrics collection interval
   */
  startMetricsCollection() {
    setInterval(() => {
      const stats = this.getStatistics();
      logger.info('📊 Session Pool Statistics:', stats);
    }, 60000); // Every minute
  }

  /**
   * Start health check interval
   */
  startHealthCheck() {
    setInterval(async () => {
      try {
        // Clean up inactive sessions
        const now = Date.now();
        const inactiveThreshold = 3600000; // 1 hour

        for (const [sessionId, session] of this.globalSessions) {
          if (now - session.lastActive > inactiveThreshold && session.status !== 'ready') {
            logger.info(`🧹 Cleaning up inactive session ${sessionId}`);
            await this.removeSession(sessionId);
          }
        }

        // Check circuit breaker health
        if (!this.circuitBreaker.isHealthy()) {
          logger.warn('⚠️ Session Pool circuit breaker is not healthy');
        }
      } catch (error) {
        logger.error('Error in session pool health check:', error);
      }
    }, 300000); // Every 5 minutes
  }

  /**
   * Get pool health status
   */
  getHealthStatus() {
    const stats = this.getStatistics();
    const capacity = (this.globalSessions.size / this.globalMaxSessions) * 100;
    
    return {
      healthy: capacity < 80 && this.circuitBreaker.isHealthy(),
      capacity: `${capacity.toFixed(1)}%`,
      stats
    };
  }

  /**
   * Drain all sessions (for shutdown)
   */
  async drain() {
    logger.info('🚿 Draining session pool...');
    
    for (const sessionId of this.globalSessions.keys()) {
      await this.removeSession(sessionId);
    }
    
    this.pools.clear();
    this.sessionMetrics.clear();
    logger.info('✅ Session pool drained');
  }
}

// Export singleton instance
const enhancedSessionPool = new EnhancedSessionPool();
export default enhancedSessionPool;
