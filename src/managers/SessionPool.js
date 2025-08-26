const EventEmitter = require('events');
const logger = require('../utils/logger');

/**
 * SessionPool - Manages WhatsApp client connections efficiently
 * Implements connection pooling, automatic recovery, and load balancing
 */
class SessionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.maxPoolSize = options.maxPoolSize || 100;
    this.maxRetriesPerSession = options.maxRetries || 3;
    this.sessionTimeout = options.sessionTimeout || 30 * 60 * 1000; // 30 minutes
    this.healthCheckInterval = options.healthCheckInterval || 60 * 1000; // 1 minute
    
    // Session management
    this.sessions = new Map(); // sessionId -> session object
    this.sessionRetries = new Map(); // sessionId -> retry count
    this.sessionLastActivity = new Map(); // sessionId -> timestamp
    this.sessionMetrics = new Map(); // sessionId -> metrics
    
    // Connection pool
    this.availableClients = [];
    this.busyClients = new Set();
    
    // Start health monitoring
    this.startHealthMonitoring();
  }

  /**
   * Get or create a session with automatic recovery
   */
  async getSession(sessionId, createIfNotExists = true) {
    try {
      // Check if session exists and is healthy
      if (this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId);
        
        // Update last activity
        this.sessionLastActivity.set(sessionId, Date.now());
        
        // Check if session is healthy
        if (await this.isSessionHealthy(session)) {
          return session;
        }
        
        // Session unhealthy, try to recover
        logger.warn(`Session ${sessionId} unhealthy, attempting recovery`);
        await this.recoverSession(sessionId);
      }
      
      // Create new session if needed
      if (createIfNotExists) {
        return await this.createSession(sessionId);
      }
      
      return null;
    } catch (error) {
      logger.error(`Error getting session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Create a new session with proper error handling
   */
  async createSession(sessionId) {
    try {
      // Check pool capacity
      if (this.sessions.size >= this.maxPoolSize) {
        // Try to clean up inactive sessions
        await this.cleanupInactiveSessions();
        
        if (this.sessions.size >= this.maxPoolSize) {
          throw new Error('Session pool at maximum capacity');
        }
      }
      
      // Initialize session object
      const session = {
        id: sessionId,
        status: 'initializing',
        client: null,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        metrics: {
          messagesReceived: 0,
          messagesSent: 0,
          errors: 0,
          reconnections: 0
        }
      };
      
      // Store session
      this.sessions.set(sessionId, session);
      this.sessionRetries.set(sessionId, 0);
      this.sessionLastActivity.set(sessionId, Date.now());
      this.sessionMetrics.set(sessionId, session.metrics);
      
      // Emit session created event
      this.emit('sessionCreated', { sessionId, session });
      
      return session;
    } catch (error) {
      logger.error(`Error creating session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Recover a failed session with exponential backoff
   */
  async recoverSession(sessionId) {
    const retries = this.sessionRetries.get(sessionId) || 0;
    
    if (retries >= this.maxRetriesPerSession) {
      logger.error(`Max retries reached for session ${sessionId}, removing from pool`);
      await this.removeSession(sessionId);
      throw new Error(`Session ${sessionId} recovery failed after ${retries} attempts`);
    }
    
    try {
      logger.info(`Attempting to recover session ${sessionId} (attempt ${retries + 1})`);
      
      // Exponential backoff
      const backoffMs = Math.min(1000 * Math.pow(2, retries), 30000);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      
      // Get existing session
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      
      // Clean up old client if exists
      if (session.client) {
        try {
          await session.client.destroy();
        } catch (e) {
          logger.warn(`Error destroying old client for ${sessionId}:`, e);
        }
      }
      
      // Reset session state
      session.status = 'recovering';
      session.client = null;
      
      // Update retry count
      this.sessionRetries.set(sessionId, retries + 1);
      
      // Update metrics
      const metrics = this.sessionMetrics.get(sessionId);
      if (metrics) {
        metrics.reconnections++;
      }
      
      // Emit recovery event
      this.emit('sessionRecovering', { sessionId, attempt: retries + 1 });
      
      return session;
    } catch (error) {
      logger.error(`Error recovering session ${sessionId}:`, error);
      this.sessionRetries.set(sessionId, retries + 1);
      throw error;
    }
  }

  /**
   * Check if a session is healthy
   */
  async isSessionHealthy(session) {
    if (!session) return false;
    
    // Check basic session properties
    if (session.status === 'error' || session.status === 'disconnected') {
      return false;
    }
    
    // Check if client exists and is connected
    if (!session.client) {
      return session.status === 'initializing' || session.status === 'waiting_qr';
    }
    
    // Check client state
    try {
      const state = await session.client.getState();
      return state === 'CONNECTED';
    } catch (error) {
      logger.warn(`Health check failed for session ${session.id}:`, error);
      return false;
    }
  }

  /**
   * Remove a session from the pool
   */
  async removeSession(sessionId) {
    try {
      const session = this.sessions.get(sessionId);
      
      if (session) {
        // Clean up client
        if (session.client) {
          try {
            await session.client.destroy();
          } catch (e) {
            logger.warn(`Error destroying client for ${sessionId}:`, e);
          }
        }
        
        // Remove from all maps
        this.sessions.delete(sessionId);
        this.sessionRetries.delete(sessionId);
        this.sessionLastActivity.delete(sessionId);
        this.sessionMetrics.delete(sessionId);
        
        // Emit session removed event
        this.emit('sessionRemoved', { sessionId });
        
        logger.info(`Session ${sessionId} removed from pool`);
      }
    } catch (error) {
      logger.error(`Error removing session ${sessionId}:`, error);
    }
  }

  /**
   * Clean up inactive sessions
   */
  async cleanupInactiveSessions() {
    const now = Date.now();
    const sessionsToRemove = [];
    
    for (const [sessionId, lastActivity] of this.sessionLastActivity.entries()) {
      if (now - lastActivity > this.sessionTimeout) {
        sessionsToRemove.push(sessionId);
      }
    }
    
    for (const sessionId of sessionsToRemove) {
      logger.info(`Removing inactive session ${sessionId}`);
      await this.removeSession(sessionId);
    }
    
    return sessionsToRemove.length;
  }

  /**
   * Start health monitoring for all sessions
   */
  startHealthMonitoring() {
    this.healthCheckTimer = setInterval(async () => {
      try {
        // Check all sessions
        for (const [sessionId, session] of this.sessions.entries()) {
          const isHealthy = await this.isSessionHealthy(session);
          
          if (!isHealthy && session.status !== 'initializing' && session.status !== 'waiting_qr') {
            logger.warn(`Session ${sessionId} unhealthy, marking for recovery`);
            session.status = 'unhealthy';
            
            // Emit unhealthy event
            this.emit('sessionUnhealthy', { sessionId });
          }
        }
        
        // Clean up inactive sessions
        const removed = await this.cleanupInactiveSessions();
        if (removed > 0) {
          logger.info(`Cleaned up ${removed} inactive sessions`);
        }
      } catch (error) {
        logger.error('Error in health monitoring:', error);
      }
    }, this.healthCheckInterval);
  }

  /**
   * Stop health monitoring
   */
  stopHealthMonitoring() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Get session statistics
   */
  getStatistics() {
    const stats = {
      totalSessions: this.sessions.size,
      activeSessions: 0,
      waitingQR: 0,
      connected: 0,
      unhealthy: 0,
      poolUtilization: (this.sessions.size / this.maxPoolSize) * 100,
      metrics: {
        totalMessages: 0,
        totalErrors: 0,
        totalReconnections: 0
      }
    };
    
    for (const session of this.sessions.values()) {
      switch (session.status) {
        case 'connected':
        case 'ready':
          stats.connected++;
          stats.activeSessions++;
          break;
        case 'waiting_qr':
          stats.waitingQR++;
          break;
        case 'unhealthy':
        case 'error':
          stats.unhealthy++;
          break;
        default:
          if (session.client) {
            stats.activeSessions++;
          }
      }
    }
    
    // Aggregate metrics
    for (const metrics of this.sessionMetrics.values()) {
      stats.metrics.totalMessages += metrics.messagesReceived + metrics.messagesSent;
      stats.metrics.totalErrors += metrics.errors;
      stats.metrics.totalReconnections += metrics.reconnections;
    }
    
    return stats;
  }

  /**
   * Gracefully shutdown the pool
   */
  async shutdown() {
    logger.info('Shutting down session pool...');
    
    // Stop health monitoring
    this.stopHealthMonitoring();
    
    // Remove all sessions
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.removeSession(sessionId);
    }
    
    logger.info('Session pool shutdown complete');
  }
}

module.exports = SessionPool;
