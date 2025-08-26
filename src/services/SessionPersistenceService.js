import fs from 'node:fs/promises';
import path from 'node:path';

import redis from '../config/redis.js';
import logger from '../utils/EnhancedLogger.js';

import encryptionService from './EncryptionService.js';

/**
 * Service for handling WhatsApp session persistence
 * Ensures sessions survive server restarts and page reloads
 */
class SessionPersistenceService {
  constructor(manager) {
    this.manager = manager;
    this.redis = redis;
    this.sessionTTL = 86_400; // 24 hours in seconds
  }

  /**
   * Save session state to Redis for persistence
   */
  async persistSession(sessionId, sessionData) {
    try {
      const key = `session:${sessionId}`;
      const data = {
        id: sessionId,
        status: sessionData.status,
        phoneNumber: sessionData.phoneNumber || null,
        isReady: sessionData.isReady,
        lastActive: Date.now(),
        createdAt: sessionData.createdAt || new Date().toISOString(),
      };

      // Encrypt sensitive session data
      const encryptedData = encryptionService.encryptSessionData(data);

      await this.redis.setex(key, this.sessionTTL, encryptedData);
      logger.info(`Session ${sessionId} saved to Redis`, {
        sessionId,
        ttl: this.sessionTTL,
        category: 'session-persistence',
      });

      return true;
    } catch (error) {
      logger.error(`Failed to save session ${sessionId}`, error, {
        sessionId,
        category: 'session-persistence',
      });
      return false;
    }
  }

  /**
   * Retrieve persisted session from Redis
   */
  async getPersistedSession(sessionId) {
    try {
      const key = `session:${sessionId}`;
      const encryptedData = await this.redis.get(key);

      if (!encryptedData) {
        return null;
      }

      // Decrypt session data
      const session = encryptionService.decryptSessionData(encryptedData);

      // Check if session is expired (24 hours)
      if (Date.now() - session.lastActive > this.sessionTTL * 1000) {
        logger.info(`Session ${sessionId} expired, removing from Redis`, {
          sessionId,
          expiredAt: Date.now(),
          category: 'session-persistence',
        });
        await this.redis.del(key);
        return null;
      }

      return session;
    } catch (error) {
      logger.error(`Failed to retrieve session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Check if a session exists on disk (LocalAuth)
   */
  async checkDiskSession(sessionId) {
    try {
      const sessionPath = path.join(process.cwd(), 'sessions', `session-${sessionId}`);

      await fs.access(sessionPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Validate and restore a session
   */
  async validateAndRestoreSession(sessionId) {
    try {
      // Check Redis first
      const persistedData = await this.getPersistedSession(sessionId);

      if (!persistedData) {
        logger.info(`No persisted data found for session ${sessionId}`);
        return null;
      }

      // Check if session files exist on disk
      const diskExists = await this.checkDiskSession(sessionId);

      if (!diskExists) {
        logger.info(`Session ${sessionId} files not found on disk`);
        await this.redis.del(`session:${sessionId}`);
        return null;
      }

      // Try to restore the session
      logger.info(`Attempting to restore session ${sessionId}`);
      const restoredSession = await this.manager.sessionManager.restoreSession(sessionId);

      if (restoredSession) {
        // Update last active time
        await this.persistSession(sessionId, restoredSession);
        return restoredSession;
      }

      return null;
    } catch (error) {
      logger.error(`Failed to validate/restore session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Clean up expired sessions
   */
  async cleanupExpiredSessions() {
    try {
      const keys = await this.redis.keys('session:*');
      let cleaned = 0;

      for (const key of keys) {
        const ttl = await this.redis.ttl(key);
        if (ttl === -1) {
          // No expiration set, set default TTL
          await this.redis.expire(key, this.sessionTTL);
        } else if (ttl === -2) {
          // Key doesn't exist (race condition), skip
          continue;
        }

        // Check if session data is corrupted
        const data = await this.redis.get(key);
        if (!data || data === 'undefined' || data === 'null') {
          await this.redis.del(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        logger.info(`Cleaned up ${cleaned} corrupted/expired sessions`);
      }

      return cleaned;
    } catch (error) {
      logger.error('Failed to cleanup sessions:', error);
      throw error;
    }
  }

  async restoreAllSessions() {
    try {
      logger.info('Restoring all sessions from Redis...');
      const keys = await this.redis.keys('session:*');
      let restored = 0;

      for (const key of keys) {
        const sessionId = key.replace('session:', '');
        const sessionData = await this.getSession(sessionId);

        if (sessionData && sessionData.status === 'authenticated') {
          try {
            // Attempt to restore the session
            await this.manager.createSession(sessionData.userId, sessionData.plubotId, {
              restore: true,
            });
            restored++;
            logger.info(`Restored session: ${sessionId}`);
          } catch (error) {
            logger.error(`Failed to restore session ${sessionId}:`, error);
          }
        }
      }

      logger.info(`Session restoration complete. Restored ${restored} sessions`);
      return restored;
    } catch (error) {
      logger.error('Failed to restore sessions:', error);
      return 0;
    }
  }

  /**
   * Initialize cleanup interval
   */
  startCleanupInterval() {
    // Run cleanup every hour
    setInterval(() => {
      this.cleanupExpiredSessions();
    }, 3_600_000); // 1 hour

    // Run initial cleanup
    this.cleanupExpiredSessions();
  }
}

export default SessionPersistenceService;
