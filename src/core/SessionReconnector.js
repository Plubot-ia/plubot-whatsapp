import EventEmitter from 'node:events';

import logger from '../utils/logger.js';

/**
 * Automatic Session Reconnection Manager
 * Handles WhatsApp session reconnections with exponential backoff
 */
export class SessionReconnector extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      maxRetries: config.maxRetries || 10,
      initialDelay: config.initialDelay || 1000,
      maxDelay: config.maxDelay || 60_000,
      backoffMultiplier: config.backoffMultiplier || 2,
      jitterRange: config.jitterRange || 0.3,
      reconnectTimeout: config.reconnectTimeout || 300_000, // 5 minutes
      ...config,
    };

    this.reconnectAttempts = new Map();
    this.reconnectTimers = new Map();
    this.sessionStates = new Map();
  }

  /**
   * Register session for auto-reconnection
   */
  registerSession(sessionId, reconnectCallback) {
    this.reconnectAttempts.set(sessionId, 0);
    this.sessionStates.set(sessionId, {
      callback: reconnectCallback,
      lastConnected: Date.now(),
      status: 'connected',
    });

    logger.info(`Session ${sessionId} registered for auto-reconnection`);
  }

  /**
   * Handle disconnection event
   */
  async handleDisconnection(sessionId, reason = 'unknown') {
    const state = this.sessionStates.get(sessionId);

    if (!state) {
      logger.warn(`Session ${sessionId} not registered for reconnection`);
      return;
    }

    state.status = 'disconnected';
    state.disconnectedAt = Date.now();
    state.disconnectReason = reason;

    logger.warn(`Session ${sessionId} disconnected: ${reason}`);
    this.emit('session:disconnected', { sessionId, reason });

    // Start reconnection process
    await this._attemptReconnection(sessionId);
  }

  /**
   * Attempt to reconnect session
   */
  async _attemptReconnection(sessionId) {
    const attempts = this.reconnectAttempts.get(sessionId) || 0;
    const state = this.sessionStates.get(sessionId);

    if (!state) {
      return;
    }

    if (attempts >= this.config.maxRetries) {
      logger.error(`Session ${sessionId} exceeded max reconnection attempts`);
      this.emit('session:reconnection-failed', { sessionId, attempts });
      state.status = 'failed';
      return;
    }

    // Calculate delay with exponential backoff and jitter
    const delay = this._calculateDelay(attempts);

    logger.info(
      `Scheduling reconnection for session ${sessionId} in ${delay}ms (attempt ${attempts + 1}/${this.config.maxRetries})`
    );

    // Clear existing timer
    if (this.reconnectTimers.has(sessionId)) {
      clearTimeout(this.reconnectTimers.get(sessionId));
    }

    // Schedule reconnection
    const timer = setTimeout(async () => {
      try {
        state.status = 'reconnecting';
        this.emit('session:reconnecting', { sessionId, attempt: attempts + 1 });

        // Execute reconnection callback
        const success = await state.callback();

        if (success) {
          // Reset attempts on successful reconnection
          this.reconnectAttempts.set(sessionId, 0);
          state.status = 'connected';
          state.lastConnected = Date.now();
          state.reconnectTime = Date.now() - state.disconnectedAt;

          logger.info(`Session ${sessionId} reconnected successfully`);
          this.emit('session:reconnected', {
            sessionId,
            attempts: attempts + 1,
            reconnectTime: state.reconnectTime,
          });
        } else {
          throw new Error('Reconnection callback returned false');
        }

      } catch (error) {
        logger.error(`Failed to reconnect session ${sessionId}:`, error);

        // Increment attempts and retry
        this.reconnectAttempts.set(sessionId, attempts + 1);

        // Continue trying
        await this._attemptReconnection(sessionId);
      }
    }, delay);

    this.reconnectTimers.set(sessionId, timer);
  }

  /**
   * Calculate reconnection delay with exponential backoff and jitter
   */
  _calculateDelay(attempts) {
    // Exponential backoff
    let delay = Math.min(
      this.config.initialDelay * Math.pow(this.config.backoffMultiplier, attempts),
      this.config.maxDelay,
    );

    // Add jitter to prevent thundering herd
    const jitter = delay * this.config.jitterRange * (Math.random() - 0.5);
    delay = Math.round(delay + jitter);

    return Math.max(delay, this.config.initialDelay);
  }

  /**
   * Manually trigger reconnection
   */
  async reconnectSession(sessionId) {
    const state = this.sessionStates.get(sessionId);

    if (!state) {
      throw new Error(`Session ${sessionId} not registered`);
    }

    if (state.status === 'connected') {
      logger.info(`Session ${sessionId} already connected`);
      return true;
    }

    // Reset attempts for manual reconnection
    this.reconnectAttempts.set(sessionId, 0);

    try {
      state.status = 'reconnecting';
      const success = await state.callback();

      if (success) {
        state.status = 'connected';
        state.lastConnected = Date.now();
        return true;
      }

      return false;

    } catch (error) {
      logger.error(`Manual reconnection failed for session ${sessionId}:`, error);
      return false;
    }
  }

  /**
   * Cancel reconnection attempts
   */
  cancelReconnection(sessionId) {
    const timer = this.reconnectTimers.get(sessionId);

    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sessionId);
    }

    const state = this.sessionStates.get(sessionId);
    if (state) {
      state.status = 'cancelled';
    }

    logger.info(`Reconnection cancelled for session ${sessionId}`);
  }

  /**
   * Unregister session
   */
  unregisterSession(sessionId) {
    this.cancelReconnection(sessionId);
    this.reconnectAttempts.delete(sessionId);
    this.sessionStates.delete(sessionId);

    logger.info(`Session ${sessionId} unregistered from auto-reconnection`);
  }

  /**
   * Get session status
   */
  getSessionStatus(sessionId) {
    const state = this.sessionStates.get(sessionId);

    if (!state) {
      return null;
    }

    return {
      status: state.status,
      attempts: this.reconnectAttempts.get(sessionId) || 0,
      lastConnected: state.lastConnected,
      disconnectedAt: state.disconnectedAt,
      disconnectReason: state.disconnectReason,
      reconnectTime: state.reconnectTime,
    };
  }

  /**
   * Get all sessions status
   */
  getAllSessionsStatus() {
    const statuses = {};

    for (const [sessionId] of this.sessionStates) {
      statuses[sessionId] = this.getSessionStatus(sessionId);
    }

    return statuses;
  }

  /**
   * Get reconnection statistics
   */
  getStatistics() {
    const stats = {
      totalSessions: this.sessionStates.size,
      connected: 0,
      disconnected: 0,
      reconnecting: 0,
      failed: 0,
      averageReconnectTime: 0,
      totalReconnectTime: 0,
    };

    const reconnectTimes = [];

    for (const [, state] of this.sessionStates) {
      stats[state.status]++;

      if (state.reconnectTime) {
        reconnectTimes.push(state.reconnectTime);
        stats.totalReconnectTime += state.reconnectTime;
      }
    }

    if (reconnectTimes.length > 0) {
      stats.averageReconnectTime = stats.totalReconnectTime / reconnectTimes.length;
    }

    return stats;
  }

  /**
   * Cleanup and shutdown
   */
  shutdown() {
    // Cancel all reconnection timers
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }

    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    this.sessionStates.clear();

    logger.info('SessionReconnector shutdown complete');
  }
}

export default SessionReconnector;
