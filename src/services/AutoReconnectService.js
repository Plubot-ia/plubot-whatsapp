import logger from '../utils/logger.js';

/**
 * Service for handling automatic reconnection of WhatsApp sessions
 * Implements exponential backoff and smart retry logic
 */
class AutoReconnectService {
  constructor(manager) {
    this.manager = manager;
    this.reconnectAttempts = new Map();
    this.maxAttempts = 5;
    this.baseDelay = 1000; // 1 second
    this.maxDelay = 30_000; // 30 seconds
    this.reconnectTimers = new Map();
  }

  /**
   * Handle disconnection event for a session
   */
  async handleDisconnection(sessionId, reason) {
    logger.info(`📱 Session ${sessionId} disconnected: ${reason}`);

    // Don't reconnect if it was a manual logout
    if (reason === 'LOGOUT' || reason === 'MANUAL') {
      logger.info(`Session ${sessionId} was manually disconnected, skipping reconnection`);
      this.cleanup(sessionId);
      return;
    }

    const attempts = this.reconnectAttempts.get(sessionId) || 0;

    if (attempts >= this.maxAttempts) {
      logger.error(`❌ Max reconnection attempts reached for ${sessionId}`);
      await this.notifyDisconnectionFailure(sessionId);
      this.cleanup(sessionId);
      return;
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(this.baseDelay * Math.pow(2, attempts), this.maxDelay);
    logger.info(
      `⏱️ Scheduling reconnection for ${sessionId} in ${delay}ms (attempt ${attempts + 1}/${this.maxAttempts})`,
    );

    // Clear any existing timer
    if (this.reconnectTimers.has(sessionId)) {
      clearTimeout(this.reconnectTimers.get(sessionId));
    }

    // Schedule reconnection
    const timer = setTimeout(async () => {
      try {
        await this.attemptReconnection(sessionId, attempts + 1);
      } catch (error) {
        logger.error(`Failed to reconnect ${sessionId}:`, error);
        this.reconnectAttempts.set(sessionId, attempts + 1);
        // Recursive call for next attempt
        await this.handleDisconnection(sessionId, 'RECONNECT_FAILED');
      }
    }, delay);

    this.reconnectTimers.set(sessionId, timer);
  }

  /**
   * Attempt to reconnect a session
   */
  async attemptReconnection(sessionId, attemptNumber) {
    logger.info(`🔄 Attempting reconnection ${attemptNumber}/${this.maxAttempts} for ${sessionId}`);

    const session = this.manager.getSession(sessionId);

    if (!session) {
      // Try to restore from persistence
      const restoredSession = await this.manager.restoreSession(sessionId);

      if (!restoredSession) {
        throw new Error(`Session ${sessionId} not found and could not be restored`);
      }

      logger.info(`✅ Session ${sessionId} restored from persistence`);
      this.cleanup(sessionId);
      await this.notifyReconnectionSuccess(sessionId);
      return restoredSession;
    }

    // Session exists but needs reconnection
    if (session.client) {
      try {
        // Destroy old client
        if (session.client.pupBrowser) {
          await session.client.destroy();
        }
      } catch (error) {
        logger.warn(`Error destroying old client for ${sessionId}:`, error);
      }

      // Create new client and reinitialize
      const newSession = await this.manager.sessionManager.initializeNewSession(sessionId, session);

      if (newSession && newSession.status === 'ready') {
        logger.info(`✅ Successfully reconnected ${sessionId}`);
        this.cleanup(sessionId);
        await this.notifyReconnectionSuccess(sessionId);
        return newSession;
      }
    }

    throw new Error(`Failed to reconnect session ${sessionId}`);
  }

  /**
   * Notify frontend about reconnection success
   */
  async notifyReconnectionSuccess(sessionId) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('session-reconnected', {
        sessionId,
        status: 'connected',
        message: 'Session reconnected successfully',
      });
    }

    // Update Redis
    if (this.manager.redis) {
      await this.manager.persistenceService.persistSession(sessionId, {
        status: 'ready',
        isReady: true,
        lastActive: Date.now(),
      });
    }
  }

  /**
   * Notify frontend about disconnection failure
   */
  async notifyDisconnectionFailure(sessionId) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('session-disconnection-failed', {
        sessionId,
        status: 'disconnected',
        message: 'Could not reconnect after multiple attempts. Please scan QR code again.',
      });
    }

    // Clean up session
    await this.manager.destroySession(sessionId);
  }

  /**
   * Clean up reconnection state
   */
  cleanup(sessionId) {
    this.reconnectAttempts.delete(sessionId);

    if (this.reconnectTimers.has(sessionId)) {
      clearTimeout(this.reconnectTimers.get(sessionId));
      this.reconnectTimers.delete(sessionId);
    }
  }

  /**
   * Cancel reconnection attempts for a session
   */
  cancelReconnection(sessionId) {
    logger.info(`Cancelling reconnection attempts for ${sessionId}`);
    this.cleanup(sessionId);
  }

  /**
   * Get reconnection status for a session
   */
  getStatus(sessionId) {
    return {
      attempts: this.reconnectAttempts.get(sessionId) || 0,
      maxAttempts: this.maxAttempts,
      isReconnecting: this.reconnectTimers.has(sessionId),
    };
  }
}

export default AutoReconnectService;
