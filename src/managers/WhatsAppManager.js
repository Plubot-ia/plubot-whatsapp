import { EventEmitter } from 'events';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode';
import logger from '../utils/logger.js';

/**
 * WhatsApp Manager - Handles WhatsApp client operations
 * Integrates with enterprise components
 */
class WhatsAppManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = config;
    this.sessionPool = config.sessionPool;
    this.messageQueue = config.messageQueue;
    this.sessionReconnector = config.sessionReconnector;
    this.metricsCollector = config.metricsCollector;
    this.circuitBreakerFactory = config.circuitBreakerFactory;
    
    this.clients = new Map();
    this.sessionStates = new Map();
  }
  
  /**
   * Initialize a WhatsApp session
   */
  async initializeSession(sessionData) {
    const { id: sessionId } = sessionData;
    
    try {
      logger.info(`Initializing WhatsApp session: ${sessionId}`);
      
      // Check if client already exists
      if (this.clients.has(sessionId)) {
        logger.warn(`Session ${sessionId} already initialized`);
        return this.clients.get(sessionId);
      }
      
      // Create WhatsApp client
      const client = new Client({
        authStrategy: new LocalAuth({
          clientId: sessionId,
          dataPath: './sessions',
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
          ],
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        },
        // Remove webVersionCache to use latest WhatsApp Web version
      });
      
      // Setup event handlers
      this._setupClientHandlers(client, sessionId);
      
      // Store client
      this.clients.set(sessionId, client);
      this.sessionStates.set(sessionId, {
        status: 'initializing',
        createdAt: Date.now(),
        lastActivity: Date.now(),
      });
      
      // Initialize client
      await client.initialize();
      
      logger.info(`WhatsApp session ${sessionId} initialized successfully`);
      
      // Record metrics
      if (this.metricsCollector) {
        this.metricsCollector.recordSessionCreated('success');
      }
      
      return client;
      
    } catch (error) {
      logger.error(`Failed to initialize session ${sessionId}:`, error);
      
      if (this.metricsCollector) {
        this.metricsCollector.recordSessionCreated('failure');
      }
      
      throw error;
    }
  }
  
  /**
   * Setup WhatsApp client event handlers
   */
  _setupClientHandlers(client, sessionId) {
    // QR Code event
    client.on('qr', async (qr) => {
      try {
        logger.info(`QR code generated for session ${sessionId}`);
        
        const qrDataUrl = await qrcode.toDataURL(qr);
        
        this.emit('qr', {
          sessionId,
          qr,
          qrDataUrl,
          timestamp: new Date().toISOString(),
        });
        
        // Update session state
        this.sessionStates.set(sessionId, {
          ...this.sessionStates.get(sessionId),
          status: 'qr_generated',
          lastActivity: Date.now(),
        });
        
        // Record metrics
        if (this.metricsCollector) {
          this.metricsCollector.recordQRGenerated();
        }
        
      } catch (error) {
        logger.error(`Error handling QR for session ${sessionId}:`, error);
      }
    });
    
    // Authentication events
    client.on('authenticated', () => {
      logger.info(`Session ${sessionId} authenticated`);
      
      this.emit('authenticated', {
        sessionId,
        timestamp: new Date().toISOString(),
      });
      
      this.sessionStates.set(sessionId, {
        ...this.sessionStates.get(sessionId),
        status: 'authenticated',
        authenticatedAt: Date.now(),
        lastActivity: Date.now(),
      });
    });
    
    client.on('auth_failure', (error) => {
      logger.error(`Authentication failed for session ${sessionId}:`, error);
      
      this.emit('auth_failure', {
        sessionId,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
      
      this.sessionStates.set(sessionId, {
        ...this.sessionStates.get(sessionId),
        status: 'auth_failed',
        lastActivity: Date.now(),
      });
      
      if (this.metricsCollector) {
        this.metricsCollector.recordError('auth_failure', 'error');
      }
    });
    
    // Ready event
    client.on('ready', () => {
      logger.info(`WhatsApp session ${sessionId} is ready`);
      
      this.emit('ready', {
        sessionId,
        timestamp: new Date().toISOString(),
      });
      
      this.sessionStates.set(sessionId, {
        ...this.sessionStates.get(sessionId),
        status: 'ready',
        readyAt: Date.now(),
        lastActivity: Date.now(),
      });
      
      if (this.metricsCollector) {
        this.metricsCollector.recordConnectionEstablished();
      }
    });
    
    // Message events
    client.on('message', async (message) => {
      try {
        logger.debug(`Message received for session ${sessionId}`);
        
        // Queue message for processing
        if (this.messageQueue) {
          await this.messageQueue.addMessage('incoming', {
            sessionId,
            message: {
              id: message.id._serialized,
              from: message.from,
              to: message.to,
              body: message.body,
              timestamp: message.timestamp,
              hasMedia: message.hasMedia,
              type: message.type,
            },
          });
        }
        
        this.emit('message', {
          sessionId,
          message,
          timestamp: new Date().toISOString(),
        });
        
        // Update activity
        this.sessionStates.set(sessionId, {
          ...this.sessionStates.get(sessionId),
          lastActivity: Date.now(),
          messagesReceived: (this.sessionStates.get(sessionId).messagesReceived || 0) + 1,
        });
        
        if (this.metricsCollector) {
          this.metricsCollector.recordMessage('incoming', 'received');
        }
        
      } catch (error) {
        logger.error(`Error handling message for session ${sessionId}:`, error);
        
        if (this.metricsCollector) {
          this.metricsCollector.recordError('message_handling', 'error');
        }
      }
    });
    
    // Disconnection event
    client.on('disconnected', (reason) => {
      logger.warn(`Session ${sessionId} disconnected: ${reason}`);
      
      this.emit('disconnected', {
        sessionId,
        reason,
        timestamp: new Date().toISOString(),
      });
      
      this.sessionStates.set(sessionId, {
        ...this.sessionStates.get(sessionId),
        status: 'disconnected',
        disconnectedAt: Date.now(),
        lastActivity: Date.now(),
      });
      
      // Trigger reconnection if configured
      if (this.sessionReconnector) {
        this.sessionReconnector.scheduleReconnection(sessionId, async () => {
          await this.reconnectSession(sessionId);
        });
      }
      
      if (this.metricsCollector) {
        this.metricsCollector.recordConnectionClosed('disconnected');
      }
    });
    
    // Error handling
    client.on('error', (error) => {
      logger.error(`Error in session ${sessionId}:`, error);
      
      this.emit('error', {
        sessionId,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
      
      if (this.metricsCollector) {
        this.metricsCollector.recordError('client_error', 'error');
      }
    });
  }
  
  /**
   * Send a message
   */
  async sendMessage(session, recipient, message, options = {}) {
    const sessionId = session.id;
    const client = this.clients.get(sessionId);
    
    if (!client) {
      throw new Error(`Client not found for session ${sessionId}`);
    }
    
    try {
      logger.info(`Sending message from session ${sessionId} to ${recipient}`);
      
      // Format recipient
      const chatId = recipient.includes('@') ? recipient : `${recipient}@c.us`;
      
      // Send message
      const result = await client.sendMessage(chatId, message, options);
      
      // Update state
      this.sessionStates.set(sessionId, {
        ...this.sessionStates.get(sessionId),
        lastActivity: Date.now(),
        messagesSent: (this.sessionStates.get(sessionId).messagesSent || 0) + 1,
      });
      
      if (this.metricsCollector) {
        this.metricsCollector.recordMessage('outgoing', 'sent');
      }
      
      return result;
      
    } catch (error) {
      logger.error(`Failed to send message from session ${sessionId}:`, error);
      
      if (this.metricsCollector) {
        this.metricsCollector.recordMessage('outgoing', 'failure');
      }
      
      throw error;
    }
  }
  
  /**
   * Send media
   */
  async sendMedia(session, recipient, media) {
    const sessionId = session.id;
    const client = this.clients.get(sessionId);
    
    if (!client) {
      throw new Error(`Client not found for session ${sessionId}`);
    }
    
    try {
      logger.info(`Sending media from session ${sessionId} to ${recipient}`);
      
      const chatId = recipient.includes('@') ? recipient : `${recipient}@c.us`;
      const result = await client.sendMessage(chatId, media);
      
      if (this.metricsCollector) {
        this.metricsCollector.recordMessage('media', 'sent');
      }
      
      return result;
      
    } catch (error) {
      logger.error(`Failed to send media from session ${sessionId}:`, error);
      
      if (this.metricsCollector) {
        this.metricsCollector.recordMessage('media', 'failure');
      }
      
      throw error;
    }
  }
  
  /**
   * Process incoming message
   */
  async processIncomingMessage(sessionId, message) {
    try {
      logger.debug(`Processing incoming message for session ${sessionId}`);
      
      // Your message processing logic here
      // This could include:
      // - Auto-replies
      // - Command processing
      // - Webhook notifications
      // - Database storage
      
      return { processed: true };
      
    } catch (error) {
      logger.error(`Failed to process incoming message:`, error);
      throw error;
    }
  }
  
  /**
   * Reconnect a session
   */
  async reconnectSession(sessionId) {
    try {
      logger.info(`Attempting to reconnect session ${sessionId}`);
      
      // Destroy old client
      const oldClient = this.clients.get(sessionId);
      if (oldClient) {
        await oldClient.destroy();
        this.clients.delete(sessionId);
      }
      
      // Create new session
      const sessionData = { id: sessionId };
      await this.initializeSession(sessionData);
      
      logger.info(`Session ${sessionId} reconnected successfully`);
      
      if (this.metricsCollector) {
        this.metricsCollector.recordReconnectionSuccess();
      }
      
      return true;
      
    } catch (error) {
      logger.error(`Failed to reconnect session ${sessionId}:`, error);
      
      if (this.metricsCollector) {
        this.metricsCollector.recordReconnectionFailure();
      }
      
      throw error;
    }
  }
  
  /**
   * Destroy a session
   */
  async destroySession(sessionId) {
    try {
      logger.info(`Destroying session ${sessionId}`);
      
      const client = this.clients.get(sessionId);
      
      if (client) {
        await client.destroy();
        this.clients.delete(sessionId);
      }
      
      this.sessionStates.delete(sessionId);
      
      if (this.sessionReconnector) {
        this.sessionReconnector.cancelReconnection(sessionId);
      }
      
      logger.info(`Session ${sessionId} destroyed successfully`);
      
      if (this.metricsCollector) {
        this.metricsCollector.recordSessionDestroyed();
      }
      
    } catch (error) {
      logger.error(`Failed to destroy session ${sessionId}:`, error);
      throw error;
    }
  }
  
  /**
   * Get session status
   */
  getSessionStatus(sessionId) {
    const state = this.sessionStates.get(sessionId);
    const client = this.clients.get(sessionId);
    
    if (!state) {
      return { status: 'not_found' };
    }
    
    return {
      ...state,
      connected: client ? client.info?.pushname !== undefined : false,
    };
  }
  
  /**
   * Get session state (alias for getSessionStatus)
   */
  getSessionState(sessionId) {
    return this.getSessionStatus(sessionId);
  }
  
  /**
   * Get all sessions
   */
  getAllSessions() {
    const sessions = [];
    
    for (const [sessionId, state] of this.sessionStates) {
      sessions.push({
        sessionId,
        ...state,
      });
    }
    
    return sessions;
  }
  
  /**
   * Shutdown manager
   */
  async shutdown() {
    logger.info('Shutting down WhatsApp manager');
    
    // Destroy all sessions
    const promises = [];
    for (const sessionId of this.clients.keys()) {
      promises.push(this.destroySession(sessionId));
    }
    
    await Promise.all(promises);
    
    this.removeAllListeners();
    logger.info('WhatsApp manager shutdown complete');
  }
}

export default WhatsAppManager;
