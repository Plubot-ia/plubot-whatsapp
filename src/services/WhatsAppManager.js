/**
 * WhatsApp Manager
 * Enterprise-grade WhatsApp session management with clean architecture
 * Implements Repository Pattern, DTOs, and proper separation of concerns
 */

import EventEmitter from 'events';
import logger from '../utils/logger.js';
import WhatsAppSessionManager from './WhatsAppSessionManager.js';
import SessionPersistenceService from './SessionPersistenceService.js';
import AutoReconnectService from './AutoReconnectService.js';
import enhancedSessionPool from './EnhancedSessionPool.js';
import { circuitBreakerManager } from '../patterns/CircuitBreaker.js';
import { EnhancedWhatsAppHandlers } from './EnhancedWhatsAppHandlers.js';
import HealthCheckService from './HealthCheckService.js';
import { SessionRepository } from '../repositories/SessionRepository.js';
import { SessionDTO, SessionCreateResponseDTO, SessionListResponseDTO } from '../dto/SessionDTO.js';
import redisClient from '../config/redis.js';

class WhatsAppManagerV2 extends EventEmitter {
  constructor() {
    super();
    
    // Redis client
    this.redis = redisClient;
    
    // Client references (never exposed to API)
    this.clients = new Map();
    
    // Core services
    this.sessionManager = new WhatsAppSessionManager(this);
    this.persistenceService = new SessionPersistenceService();
    this.reconnectService = null;
    this.sessionPool = enhancedSessionPool;
    this.healthCheckService = new HealthCheckService(this);
    
    // Repository for clean data access
    this.repository = new SessionRepository(redisClient, this.sessionManager);
    
    // Circuit breaker for resilience
    this.circuitBreaker = circuitBreakerManager.getBreaker('WhatsAppManager', {
      failureThreshold: 5,
      resetTimeout: 60000,
      monitoringPeriod: 10000
    });
    
    // Metrics
    this.metrics = {
      sessionsCreated: 0,
      sessionsFailed: 0,
      messagesProcessed: 0,
      qrGenerated: 0,
      reconnections: 0
    };
    
    this.initialized = false;
  }

  /**
   * Initialize the manager
   */
  async initialize() {
    if (this.initialized) {
      logger.warn('WhatsAppManager already initialized');
      return;
    }

    try {
      logger.info('🚀 Initializing WhatsApp Manager V2...');
      
      // Setup auto-reconnection
      this.reconnectService = new AutoReconnectService(this);
      // this.reconnectService.startMonitoring();
      
      // Setup health monitoring
      // this.healthCheckService.startMonitoring();
      
      // Restore sessions from persistence
      // await this.restoreSessions();
      
      // Setup periodic cleanup
      this.setupPeriodicCleanup();
      
      this.initialized = true;
      logger.info('✅ WhatsApp Manager V2 initialized successfully');
      
    } catch (error) {
      logger.error('Failed to initialize WhatsApp Manager:', error);
      throw error;
    }
  }

  /**
   * Create a new WhatsApp session
   * Returns a clean DTO without any circular references
   */
  async createSession(userId, plubotId) {
    const sessionId = `${userId}-${plubotId}`;
    
    return this.circuitBreaker.execute(async () => {
      try {
        logger.info(`Creating session ${sessionId}...`);
        
        // Use repository to create session (handles all complexity)
        const sessionDTO = await this.repository.create(userId, plubotId);
        
        // Get the actual client from session manager (for internal use only)
        const client = this.sessionManager.getClient(sessionId);
        if (client) {
          this.clients.set(sessionId, client);
          
          // Setup event handlers
          await this.setupSessionHandlers(sessionId, client);
        }
        
        // Update metrics
        this.metrics.sessionsCreated++;
        
        // Emit event
        this.emit('session:created', sessionDTO);
        
        logger.info(`✅ Session ${sessionId} created successfully`);
        
        // Return clean DTO response
        return SessionCreateResponseDTO.success(sessionDTO);
        
      } catch (error) {
        logger.error(`Failed to create session ${sessionId}:`, error);
        this.metrics.sessionsFailed++;
        
        // Return clean error response
        return SessionCreateResponseDTO.failure(error.message);
      }
    });
  }

  /**
   * Get session by ID
   * Returns a clean DTO
   */
  async getSession(sessionId) {
    try {
      const session = await this.repository.findById(sessionId);
      
      if (!session) {
        return null;
      }
      
      // Enrich with real-time status if client exists
      const client = this.clients.get(sessionId);
      if (client) {
        session.connectionState = client.info?.wid ? 'connected' : 'disconnected';
        session.isReady = client.info?.pushname ? true : false;
      }
      
      return session;
      
    } catch (error) {
      logger.error(`Failed to get session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Get all sessions
   * Returns clean DTOs
   */
  async getAllSessions(filter = {}) {
    try {
      const sessions = await this.repository.findAll(filter);
      
      // Enrich with real-time status
      for (const session of sessions) {
        const client = this.clients.get(session.sessionId);
        if (client) {
          session.connectionState = client.info?.wid ? 'connected' : 'disconnected';
          session.isReady = client.info?.pushname ? true : false;
        }
      }
      
      return new SessionListResponseDTO(sessions);
      
    } catch (error) {
      logger.error('Failed to get all sessions:', error);
      return new SessionListResponseDTO([]);
    }
  }

  /**
   * Update session QR code
   */
  async updateSessionQR(sessionId, qr) {
    try {
      // Generate QR data URL
      const qrDataUrl = await this.generateQRDataUrl(qr);
      
      // Update in repository
      const updated = await this.repository.updateQR(sessionId, qr, qrDataUrl);
      
      // Update metrics
      this.metrics.qrGenerated++;
      
      // Emit event for WebSocket
      this.emit('qr:updated', {
        sessionId,
        qr,
        qrDataUrl
      });
      
      return updated;
      
    } catch (error) {
      logger.error(`Failed to update QR for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Destroy session
   */
  async destroySession(sessionId) {
    try {
      logger.info(`Destroying session ${sessionId}...`);
      
      // Remove from repository
      await this.repository.delete(sessionId);
      
      // Remove client reference
      this.clients.delete(sessionId);
      
      // Emit event
      this.emit('session:destroyed', { sessionId });
      
      logger.info(`✅ Session ${sessionId} destroyed successfully`);
      
      return { success: true, sessionId };
      
    } catch (error) {
      logger.error(`Failed to destroy session ${sessionId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send message through session
   */
  async sendMessage(sessionId, to, message, options = {}) {
    const client = this.clients.get(sessionId);
    
    if (!client) {
      throw new Error(`Session ${sessionId} not found or not ready`);
    }
    
    try {
      const result = await client.sendMessage(to, message, options);
      
      // Update metrics
      this.metrics.messagesProcessed++;
      await this.repository.updateMetrics(sessionId, {
        messagesSent: (await this.repository.findById(sessionId))?.messagesSent + 1 || 1
      });
      
      return result;
      
    } catch (error) {
      logger.error(`Failed to send message for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Setup event handlers for a session
   */
  async setupSessionHandlers(sessionId, client) {
    const handlers = new EnhancedWhatsAppHandlers(this);
    
    // QR Code
    client.on('qr', async (qr) => {
      await this.updateSessionQR(sessionId, qr);
    });
    
    // Ready
    client.on('ready', async () => {
      await this.repository.update(sessionId, {
        status: 'ready',
        isReady: true,
        isAuthenticated: true,
        connectionState: 'connected'
      });
      
      this.emit('session:ready', { sessionId });
    });
    
    // Authenticated
    client.on('authenticated', async () => {
      await this.repository.update(sessionId, {
        status: 'authenticated',
        isAuthenticated: true
      });
      
      this.emit('session:authenticated', { sessionId });
    });
    
    // Disconnected
    client.on('disconnected', async (reason) => {
      await this.repository.update(sessionId, {
        status: 'disconnected',
        connectionState: 'disconnected',
        error: reason
      });
      
      this.emit('session:disconnected', { sessionId, reason });
    });
    
    // Message
    client.on('message', async (message) => {
      await this.repository.updateMetrics(sessionId, {
        messagesReceived: (await this.repository.findById(sessionId))?.messagesReceived + 1 || 1,
        lastActivity: new Date().toISOString()
      });
      
      this.emit('message:received', { sessionId, message });
    });
    
    // Error
    client.on('error', async (error) => {
      logger.error(`Session ${sessionId} error:`, error);
      
      await this.repository.update(sessionId, {
        status: 'error',
        error: error.message,
        lastError: error.message
      });
      
      this.emit('session:error', { sessionId, error: error.message });
    });
  }

  /**
   * Generate QR code data URL
   */
  async generateQRDataUrl(qr) {
    try {
      const QRCode = (await import('qrcode')).default;
      return await QRCode.toDataURL(qr, {
        width: 256,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });
    } catch (error) {
      logger.error('Failed to generate QR data URL:', error);
      return null;
    }
  }

  /**
   * Restore sessions from persistence
   */
  async restoreSessions() {
    try {
      const sessions = await this.repository.findByStatus('ready');
      
      for (const session of sessions) {
        try {
          // Recreate client
          const client = await this.sessionManager.restoreSession(session.sessionId);
          
          if (client) {
            this.clients.set(session.sessionId, client);
            await this.setupSessionHandlers(session.sessionId, client);
            
            logger.info(`✅ Restored session ${session.sessionId}`);
          }
        } catch (error) {
          logger.error(`Failed to restore session ${session.sessionId}:`, error);
        }
      }
      
      logger.info(`Restored ${sessions.length} sessions`);
      
    } catch (error) {
      logger.error('Failed to restore sessions:', error);
    }
  }

  /**
   * Setup periodic cleanup
   */
  setupPeriodicCleanup() {
    // Clean up stale sessions every hour
    setInterval(async () => {
      try {
        const cleaned = await this.repository.cleanupStaleSessions();
        if (cleaned.length > 0) {
          logger.info(`Cleaned up ${cleaned.length} stale sessions`);
        }
      } catch (error) {
        logger.error('Failed to clean up stale sessions:', error);
      }
    }, 3600000); // 1 hour
  }

  /**
   * Get health status
   */
  async getHealthStatus() {
    const stats = await this.repository.getStatistics();
    
    return {
      healthy: stats.ready > 0,
      sessions: stats,
      metrics: this.metrics,
      circuitBreaker: {
        state: this.circuitBreaker.state,
        failures: this.circuitBreaker.failures,
        successes: this.circuitBreaker.successes
      }
    };
  }

  /**
   * Shutdown manager
   */
  async shutdown() {
    logger.info('Shutting down WhatsApp Manager...');
    
    try {
      // Stop services
      if (this.reconnectService) {
        this.reconnectService.stopMonitoring();
      }
      
      if (this.healthCheckService) {
        this.healthCheckService.stopMonitoring();
      }
      
      // Destroy all sessions
      for (const sessionId of this.clients.keys()) {
        await this.destroySession(sessionId);
      }
      
      logger.info('✅ WhatsApp Manager shut down successfully');
      
    } catch (error) {
      logger.error('Error during shutdown:', error);
    }
  }
}

// Export singleton instance
const whatsappManagerV2 = new WhatsAppManagerV2();
export default whatsappManagerV2;
