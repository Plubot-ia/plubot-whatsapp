import qrcode from 'qrcode';
import logger from '../utils/logger.js';
import { circuitBreakerManager } from '../patterns/CircuitBreaker.js';

/**
 * Enhanced WhatsApp event handlers with robust error handling
 */
class EnhancedWhatsAppHandlers {
  constructor(manager) {
    this.manager = manager;
    this.eventMetrics = new Map();
    this.circuitBreaker = circuitBreakerManager.getBreaker('EventHandlers', {
      failureThreshold: 10,
      resetTimeout: 30000
    });
  }

  /**
   * Setup all handlers for a client
   */
  setupHandlers(client, sessionId, session) {
    logger.info(`🎯 Setting up enhanced handlers for session ${sessionId}`);
    
    // QR Code handling
    this.setupQRHandler(client, sessionId, session);
    
    // Authentication handlers
    this.setupAuthHandlers(client, sessionId, session);
    
    // Connection handlers
    this.setupConnectionHandlers(client, sessionId, session);
    
    // Message handlers
    this.setupMessageHandlers(client, sessionId, session);
    
    // Error handlers
    this.setupErrorHandlers(client, sessionId, session);
    
    // State change handlers
    this.setupStateHandlers(client, sessionId, session);
  }

  /**
   * Setup QR code handler with retry logic
   */
  setupQRHandler(client, sessionId, session) {
    let qrCount = 0;
    const maxQRAttempts = 5;
    
    client.on('qr', async (qr) => {
      qrCount++;
      this.trackEvent(sessionId, 'qr_generated');
      
      logger.info(`📱 QR Code generated for session ${sessionId} (attempt ${qrCount}/${maxQRAttempts})`);
      
      try {
        await this.circuitBreaker.execute(async () => {
          // Update session status
          session.status = 'waiting_qr';
          session.qrCount = qrCount;
          
          // Generate QR data URL
          const qrDataUrl = await qrcode.toDataURL(qr);
          session.qrDataUrl = qrDataUrl;
          
          // Store in Redis with TTL
          if (this.manager.redis) {
            const qrData = JSON.stringify({
              qrData: qr,
              qrDataUrl,
              attempt: qrCount,
              timestamp: Date.now()
            });
            await this.manager.redis.setex(`qr:${sessionId}`, 120, qrData);
          }
          
          // Emit to WebSocket
          this.emitQRUpdate(sessionId, qr, qrDataUrl, qrCount);
          
          // Check if too many attempts
          if (qrCount >= maxQRAttempts) {
            logger.warn(`⚠️ Max QR attempts reached for session ${sessionId}`);
            this.emitQRLimitReached(sessionId);
          }
        });
      } catch (error) {
        logger.error(`Failed to handle QR for session ${sessionId}:`, error);
        this.trackEvent(sessionId, 'qr_error');
      }
    });
  }

  /**
   * Setup authentication handlers
   */
  setupAuthHandlers(client, sessionId, session) {
    // Successful authentication
    client.on('authenticated', async () => {
      this.trackEvent(sessionId, 'authenticated');
      logger.info(`✅ Session ${sessionId} authenticated successfully`);
      
      session.status = 'authenticated';
      session.isAuthenticated = true;
      session.authenticatedAt = Date.now();
      
      // Persist authentication
      if (this.manager.persistenceService) {
        await this.manager.persistenceService.persistSession(sessionId, {
          status: 'authenticated',
          isAuthenticated: true,
          authenticatedAt: session.authenticatedAt
        });
      }
      
      // Emit authentication success
      this.emitAuthenticationSuccess(sessionId);
      
      // Clear QR from Redis
      if (this.manager.redis) {
        await this.manager.redis.del(`qr:${sessionId}`);
      }
    });
    
    // Authentication failure
    client.on('auth_failure', async (message) => {
      this.trackEvent(sessionId, 'auth_failure');
      logger.error(`❌ Authentication failed for session ${sessionId}:`, message);
      
      session.status = 'auth_failed';
      session.error = message;
      
      // Emit failure event
      this.emitAuthenticationFailure(sessionId, message);
      
      // Schedule session cleanup
      setTimeout(() => {
        this.manager.destroySession(sessionId);
      }, 5000);
    });
  }

  /**
   * Setup connection handlers
   */
  setupConnectionHandlers(client, sessionId, session) {
    // Ready event
    client.on('ready', async () => {
      this.trackEvent(sessionId, 'ready');
      logger.info(`🚀 WhatsApp client ready for session ${sessionId}`);
      
      session.status = 'ready';
      session.isReady = true;
      session.readyAt = Date.now();
      
      // Update session pool
      if (this.manager.sessionPool) {
        this.manager.sessionPool.releaseSession(sessionId);
      }
      
      // Persist ready state
      if (this.manager.persistenceService) {
        await this.manager.persistenceService.persistSession(sessionId, {
          status: 'ready',
          isReady: true,
          readyAt: session.readyAt
        });
      }
      
      // Emit ready event
      this.emitSessionReady(sessionId);
    });
    
    // Disconnection event
    client.on('disconnected', async (reason) => {
      this.trackEvent(sessionId, 'disconnected');
      logger.warn(`📵 Session ${sessionId} disconnected: ${reason}`);
      
      session.status = 'disconnected';
      session.disconnectedAt = Date.now();
      session.disconnectReason = reason;
      
      // Handle reconnection
      if (this.manager.reconnectService) {
        await this.manager.reconnectService.handleDisconnection(sessionId, reason);
      }
      
      // Emit disconnection event
      this.emitSessionDisconnected(sessionId, reason);
    });
    
    // Connection change
    client.on('change_state', (state) => {
      this.trackEvent(sessionId, `state_${state}`);
      logger.info(`🔄 Session ${sessionId} state changed to: ${state}`);
      
      session.connectionState = state;
      
      // Emit state change
      this.emitStateChange(sessionId, state);
    });
  }

  /**
   * Setup message handlers
   */
  setupMessageHandlers(client, sessionId, session) {
    client.on('message', async (message) => {
      this.trackEvent(sessionId, 'message_received');
      
      try {
        await this.circuitBreaker.execute(async () => {
          logger.info(`📨 Message received for session ${sessionId}: ${message.body}`);
          
          // Update session metrics
          if (!session.metrics) session.metrics = {};
          session.metrics.messagesReceived = (session.metrics.messagesReceived || 0) + 1;
          session.lastMessageAt = Date.now();
          
          // Process message through flow executor if available
          if (this.manager.flowExecutor) {
            await this.manager.flowExecutor.processMessage(sessionId, message);
          }
          
          // Emit message event
          this.emitMessageReceived(sessionId, message);
        });
      } catch (error) {
        logger.error(`Failed to handle message for session ${sessionId}:`, error);
        this.trackEvent(sessionId, 'message_error');
      }
    });
    
    client.on('message_ack', (msg, ack) => {
      this.trackEvent(sessionId, 'message_ack');
      logger.debug(`Message ${msg.id._serialized} acknowledged with status ${ack}`);
    });
  }

  /**
   * Setup error handlers
   */
  setupErrorHandlers(client, sessionId, session) {
    // Generic error handler
    client.on('error', (error) => {
      this.trackEvent(sessionId, 'error');
      logger.error(`❌ Error in session ${sessionId}:`, error);
      
      session.lastError = {
        message: error.message,
        stack: error.stack,
        timestamp: Date.now()
      };
      
      // Emit error event
      this.emitSessionError(sessionId, error);
    });
    
    // Remote session saved
    client.on('remote_session_saved', () => {
      this.trackEvent(sessionId, 'remote_session_saved');
      logger.info(`💾 Remote session saved for ${sessionId}`);
    });
  }

  /**
   * Setup state handlers
   */
  setupStateHandlers(client, sessionId, session) {
    // Loading screen
    client.on('loading_screen', (percent, message) => {
      logger.info(`⏳ Loading ${sessionId}: ${percent}% - ${message}`);
      session.loadingProgress = { percent, message };
      
      this.emitLoadingProgress(sessionId, percent, message);
    });
    
    // Change battery
    client.on('change_battery', (batteryInfo) => {
      logger.debug(`🔋 Battery info for ${sessionId}:`, batteryInfo);
      session.batteryInfo = batteryInfo;
    });
  }

  /**
   * WebSocket emission helpers
   */
  emitQRUpdate(sessionId, qr, qrDataUrl, attempt) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('qr-update', {
        sessionId,
        qr,
        qrDataUrl,
        status: 'waiting_qr',
        attempt
      });
    }
  }

  emitQRLimitReached(sessionId) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('qr-limit-reached', {
        sessionId,
        message: 'Too many QR attempts. Please unlink old devices in WhatsApp.'
      });
    }
  }

  emitAuthenticationSuccess(sessionId) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('session-authenticated', {
        sessionId,
        status: 'authenticated',
        timestamp: Date.now()
      });
    }
  }

  emitAuthenticationFailure(sessionId, error) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('auth-failed', {
        sessionId,
        status: 'auth_failed',
        error
      });
    }
  }

  emitSessionReady(sessionId) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('session-ready', {
        sessionId,
        status: 'ready',
        timestamp: Date.now()
      });
    }
  }

  emitSessionDisconnected(sessionId, reason) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('session-disconnected', {
        sessionId,
        status: 'disconnected',
        reason,
        timestamp: Date.now()
      });
    }
  }

  emitStateChange(sessionId, state) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('state-change', {
        sessionId,
        state,
        timestamp: Date.now()
      });
    }
  }

  emitMessageReceived(sessionId, message) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('message-received', {
        sessionId,
        message: {
          id: message.id._serialized,
          body: message.body,
          from: message.from,
          timestamp: message.timestamp
        }
      });
    }
  }

  emitSessionError(sessionId, error) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('session-error', {
        sessionId,
        error: error.message,
        timestamp: Date.now()
      });
    }
  }

  emitLoadingProgress(sessionId, percent, message) {
    if (this.manager.io) {
      this.manager.io.to(`qr-${sessionId}`).emit('loading-progress', {
        sessionId,
        percent,
        message,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Track event metrics
   */
  trackEvent(sessionId, eventType) {
    if (!this.eventMetrics.has(sessionId)) {
      this.eventMetrics.set(sessionId, {});
    }
    
    const metrics = this.eventMetrics.get(sessionId);
    metrics[eventType] = (metrics[eventType] || 0) + 1;
    metrics.lastEvent = { type: eventType, timestamp: Date.now() };
  }

  /**
   * Get event metrics for a session
   */
  getMetrics(sessionId) {
    return this.eventMetrics.get(sessionId) || {};
  }

  /**
   * Get all metrics
   */
  getAllMetrics() {
    const result = {};
    for (const [sessionId, metrics] of this.eventMetrics) {
      result[sessionId] = metrics;
    }
    return result;
  }
}

// Export singleton instance
const enhancedHandlers = new EnhancedWhatsAppHandlers();
export { EnhancedWhatsAppHandlers, enhancedHandlers };
