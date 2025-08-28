/**
 * Simplified WhatsApp Service - Fixed QR scanning
 * Focus on working QR generation and authentication
 */

const EventEmitter = require('events');
const path = require('path');
const fs = require('fs').promises;
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const logger = require('../utils/logger');

class SimpleWhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.qrCodes = new Map();
    this.sessionTimeouts = new Map();
    this.QR_TIMEOUT = 120000; // 120 seconds for QR expiration
    this.authDir = './auth-sessions';
    this.ensureAuthDirectory();
  }

  async ensureAuthDirectory() {
    try {
      await fs.mkdir(this.authDir, { recursive: true });
    } catch (error) {
      logger.error('Error creating auth directory:', error);
    }
  }

  /**
   * Create a new WhatsApp session with proper QR handling
   */
  async createSession(sessionId, options = {}) {
    try {
      // Check if session already exists
      if (this.sessions.has(sessionId)) {
        logger.info(`♻️ Session ${sessionId} already exists`);
        const existingClient = this.sessions.get(sessionId);
        const status = existingClient.status;
        
        // If session exists but QR expired, destroy and recreate
        if (status === 'waiting_qr' && !this.qrCodes.has(sessionId)) {
          logger.info(`🔄 Recreating expired session: ${sessionId}`);
          await this.destroySession(sessionId);
        } else {
          return { 
            success: true,
            sessionId,
            status,
            hasQR: this.qrCodes.has(sessionId)
          };
        }
      }

      logger.info(`🆕 Creating new session: ${sessionId}`);
      
      // Set initial status
      this.sessions.set(sessionId, { status: 'initializing' });
      
      // Create WhatsApp client with optimized settings
      const client = new Client({
        authStrategy: new LocalAuth({
          clientId: sessionId,
          dataPath: this.authDir
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
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-blink-features=AutomationControlled'
          ],
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
        },
        qrMaxRetries: 5,
        restartOnAuthFail: true
      });

      // Store session info
      this.sessions.set(sessionId, client);

      // Setup event handlers BEFORE initialization
      this.setupEventHandlers(client, sessionId);

      // Initialize client (this will trigger QR event)
      logger.info(`🚀 Initializing WhatsApp client for ${sessionId}`);
      client.initialize().catch(error => {
        logger.error(`❌ Failed to initialize ${sessionId}:`, error);
        this.sessions.get(sessionId).status = 'error';
      });

      // Wait a bit for QR to be generated
      await new Promise(resolve => setTimeout(resolve, 2000));

      logger.info(`✅ Session ${sessionId} initialization started`);
      
      const qrData = this.qrCodes.get(sessionId);
      return {
        success: true,
        sessionId,
        status: 'waiting_qr',
        qr: qrData?.qr,
        qrDataUrl: qrData?.dataUrl
      };

    } catch (error) {
      logger.error(`❌ Failed to create session ${sessionId}:`, error);
      return {
        success: false,
        sessionId,
        message: error.message
      };
    }
  }

  /**
   * Setup event handlers for WhatsApp client
   */
  setupEventHandlers(client, sessionId) {
    // QR Code event with improved handling
    client.on('qr', async (qr) => {
      try {
        logger.info(`📱 QR Code generated for session ${sessionId}`);
        logger.info(`QR Length: ${qr.length} characters`);
        
        // Validate QR code
        if (!qr || qr.length < 100) {
          logger.error(`Invalid QR code received for ${sessionId}`);
          return;
        }
        
        // Generate multiple QR formats for compatibility
        const qrOptions = {
          errorCorrectionLevel: 'M',
          type: 'image/png',
          quality: 0.92,
          margin: 1,
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          },
          width: 300
        };
        
        const qrDataUrl = await QRCode.toDataURL(qr, qrOptions);
        const qrTerminal = await QRCode.toString(qr, { type: 'terminal', small: true });
        
        // Log QR in terminal for debugging
        logger.info(`\nQR Code for ${sessionId}:\n${qrTerminal}`);
        
        // Store QR code with metadata
        this.qrCodes.set(sessionId, {
          qr,
          qrDataUrl,
          qrTerminal,
          timestamp: Date.now(),
          retryCount: (this.qrCodes.get(sessionId)?.retryCount || 0) + 1
        });
        
        // Emit QR update event
        this.emit('qr-update', {
          sessionId,
          qr,
          qrDataUrl,
          status: 'waiting_qr',
          retryCount: this.qrCodes.get(sessionId).retryCount
        });
        
        // Set timeout to clear QR after expiration
        this.setQRTimeout(sessionId);
      } catch (error) {
        logger.error(`Error generating QR for ${sessionId}:`, error);
        this.emit('auth-failure', {
          sessionId,
          error: 'QR generation failed',
          details: error.message
        });
      }
    });

    // Authentication events with better handling
    client.on('authenticated', () => {
      logger.info(`🔐 Session ${sessionId} authenticated successfully`);
      this.clearQRTimeout(sessionId);
      this.qrCodes.delete(sessionId);
      
      // Update session status
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = 'authenticated';
        session.authenticatedAt = Date.now();
      }
      
      this.emit('session-authenticated', {
        sessionId,
        status: 'authenticated',
        timestamp: Date.now()
      });
    });

    // Ready event - WhatsApp fully connected
    client.on('ready', () => {
      logger.info(`✅ Session ${sessionId} is ready and connected`);
      
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = 'ready';
        session.readyAt = Date.now();
        
        // Get WhatsApp info if available
        const info = client.info;
        if (info) {
          session.phoneNumber = info.wid?.user;
          session.platform = info.platform;
          logger.info(`📱 Connected: ${info.pushname} (${info.wid?.user})`);
        }
      }
      
      this.emit('session-ready', {
        sessionId,
        status: 'ready',
        info: client.info,
        timestamp: Date.now()
      });
    });

    // Disconnected event
    client.on('disconnected', async (reason) => {
      logger.warn(`🔌 Session ${sessionId} disconnected: ${reason}`);
      
      // Update session status
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = 'disconnected';
      }
      
      this.emit('disconnected', { sessionId, reason, status: 'disconnected' });
    });

    // Auth failure event
    client.on('auth_failure', async (error) => {
      logger.error(`❌ Authentication failed for ${sessionId}:`, error);
      this.clearQRTimeout(sessionId);
      
      // Clear stored auth data for fresh retry
      try {
        const authPath = path.join(this.authDir, `session-${sessionId}`);
        await fs.rm(authPath, { recursive: true, force: true });
        logger.info(`🗑️ Cleared auth data for ${sessionId}`);
      } catch (err) {
        logger.error('Error clearing auth data:', err);
      }
      
      this.emit('auth-failure', {
        sessionId,
        error: error?.message || 'Authentication failed',
        canRetry: true
      });
      
      // Clean up failed session
      await this.disconnectSession(sessionId);
    });

    // Message event
    client.on('message', async (message) => {
      logger.info(`📨 New message in session ${sessionId}: ${message.body.substring(0, 50)}`);
      this.emit('message', { sessionId, message });
    });
    
    // Loading screen event
    client.on('loading_screen', (percent, message) => {
      logger.info(`⏳ Loading ${sessionId}: ${percent}% - ${message}`);
    });
  }

  /**
   * Get existing session
   */
  async getSession(sessionId) {
    const client = this.sessions.get(sessionId);
    const status = client?.status;
    
    return { client, status };
  }

  /**
   * Get QR code for session
   */
  async getQR(sessionId) {
    const qrData = this.qrCodes.get(sessionId);
    
    if (!qrData) {
      // Check if session exists and try to regenerate
      const session = this.sessions.get(sessionId);
      if (session && session.status === 'initializing') {
        logger.info(`⏳ Waiting for QR generation for ${sessionId}`);
        return {
          success: false,
          message: 'QR code is being generated, please wait',
          status: 'generating'
        };
      }
      
      return {
        success: false,
        message: 'No QR code available',
        status: 'not_found'
      };
    }
    
    // Check if QR is expired
    const age = Date.now() - qrData.timestamp;
    if (age > this.QR_TIMEOUT) {
      this.qrCodes.delete(sessionId);
      return {
        success: false,
        message: 'QR code expired',
        status: 'expired'
      };
    }
    
    return {
      success: true,
      qr: qrData.qr,
      qrDataUrl: qrData.qrDataUrl,
      age: Math.floor(age / 1000),
      expiresIn: Math.floor((this.QR_TIMEOUT - age) / 1000),
      retryCount: qrData.retryCount || 1,
      status: 'active'
    };
  }

  /**
   * Get session status
   */
  async getSessionStatus(sessionId) {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return {
        success: false,
        status: 'not_found',
        message: 'Session not found'
      };
    }
    
    const qrData = this.qrCodes.get(sessionId);
    
    return {
      success: true,
      sessionId,
      status: session.status || 'unknown',
      hasQR: !!qrData,
      info: {
        authenticatedAt: session.authenticatedAt,
        readyAt: session.readyAt,
        phoneNumber: session.phoneNumber,
        platform: session.platform
      }
    };
  }

  /**
   * Send message
   */
  async sendMessage(sessionId, to, message) {
    try {
      const session = this.sessions.get(sessionId);
      
      if (!session || session.status !== 'ready') {
        throw new Error('Session not ready');
      }
      
      // Format phone number
      const chatId = to.includes('@') ? to : `${to}@c.us`;
      
      // Send message
      const result = await session.sendMessage(chatId, message);
      
      logger.info(`📤 Message sent from ${sessionId} to ${to}`);
      
      return {
        success: true,
        messageId: result.id,
        timestamp: result.timestamp
      };
    } catch (error) {
      logger.error(`Error sending message from ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Disconnect session
   */
  async disconnectSession(sessionId) {
    try {
      logger.info(`🔌 Disconnecting session ${sessionId}`);
      
      const session = this.sessions.get(sessionId);
      
      if (session && session.destroy) {
        // Remove all listeners to prevent memory leaks
        session.removeAllListeners();
        
        // Destroy WhatsApp client
        await session.destroy().catch(err => {
          logger.error(`Error destroying client ${sessionId}:`, err);
        });
      }
      
      // Clean up memory
      this.sessions.delete(sessionId);
      this.qrCodes.delete(sessionId);
      this.clearQRTimeout(sessionId);
      
      logger.info(`✅ Session ${sessionId} destroyed successfully`);
      
      return {
        success: true,
        message: `Session ${sessionId} disconnected`
      };
      
    } catch (error) {
      logger.error(`❌ Failed to destroy session ${sessionId}:`, error);
      // Still clean up even if destroy fails
      this.sessions.delete(sessionId);
      this.qrCodes.delete(sessionId);
      this.clearQRTimeout(sessionId);
      
      return {
        success: false,
        message: error.message
      };
    }
  }

  /**
   * Set QR timeout
   */
  setQRTimeout(sessionId) {
    // Clear existing timeout if any
    this.clearQRTimeout(sessionId);
    
    // Set new timeout
    const timeout = setTimeout(() => {
      const qrData = this.qrCodes.get(sessionId);
      if (qrData && qrData.retryCount < 3) {
        // Try to regenerate QR
        logger.info(`🔄 Attempting to regenerate QR for ${sessionId}`);
        const session = this.sessions.get(sessionId);
        if (session && session.initialize) {
          session.initialize().catch(err => {
            logger.error('Failed to reinitialize client:', err);
          });
        }
      } else {
        logger.warn(`⏰ QR code expired for session ${sessionId}`);
        this.qrCodes.delete(sessionId);
        
        this.emit('qr-expired', {
          sessionId,
          message: 'QR code expired after multiple attempts'
        });
      }
    }, this.QR_TIMEOUT);
    
    this.sessionTimeouts.set(sessionId, timeout);
  }
  
  /**
   * Clear QR timeout
   */
  clearQRTimeout(sessionId) {
    const timeout = this.sessionTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.sessionTimeouts.delete(sessionId);
    }
  }
  
  /**
   * Cleanup all sessions
   */
  async cleanup() {
    logger.info('🧹 Cleaning up all WhatsApp sessions...');
    
    for (const [sessionId, session] of this.sessions) {
      try {
        if (session && session.destroy) {
          await session.destroy();
        }
      } catch (error) {
        logger.error(`Error cleaning up session ${sessionId}:`, error);
      }
    }
    
    // Clear all maps
    this.sessions.clear();
    this.qrCodes.clear();
    
    // Clear all timeouts
    for (const timeout of this.sessionTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.sessionTimeouts.clear();
    
    logger.info('✅ All sessions cleaned up');
  }

  /**
   * Get all sessions with status
   */
  async getAllSessions() {
    const sessions = [];
    
    for (const [sessionId, session] of this.sessions.entries()) {
      const qrData = this.qrCodes.get(sessionId);
      sessions.push({
        id: sessionId,
        status: qrData ? 'waiting_qr' : 'ready',
        hasQR: this.qrCodes.has(sessionId)
      });
    }
    
    return sessions;
  }

}

module.exports = SimpleWhatsAppService;
