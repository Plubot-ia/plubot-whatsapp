import { makeWASocket, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import logger from '../utils/logger.js';
import crypto from 'crypto';

class SessionManager {
  constructor(redisClient, io) {
    this.sessions = new Map();
    this.redis = redisClient;
    this.io = io;
    this.maxSessions = process.env.SESSION_POOL_SIZE || 100;
    this.sessionTimeout = parseInt(process.env.SESSION_TIMEOUT) || 300000;
  }

  /**
   * Create or get existing session
   */
  async createSession(sessionId, forceNew = false) {
    try {
      logger.info('Creating WhatsApp session', { sessionId, forceNew });

      // Check if session exists and force new if requested
      if (this.sessions.has(sessionId)) {
        if (forceNew) {
          await this.destroySession(sessionId);
        } else {
          const existingSession = this.sessions.get(sessionId);
          if (existingSession.status === 'connected') {
            return {
              status: 'already_connected',
              sessionId
            };
          }
        }
      }

      // Check pool size
      if (this.sessions.size >= this.maxSessions) {
        await this.evictOldestSession();
      }

      // Create new session
      const session = await this.initializeSession(sessionId);
      this.sessions.set(sessionId, session);

      // Store in Redis
      await this.redis.setex(
        `session:${sessionId}:status`,
        this.sessionTimeout / 1000,
        'initializing'
      );

      return {
        status: 'initializing',
        sessionId
      };
    } catch (error) {
      logger.error('Failed to create session', { sessionId, error: error.message });
      throw error;
    }
  }

  /**
   * Initialize WhatsApp session
   */
  async initializeSession(sessionId) {
    const { state, saveCreds } = await useMultiFileAuthState(`./auth-sessions/${sessionId}`);
    
    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: [
        process.env.WHATSAPP_BROWSER_NAME || 'Chrome',
        process.env.WHATSAPP_BROWSER_VERSION || '120.0.0.0',
        'Desktop'
      ],
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 2000,
      maxRetries: parseInt(process.env.SESSION_MAX_RETRIES) || 5,
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
    });

    // Setup event handlers
    this.setupEventHandlers(sock, sessionId, saveCreds);

    return {
      sock,
      status: 'initializing',
      qrRetries: 0,
      lastActivity: Date.now(),
      metadata: {
        createdAt: new Date().toISOString(),
        sessionId
      }
    };
  }

  /**
   * Setup event handlers for session
   */
  setupEventHandlers(sock, sessionId, saveCreds) {
    // Connection update
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        await this.handleQRCode(sessionId, qr);
      }

      if (connection === 'close') {
        await this.handleDisconnection(sessionId, lastDisconnect);
      }

      if (connection === 'open') {
        await this.handleConnection(sessionId);
      }
    });

    // Credentials update
    sock.ev.on('creds.update', saveCreds);

    // Messages
    sock.ev.on('messages.upsert', async (m) => {
      await this.handleMessages(sessionId, m);
    });

    // Message status updates
    sock.ev.on('messages.update', async (messages) => {
      await this.handleMessageUpdates(sessionId, messages);
    });

    // Presence updates
    sock.ev.on('presence.update', async (presenceUpdate) => {
      await this.handlePresenceUpdate(sessionId, presenceUpdate);
    });
  }

  /**
   * Handle QR code generation
   */
  async handleQRCode(sessionId, qr) {
    try {
      logger.info('QR code generated', { sessionId });
      
      const session = this.sessions.get(sessionId);
      if (session) {
        session.qrRetries = (session.qrRetries || 0) + 1;
        
        if (session.qrRetries > (parseInt(process.env.SESSION_MAX_QR_RETRIES) || 3)) {
          logger.warn('Max QR retries exceeded', { sessionId });
          await this.destroySession(sessionId);
          return;
        }
      }

      // Store QR in Redis with TTL
      await this.redis.setex(
        `qr:${sessionId}`,
        60, // 60 seconds TTL
        qr
      );

      // Update session status
      await this.redis.setex(
        `session:${sessionId}:status`,
        this.sessionTimeout / 1000,
        'waiting_qr'
      );

      // Emit to WebSocket
      this.io.to(`session-${sessionId}`).emit('qr-update', {
        sessionId,
        qr,
        retries: session?.qrRetries || 1
      });
    } catch (error) {
      logger.error('Failed to handle QR code', { sessionId, error: error.message });
    }
  }

  /**
   * Handle successful connection
   */
  async handleConnection(sessionId) {
    try {
      logger.info('Session connected', { sessionId });
      
      const session = this.sessions.get(sessionId);
      if (session) {
        session.status = 'connected';
        session.qrRetries = 0;
        session.lastActivity = Date.now();
      }

      // Update Redis
      await this.redis.setex(
        `session:${sessionId}:status`,
        this.sessionTimeout / 1000,
        'connected'
      );

      // Clear QR from Redis
      await this.redis.del(`qr:${sessionId}`);

      // Emit to WebSocket
      this.io.to(`session-${sessionId}`).emit('session-ready', {
        sessionId,
        status: 'connected'
      });
    } catch (error) {
      logger.error('Failed to handle connection', { sessionId, error: error.message });
    }
  }

  /**
   * Handle disconnection
   */
  async handleDisconnection(sessionId, lastDisconnect) {
    try {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      
      logger.info('Session disconnected', { 
        sessionId, 
        shouldReconnect,
        reason: lastDisconnect?.error?.output?.payload?.error 
      });

      if (shouldReconnect) {
        // Check if manually disconnected
        const manualDisconnect = await this.redis.get(`session:${sessionId}:manual_disconnect`);
        if (manualDisconnect === 'true') {
          logger.info('Session manually disconnected, not reconnecting', { sessionId });
          await this.destroySession(sessionId);
          return;
        }

        // Attempt reconnection
        setTimeout(() => {
          this.createSession(sessionId, false);
        }, 5000);
      } else {
        await this.destroySession(sessionId);
      }

      // Emit disconnection event
      this.io.to(`session-${sessionId}`).emit('session-disconnected', {
        sessionId,
        shouldReconnect
      });
    } catch (error) {
      logger.error('Failed to handle disconnection', { sessionId, error: error.message });
    }
  }

  /**
   * Handle incoming messages
   */
  async handleMessages(sessionId, upsert) {
    try {
      const messages = upsert.messages;
      const type = upsert.type;

      for (const msg of messages) {
        if (!msg.key.fromMe && type === 'notify') {
          logger.info('Message received', {
            sessionId,
            from: msg.key.remoteJid,
            type: msg.message?.conversation ? 'text' : 'media'
          });

          // Emit to WebSocket
          this.io.to(`session-${sessionId}`).emit('message-received', {
            sessionId,
            message: {
              id: msg.key.id,
              from: msg.key.remoteJid,
              text: msg.message?.conversation || msg.message?.extendedTextMessage?.text,
              timestamp: msg.messageTimestamp,
              type: this.getMessageType(msg.message)
            }
          });

          // Store in Redis for processing
          await this.redis.lpush(
            `messages:${sessionId}:incoming`,
            JSON.stringify({
              id: msg.key.id,
              from: msg.key.remoteJid,
              message: msg.message,
              timestamp: msg.messageTimestamp
            })
          );
        }
      }
    } catch (error) {
      logger.error('Failed to handle messages', { sessionId, error: error.message });
    }
  }

  /**
   * Handle message status updates
   */
  async handleMessageUpdates(sessionId, messages) {
    try {
      for (const update of messages) {
        logger.debug('Message status updated', {
          sessionId,
          messageId: update.key.id,
          status: update.update.status
        });

        // Emit status update
        this.io.to(`session-${sessionId}`).emit('message-status', {
          sessionId,
          messageId: update.key.id,
          status: update.update.status
        });
      }
    } catch (error) {
      logger.error('Failed to handle message updates', { sessionId, error: error.message });
    }
  }

  /**
   * Handle presence updates
   */
  async handlePresenceUpdate(sessionId, presenceUpdate) {
    try {
      logger.debug('Presence update', { sessionId, presenceUpdate });
      
      // Emit presence update
      this.io.to(`session-${sessionId}`).emit('presence-update', {
        sessionId,
        presence: presenceUpdate
      });
    } catch (error) {
      logger.error('Failed to handle presence update', { sessionId, error: error.message });
    }
  }

  /**
   * Send message
   */
  async sendMessage(sessionId, to, message, type = 'text') {
    try {
      const session = this.sessions.get(sessionId);
      
      if (!session || session.status !== 'connected') {
        throw new Error('Session not connected');
      }

      const jid = this.formatJID(to);
      let sentMessage;

      switch (type) {
        case 'text':
          sentMessage = await session.sock.sendMessage(jid, { text: message });
          break;
        case 'image':
          sentMessage = await session.sock.sendMessage(jid, { 
            image: { url: message.mediaUrl }, 
            caption: message.caption 
          });
          break;
        case 'document':
          sentMessage = await session.sock.sendMessage(jid, { 
            document: { url: message.mediaUrl }, 
            fileName: message.fileName 
          });
          break;
        default:
          throw new Error(`Unsupported message type: ${type}`);
      }

      logger.info('Message sent', { sessionId, to: jid, type });
      
      // Update last activity
      session.lastActivity = Date.now();

      return {
        success: true,
        messageId: sentMessage.key.id,
        to: jid,
        timestamp: sentMessage.messageTimestamp
      };
    } catch (error) {
      logger.error('Failed to send message', { sessionId, to, error: error.message });
      throw error;
    }
  }

  /**
   * Disconnect session
   */
  async disconnectSession(sessionId) {
    try {
      const session = this.sessions.get(sessionId);
      
      if (!session) {
        throw new Error('Session not found');
      }

      // Mark as manually disconnected
      await this.redis.setex(
        `session:${sessionId}:manual_disconnect`,
        300, // 5 minutes TTL
        'true'
      );

      // Logout from WhatsApp
      if (session.sock) {
        await session.sock.logout();
      }

      logger.info('Session disconnected', { sessionId });
      
      return { success: true };
    } catch (error) {
      logger.error('Failed to disconnect session', { sessionId, error: error.message });
      throw error;
    }
  }

  /**
   * Destroy session completely
   */
  async destroySession(sessionId) {
    try {
      const session = this.sessions.get(sessionId);
      
      if (session && session.sock) {
        session.sock.ev.removeAllListeners();
        await session.sock.logout().catch(() => {});
      }

      // Remove from memory
      this.sessions.delete(sessionId);

      // Clean Redis
      const keys = await this.redis.keys(`*${sessionId}*`);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }

      logger.info('Session destroyed', { sessionId });
      
      // Emit destruction event
      this.io.to(`session-${sessionId}`).emit('session-destroyed', { sessionId });
      
      return { success: true };
    } catch (error) {
      logger.error('Failed to destroy session', { sessionId, error: error.message });
      throw error;
    }
  }

  /**
   * Get session status
   */
  async getSessionStatus(sessionId) {
    try {
      const session = this.sessions.get(sessionId);
      const redisStatus = await this.redis.get(`session:${sessionId}:status`);
      
      return {
        inMemory: session ? {
          status: session.status,
          lastActivity: session.lastActivity,
          qrRetries: session.qrRetries
        } : null,
        redis: redisStatus,
        connected: session?.sock?.user ? true : false
      };
    } catch (error) {
      logger.error('Failed to get session status', { sessionId, error: error.message });
      throw error;
    }
  }

  /**
   * Evict oldest session when pool is full
   */
  async evictOldestSession() {
    let oldestSession = null;
    let oldestTime = Date.now();

    for (const [id, session] of this.sessions) {
      if (session.lastActivity < oldestTime) {
        oldestTime = session.lastActivity;
        oldestSession = id;
      }
    }

    if (oldestSession) {
      logger.info('Evicting oldest session', { sessionId: oldestSession });
      await this.destroySession(oldestSession);
    }
  }

  /**
   * Format phone number to WhatsApp JID
   */
  formatJID(phoneNumber) {
    // Remove all non-numeric characters
    const cleaned = phoneNumber.replace(/\D/g, '');
    
    // Add @s.whatsapp.net for individual chats
    if (!cleaned.includes('@')) {
      return `${cleaned}@s.whatsapp.net`;
    }
    
    return cleaned;
  }

  /**
   * Get message type
   */
  getMessageType(message) {
    if (message?.conversation || message?.extendedTextMessage) return 'text';
    if (message?.imageMessage) return 'image';
    if (message?.videoMessage) return 'video';
    if (message?.audioMessage) return 'audio';
    if (message?.documentMessage) return 'document';
    if (message?.stickerMessage) return 'sticker';
    if (message?.locationMessage) return 'location';
    if (message?.contactMessage) return 'contact';
    return 'unknown';
  }

  /**
   * Health check for all sessions
   */
  async healthCheck() {
    const results = [];
    
    for (const [sessionId, session] of this.sessions) {
      results.push({
        sessionId,
        status: session.status,
        connected: session.sock?.user ? true : false,
        lastActivity: session.lastActivity,
        uptime: Date.now() - new Date(session.metadata.createdAt).getTime()
      });
    }
    
    return {
      totalSessions: this.sessions.size,
      maxSessions: this.maxSessions,
      utilizationPercent: (this.sessions.size / this.maxSessions) * 100,
      sessions: results
    };
  }
}

export default SessionManager;
