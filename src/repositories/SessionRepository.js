/**
 * Session Repository
 * Enterprise-grade repository pattern for session management
 * Handles all session persistence and retrieval operations
 */

import logger from '../utils/logger.js';
import { SessionDTO } from '../dto/SessionDTO.js';

export class SessionRepository {
  constructor(redisClient, sessionManager) {
    this.redis = redisClient;
    this.sessionManager = sessionManager;
    this.sessions = new Map(); // In-memory cache
    this.sessionPrefix = 'session:';
    this.qrPrefix = 'qr:';
    this.metricsPrefix = 'metrics:';
  }

  /**
   * Create a new session with clean separation of concerns
   */
  async create(userId, plubotId) {
    const sessionId = `${userId}-${plubotId}`;
    
    try {
      // Check if session already exists
      const existing = await this.findById(sessionId);
      if (existing && existing.status !== 'error') {
        logger.warn(`Session ${sessionId} already exists with status: ${existing.status}`);
        return existing;
      }

      // Create session entity (domain object)
      const sessionEntity = await this.sessionManager.createSession(sessionId);
      
      // Store in cache (without client reference)
      const cleanSession = this.extractCleanSession(sessionEntity);
      this.sessions.set(sessionId, cleanSession);
      
      // Persist to Redis
      await this.saveToRedis(sessionId, cleanSession);
      
      // Return DTO
      return SessionDTO.fromSession(cleanSession);
      
    } catch (error) {
      logger.error(`Failed to create session ${sessionId}:`, error.message);
      throw new Error(`Session creation failed: ${error.message}`);
    }
  }

  /**
   * Extract clean, serializable session data
   */
  extractCleanSession(sessionEntity) {
    // Never include the client object in the clean session
    const { client, ...cleanData } = sessionEntity;
    
    return {
      sessionId: cleanData.sessionId,
      userId: cleanData.userId || cleanData.sessionId?.split('-')[0],
      plubotId: cleanData.plubotId || cleanData.sessionId?.split('-')[1],
      status: cleanData.status || 'initializing',
      isReady: cleanData.isReady || false,
      isAuthenticated: cleanData.isAuthenticated || false,
      createdAt: cleanData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastActivity: cleanData.lastActivity || null,
      qr: cleanData.qr || null,
      qrDataUrl: cleanData.qrDataUrl || null,
      connectionState: cleanData.connectionState || 'disconnected',
      error: cleanData.error || null,
      messagesReceived: cleanData.messagesReceived || 0,
      messagesSent: cleanData.messagesSent || 0,
      reconnections: cleanData.reconnections || 0,
      uptime: cleanData.uptime || 0
    };
  }

  /**
   * Find session by ID
   */
  async findById(sessionId) {
    // Check cache first
    if (this.sessions.has(sessionId)) {
      return SessionDTO.fromSession(this.sessions.get(sessionId));
    }

    // Check Redis
    return await this.getFromRedis(sessionId);
  }

  async getFromRedis(sessionId) {
    try {
      const key = `session:${sessionId}`;
      const data = await this.redis.get(key);
      if (data) {
        // Refresh TTL on access
        await this.redis.expire(key, 86400);
        
        // Update last accessed time
        const metaKey = `session_meta:${sessionId}`;
        await this.redis.hSet(metaKey, 'lastAccessed', new Date().toISOString());
        
        logger.debug(`Session ${sessionId} retrieved from Redis`);
        return JSON.parse(data);
      }
      return null;
    } catch (error) {
      logger.error(`Failed to get session ${sessionId} from Redis:`, error);
      return null;
    }
  }

  /**
   * Update session
   */
  async update(sessionId, updates) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Apply updates
    const updatedSession = {
      ...session,
      ...updates,
      updatedAt: new Date().toISOString(),
      client: undefined // Never include client in stored data
    };

    // Update cache
    this.sessions.set(sessionId, updatedSession);

    // Persist to Redis
    await this.saveToRedis(sessionId, updatedSession);

    return SessionDTO.fromSession(updatedSession);
  }

  async saveToRedis(sessionId, data) {
    try {
      const key = `session:${sessionId}`;
      // Use setEx for atomic TTL setting
      await this.redis.setEx(key, 86400, JSON.stringify(data)); // 24 hours TTL
      
      // Track active sessions
      await this.redis.sAdd('active_sessions', sessionId);
      
      // Store session metadata for quick lookups
      const metaKey = `session_meta:${sessionId}`;
      await this.redis.hSet(metaKey, {
        userId: data.userId || '',
        plubotId: data.plubotId || '',
        status: data.status || 'initializing',
        createdAt: new Date().toISOString()
      });
      await this.redis.expire(metaKey, 86400);
      
      logger.debug(`Session ${sessionId} saved to Redis with TTL`);
    } catch (error) {
      logger.error(`Failed to save session ${sessionId} to Redis:`, error);
    }
  }

  /**
   * Delete session
   */
  async delete(sessionId) {
    try {
      // Remove from cache
      this.sessions.delete(sessionId);

      // Remove from Redis
      await this.redis.del(`${this.sessionPrefix}${sessionId}`);
      await this.redis.del(`${this.qrPrefix}${sessionId}`);
      await this.redis.del(`${this.metricsPrefix}${sessionId}`);

      // Destroy WhatsApp client
      if (this.sessionManager.clients.has(sessionId)) {
        await this.sessionManager.destroySession(sessionId);
      }

      return true;
    } catch (error) {
      logger.error(`Failed to delete session ${sessionId}:`, error.message);
      return false;
    }
  }

  /**
   * Find all sessions
   */
  async findAll(filter = {}) {
    const sessions = [];

    // Get all sessions from Redis
    try {
      const keys = await this.redis.keys(`${this.sessionPrefix}*`);
      
      for (const key of keys) {
        const data = await this.redis.get(key);
        if (data) {
          const session = JSON.parse(data);
          
          // Apply filters
          if (this.matchesFilter(session, filter)) {
            sessions.push(session);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to retrieve sessions from Redis:', error.message);
    }

    return SessionDTO.fromSessionList(sessions);
  }

  /**
   * Find sessions by user
   */
  async findByUser(userId) {
    return this.findAll({ userId });
  }

  /**
   * Find sessions by status
   */
  async findByStatus(status) {
    return this.findAll({ status });
  }

  /**
   * Update session QR code
   */
  async updateQR(sessionId, qr, qrDataUrl) {
    const session = await this.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Update session
    const updated = await this.update(sessionId, {
      qr,
      qrDataUrl,
      status: 'waiting_qr'
    });

    // Store QR in Redis with TTL
    await this.redis.setEx(
      `${this.qrPrefix}${sessionId}`,
      120, // 2 minutes TTL
      JSON.stringify({ qr, qrDataUrl, timestamp: new Date().toISOString() })
    );

    return updated;
  }

  /**
   * Update session metrics
   */
  async updateMetrics(sessionId, metrics) {
    const session = await this.findById(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Merge metrics
    const updatedMetrics = {
      messagesReceived: metrics.messagesReceived || session.messagesReceived || 0,
      messagesSent: metrics.messagesSent || session.messagesSent || 0,
      reconnections: metrics.reconnections || session.reconnections || 0,
      uptime: metrics.uptime || session.uptime || 0,
      lastError: metrics.lastError || session.lastError || null
    };

    // Update session
    const updated = await this.update(sessionId, updatedMetrics);

    // Store metrics in Redis
    await this.redis.set(
      `${this.metricsPrefix}${sessionId}`,
      JSON.stringify({
        ...updatedMetrics,
        timestamp: new Date().toISOString()
      })
    );

    return updated;
  }

  /**
   * Check if session matches filter
   */
  matchesFilter(session, filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (session[key] !== value) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get session statistics
   */
  async getStatistics() {
    const sessions = await this.findAll();
    
    const stats = {
      total: sessions.length,
      byStatus: {},
      byUser: {},
      authenticated: 0,
      ready: 0,
      error: 0
    };

    for (const session of sessions) {
      // Count by status
      stats.byStatus[session.status] = (stats.byStatus[session.status] || 0) + 1;
      
      // Count by user
      stats.byUser[session.userId] = (stats.byUser[session.userId] || 0) + 1;
      
      // Count special states
      if (session.isAuthenticated) stats.authenticated++;
      if (session.isReady) stats.ready++;
      if (session.status === 'error') stats.error++;
    }

    return stats;
  }

  /**
   * Clean up stale sessions
   */
  async cleanupStaleSessions(maxAge = 86400000) { // 24 hours
    const now = Date.now();
    const sessions = await this.findAll();
    const cleaned = [];

    for (const session of sessions) {
      const sessionAge = now - new Date(session.updatedAt || session.createdAt).getTime();
      
      if (sessionAge > maxAge && session.status !== 'ready') {
        await this.delete(session.sessionId);
        cleaned.push(session.sessionId);
      }
    }

    if (cleaned.length > 0) {
      logger.info(`Cleaned up ${cleaned.length} stale sessions:`, cleaned);
    }

    return cleaned;
  }
}

export default SessionRepository;
