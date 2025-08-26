const { Client, LocalAuth } = require('whatsapp-web.js');
const EventEmitter = require('events');
const SessionPool = require('./SessionPool');
const logger = require('../utils/logger');
const redis = require('../config/redis');
const { promisify } = require('util');

// Promisify Redis operations
const redisGet = promisify(redis.get).bind(redis);
const redisSet = promisify(redis.set).bind(redis);
const redisDel = promisify(redis.del).bind(redis);
const redisKeys = promisify(redis.keys).bind(redis);

/**
 * ImprovedWhatsAppManager - Production-ready WhatsApp session manager
 * Handles multiple concurrent sessions with proper error recovery
 */
class ImprovedWhatsAppManager extends EventEmitter {
  constructor() {
    super();
    
    // Initialize session pool with production settings
    this.sessionPool = new SessionPool({
      maxPoolSize: 100,
      maxRetries: 3,
      sessionTimeout: 30 * 60 * 1000, // 30 minutes
      healthCheckInterval: 60 * 1000 // 1 minute
    });
    
    // QR code cache
    this.qrCache = new Map();
    
    // Message queue for reliability
    this.messageQueue = new Map();
    
    // Setup event listeners
    this.setupPoolEventListeners();
    
    logger.info('ImprovedWhatsAppManager initialized');
  }

  /**
   * Setup event listeners for session pool
   */
  setupPoolEventListeners() {
    this.sessionPool.on('sessionCreated', ({ sessionId }) => {
      logger.info(`Session created: ${sessionId}`);
      this.emit('sessionCreated', { sessionId });
    });
    
    this.sessionPool.on('sessionRemoved', ({ sessionId }) => {
      logger.info(`Session removed: ${sessionId}`);
      this.qrCache.delete(sessionId);
      this.messageQueue.delete(sessionId);
      this.emit('sessionRemoved', { sessionId });
    });
    
    this.sessionPool.on('sessionUnhealthy', ({ sessionId }) => {
      logger.warn(`Session unhealthy: ${sessionId}`);
      this.emit('sessionUnhealthy', { sessionId });
    });
    
    this.sessionPool.on('sessionRecovering', ({ sessionId, attempt }) => {
      logger.info(`Session recovering: ${sessionId} (attempt ${attempt})`);
      this.emit('sessionRecovering', { sessionId, attempt });
    });
  }

  /**
   * Create or get a WhatsApp session with improved error handling
   */
  async createSession(userId, plubotId) {
    const sessionId = `${userId}-${plubotId}`;
    
    try {
      logger.info(`Creating/getting session: ${sessionId}`);
      
      // Get or create session from pool
      let session = await this.sessionPool.getSession(sessionId);
      
      // If client doesn't exist, create it
      if (!session.client) {
        session.client = await this.initializeClient(sessionId);
        session.status = 'initializing';
        
        // Store session info in Redis for persistence
        await this.persistSessionInfo(sessionId, session);
      }
      
      // Get current session state
      const sessionInfo = await this.getSessionInfo(sessionId);
      
      return {
        success: true,
        sessionId,
        status: sessionInfo.status,
        qr: sessionInfo.qr,
        qrDataUrl: sessionInfo.qrDataUrl,
        isReady: sessionInfo.status === 'ready' || sessionInfo.status === 'connected',
        phoneNumber: sessionInfo.phoneNumber
      };
      
    } catch (error) {
      logger.error(`Error creating session ${sessionId}:`, error);
      
      // Don't throw error immediately, try to provide useful feedback
      return {
        success: false,
        sessionId,
        status: 'error',
        error: error.message,
        canRetry: true
      };
    }
  }

  /**
   * Initialize WhatsApp client with proper configuration
   */
  async initializeClient(sessionId) {
    try {
      const client = new Client({
        authStrategy: new LocalAuth({
          clientId: sessionId,
          dataPath: './sessions'
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
            '--disable-gpu'
          ]
        },
        qrMaxRetries: 5,
        authTimeoutMs: 60000,
        takeoverOnConflict: false,
        takeoverTimeoutMs: 10000,
        restartOnAuthFail: true
      });
      
      // Setup client event handlers
      this.setupClientEventHandlers(client, sessionId);
      
      // Initialize client
      await client.initialize();
      
      return client;
      
    } catch (error) {
      logger.error(`Error initializing client for ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Setup event handlers for WhatsApp client
   */
  setupClientEventHandlers(client, sessionId) {
    // QR Code generation
    client.on('qr', async (qr) => {
      logger.info(`QR generated for session: ${sessionId}`);
      
      // Cache QR code
      this.qrCache.set(sessionId, qr);
      
      // Update session status
      const session = await this.sessionPool.getSession(sessionId, false);
      if (session) {
        session.status = 'waiting_qr';
      }
      
      // Store in Redis
      await redisSet(`qr:${sessionId}`, qr, 'EX', 300); // Expire in 5 minutes
      
      // Emit QR event
      this.emit('qr', { sessionId, qr });
    });
    
    // Handle authenticated event
    client.on('authenticated', async (session) => {
      try {
        this.logger.info(`🔐 Client authenticated for session ${sessionId}`, { session });
        
        // Update session status immediately
        await this.updateSessionStatus(sessionId, 'authenticated');
        
        // Emit WebSocket event directly with more details
        if (this.io) {
          const eventData = {
            sessionId,
            status: 'authenticated',
            timestamp: new Date().toISOString(),
            session: session
          };
          
          this.io.to(`session-${sessionId}`).emit('session:authenticated', eventData);
          this.io.to(`qr-${sessionId}`).emit('session:authenticated', eventData);
          
          // Also emit a general authenticated event
          this.io.emit('whatsapp:authenticated', eventData);
          
          this.logger.info(`📤 Emitted authenticated event to all rooms for session ${sessionId}`);
        }
        
        this.emit('session:authenticated', { sessionId, session });
      } catch (error) {
        this.logger.error(`Error handling authenticated event for ${sessionId}:`, error);
      }
    });
    
    // Add auth_failure handler
    client.on('auth_failure', (msg) => {
      this.logger.error(`❌ Authentication failed for ${sessionId}:`, msg);
      this.updateSessionStatus(sessionId, 'auth_failed');
    });
    
    // Add loading_screen handler for debugging
    client.on('loading_screen', (percent, message) => {
      this.logger.info(`⏳ Loading ${sessionId}: ${percent}% - ${message}`);
    });
    
    // Client ready
    client.on('ready', async () => {
      this.logger.info(`✅ Session ready: ${sessionId}`);
      
      // Update session status
      const session = await this.sessionPool.getSession(sessionId, false);
      if (session) {
        session.status = 'ready';
        session.isReady = true;
        session.isAuthenticated = true;
        session.connectionState = 'connected';
        
        // Get phone info
        const info = client.info;
        if (info) {
          session.phoneNumber = info.wid?.user || info.wid?._serialized;
          session.pushname = info.pushname;
          this.logger.info(`📱 Phone info for ${sessionId}: ${session.phoneNumber} (${session.pushname})`);
        }
        
        await this.sessionRepository.update(sessionId, session);
      }
      
      // Process any queued messages
      await this.processMessageQueue(sessionId);
      
      // Emit ready event
      this.emit('ready', { 
        sessionId, 
        phoneNumber: session?.phoneNumber,
        pushname: session?.pushname
      });
      
      // Also emit via WebSocket directly
      const io = global.io || this.io;
      if (io) {
        const eventData = {
          sessionId,
          status: 'ready',
          phoneNumber: session?.phoneNumber,
          pushname: session?.pushname,
          timestamp: new Date().toISOString()
        };
        
        io.to(`session-${sessionId}`).emit('session:ready', eventData);
        io.to(`qr-${sessionId}`).emit('session:ready', eventData);
        io.emit('whatsapp:ready', eventData);
        
        this.logger.info(`📤 Emitted session:ready to WebSocket rooms for ${sessionId}`);
      }
    });
    
    // Disconnection
    client.on('disconnected', async (reason) => {
      logger.warn(`Session disconnected: ${sessionId}, reason: ${reason}`);
      
      // Update session status
      const session = await this.sessionPool.getSession(sessionId, false);
      if (session) {
        session.status = 'disconnected';
        session.disconnectReason = reason;
        
        // Update metrics
        const metrics = this.sessionPool.sessionMetrics.get(sessionId);
        if (metrics) {
          metrics.errors++;
        }
      }
      
      // Emit disconnected event
      this.emit('disconnected', { sessionId, reason });
      
      // Attempt automatic recovery if not manual disconnect
      if (reason !== 'LOGOUT') {
        setTimeout(() => {
          this.sessionPool.recoverSession(sessionId).catch(err => {
            logger.error(`Failed to recover session ${sessionId}:`, err);
          });
        }, 5000);
      }
    });
    
    // Message received
    client.on('message', async (message) => {
      logger.info(`Message received for session ${sessionId}: ${message.body}`);
      
      // Update metrics
      const metrics = this.sessionPool.sessionMetrics.get(sessionId);
      if (metrics) {
        metrics.messagesReceived++;
      }
      
      // Emit message event
      this.emit('message', { sessionId, message });
    });
    
    // Authentication failure
    client.on('auth_failure', async (error) => {
      logger.error(`Authentication failed for ${sessionId}:`, error);
      
      // Update session status
      const session = await this.sessionPool.getSession(sessionId, false);
      if (session) {
        session.status = 'auth_failed';
        session.authError = error;
      }
      
      // Emit auth failure event
      this.emit('authFailure', { sessionId, error });
    });
  }

  /**
   * Get session information with caching
   */
  async getSessionInfo(sessionId) {
    try {
      const session = await this.sessionPool.getSession(sessionId, false);
      
      if (!session) {
        return { status: 'not_found' };
      }
      
      // Get QR from cache or Redis
      let qr = this.qrCache.get(sessionId);
      if (!qr && session.status === 'waiting_qr') {
        qr = await redisGet(`qr:${sessionId}`);
      }
      
      // Generate QR data URL if QR exists
      let qrDataUrl = null;
      if (qr) {
        const QRCode = require('qrcode');
        qrDataUrl = await QRCode.toDataURL(qr);
      }
      
      return {
        status: session.status,
        qr,
        qrDataUrl,
        phoneNumber: session.phoneNumber,
        pushname: session.pushname,
        isReady: session.status === 'ready' || session.status === 'connected',
        metrics: this.sessionPool.sessionMetrics.get(sessionId)
      };
      
    } catch (error) {
      logger.error(`Error getting session info for ${sessionId}:`, error);
      return { status: 'error', error: error.message };
    }
  }

  /**
   * Send message with queuing and retry logic
   */
  async sendMessage(sessionId, phoneNumber, message) {
    try {
      const session = await this.sessionPool.getSession(sessionId, false);
      
      if (!session || !session.client) {
        // Queue message for later delivery
        this.queueMessage(sessionId, phoneNumber, message);
        throw new Error('Session not ready');
      }
      
      if (session.status !== 'ready') {
        // Queue message for later delivery
        this.queueMessage(sessionId, phoneNumber, message);
        return { queued: true, message: 'Message queued for delivery' };
      }
      
      // Format phone number
      const chatId = phoneNumber.includes('@c.us') ? phoneNumber : `${phoneNumber}@c.us`;
      
      // Send message
      const result = await session.client.sendMessage(chatId, message);
      
      // Update metrics
      const metrics = this.sessionPool.sessionMetrics.get(sessionId);
      if (metrics) {
        metrics.messagesSent++;
      }
      
      return { success: true, messageId: result.id };
      
    } catch (error) {
      logger.error(`Error sending message for ${sessionId}:`, error);
      
      // Update error metrics
      const metrics = this.sessionPool.sessionMetrics.get(sessionId);
      if (metrics) {
        metrics.errors++;
      }
      
      throw error;
    }
  }

  /**
   * Queue message for later delivery
   */
  queueMessage(sessionId, phoneNumber, message) {
    if (!this.messageQueue.has(sessionId)) {
      this.messageQueue.set(sessionId, []);
    }
    
    this.messageQueue.get(sessionId).push({
      phoneNumber,
      message,
      timestamp: Date.now()
    });
    
    logger.info(`Message queued for session ${sessionId}`);
  }

  /**
   * Process queued messages for a session
   */
  async processMessageQueue(sessionId) {
    const queue = this.messageQueue.get(sessionId);
    
    if (!queue || queue.length === 0) {
      return;
    }
    
    logger.info(`Processing ${queue.length} queued messages for ${sessionId}`);
    
    const processed = [];
    for (const item of queue) {
      try {
        await this.sendMessage(sessionId, item.phoneNumber, item.message);
        processed.push(item);
      } catch (error) {
        logger.error(`Failed to send queued message for ${sessionId}:`, error);
      }
    }
    
    // Remove processed messages
    const remaining = queue.filter(item => !processed.includes(item));
    if (remaining.length === 0) {
      this.messageQueue.delete(sessionId);
    } else {
      this.messageQueue.set(sessionId, remaining);
    }
  }

  /**
   * Persist session information to Redis
   */
  async persistSessionInfo(sessionId, session) {
    try {
      const sessionData = {
        id: sessionId,
        status: session.status,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        phoneNumber: session.phoneNumber,
        pushname: session.pushname
      };
      
      await redisSet(
        `session:${sessionId}`,
        JSON.stringify(sessionData),
        'EX',
        3600 // Expire in 1 hour
      );
      
    } catch (error) {
      logger.error(`Error persisting session ${sessionId}:`, error);
    }
  }

  /**
   * Disconnect a session
   */
  async disconnectSession(sessionId) {
    try {
      const session = await this.sessionPool.getSession(sessionId, false);
      
      if (session && session.client) {
        await session.client.logout();
      }
      
      await this.sessionPool.removeSession(sessionId);
      
      return { success: true };
      
    } catch (error) {
      logger.error(`Error disconnecting session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Get session state (alias for getSessionStatus)
   */
  async getSessionState(sessionId) {
    return this.getSessionStatus(sessionId);
  }

  /**
   * Get session status
   */
  async getSessionStatus(sessionId) {
    try {
      const session = await this.sessionPool.getSession(sessionId, false);
      
      if (!session) {
        return { status: 'not_found' };
      }
      
      return {
        status: session.status || 'initializing',
        phoneNumber: session.phoneNumber || null,
        lastActivity: session.lastActivity || null,
        createdAt: session.createdAt,
        isReady: session.status === 'ready' || session.status === 'connected',
        isAuthenticated: session.status === 'authenticated' || session.status === 'ready',
        pushname: session.pushname || null
      };
    } catch (error) {
      logger.error(`Error getting session status for ${sessionId}:`, error);
      return { status: 'not_found' };
    }
  }

  /**
   * Get all sessions
   */
  async getAllSessions(filter = {}) {
    try {
      const sessions = [];
      
      for (const [sessionId, session] of this.sessionPool.sessions) {
        // Apply filters if provided
        if (filter.status && session.status !== filter.status) continue;
        if (filter.userId && !sessionId.startsWith(filter.userId)) continue;
        
        sessions.push({
          id: sessionId,
          status: session.status,
          phoneNumber: session.phoneNumber,
          createdAt: session.createdAt,
          lastActivity: session.lastActivity
        });
      }
      
      return {
        success: true,
        sessions,
        total: sessions.length
      };
    } catch (error) {
      logger.error('Error getting all sessions:', error);
      return {
        success: false,
        sessions: [],
        total: 0,
        error: error.message
      };
    }
  }

  /**
   * Destroy session (alias for disconnectSession)
   */
  async destroySession(sessionId) {
    return this.disconnectSession(sessionId);
  }

  /**
   * Get statistics for all sessions
   */
  getStatistics() {
    return this.sessionPool.getStatistics();
  }

  /**
   * Gracefully shutdown the manager
   */
  async shutdown() {
    logger.info('Shutting down ImprovedWhatsAppManager...');
    await this.sessionPool.shutdown();
    logger.info('ImprovedWhatsAppManager shutdown complete');
  }
}

module.exports = ImprovedWhatsAppManager;
