import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

import logger from '../utils/logger.js';

import { setupHandlers } from './WhatsAppHandlers.js';
import { EnhancedWhatsAppHandlers } from './EnhancedWhatsAppHandlers.js';

const DEFAULT_PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
  '--disable-blink-features=AutomationControlled',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--allow-running-insecure-content',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection',
  '--disable-default-apps',
  '--disable-hang-monitor',
  '--hide-scrollbars',
  '--mute-audio',
  '--disable-prompt-on-repost',
  '--metrics-recording-only',
  '--no-default-browser-check',
  '--use-mock-keychain',
];

const RECURSIVE_OPTIONS = { recursive: true, force: true };
const SESSION_PATH_PREFIX = '../../sessions';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Manages WhatsApp session creation and restoration
 */
class WhatsAppSessionManager {
  constructor(manager) {
    this.manager = manager;
    this.redis = manager.redis;
    this.clients = manager.clients;
  }

  /**
   * Create a new WhatsApp session
   * @param {string} sessionId - Session ID
   * @returns {Promise<Object>} Session object
   */
  /**
   * Create WhatsApp client with configuration
   * @private
   */
  createClient(sessionId) {
    const puppeteerConfig = {
      headless: true,
      args: DEFAULT_PUPPETEER_ARGS,
    };
    
    // Use the Chrome executable path from environment if available (for Docker)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    
    return new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: path.join(__dirname, SESSION_PATH_PREFIX),
      }),
      authTimeoutMs: 60_000,
      puppeteer: puppeteerConfig,
    });
  }

  /**
   * Create initial session object
   * @private
   */
  createSessionObject(sessionId, client) {
    return {
      id: sessionId,
      client,
      status: 'initializing',
      isReady: false,
      qr: null,
      qrDataUrl: null,
      error: null,
      connectionState: null,
      createdAt: new Date().toISOString(),
      // Add toJSON method to prevent circular reference when serializing
      toJSON() {
        return {
          id: this.id,
          status: this.status,
          isReady: this.isReady,
          qr: this.qr,
          qrDataUrl: this.qrDataUrl,
          error: this.error,
          connectionState: this.connectionState,
          createdAt: this.createdAt
        };
      }
    };
  }

  /**
   * Initialize client with error handling
   * @private
   */
  async initializeClient(client, session, sessionId) {
    try {
      logger.info(`Starting WhatsApp client initialization for session ${sessionId}`);
      await client.initialize();
      logger.info(`WhatsApp client initialized successfully for session ${sessionId}`);
      return session;
    } catch (error) {
      logger.error(`Failed to initialize WhatsApp client for session ${sessionId}:`, error);
      logger.error('Error stack:', error.stack);
      const errorSession = {
        ...session,
        status: 'error',
        error: error.message,
      };
      this.clients.set(sessionId, errorSession);
      throw error;
    }
  }

  async createSession(sessionId) {
    logger.info(`Creating session for ${sessionId}`);

    // Clean up existing session if it exists
    await this.cleanupExistingSession(sessionId);

    // Clean up orphaned files
    await this.cleanupOrphanedFiles(sessionId);

    // Create and initialize new session
    const session = await this.initializeNewSession(sessionId);
    
    // Return session without client to avoid circular reference
    const { client, ...sessionWithoutClient } = session;
    return sessionWithoutClient;
  }

  async cleanupExistingSession(sessionId) {
    if (this.clients.has(sessionId)) {
      logger.info(`Found existing session ${sessionId}, destroying it first`);
      await this.destroySession(sessionId);
      // Wait for cleanup to complete
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
    }
  }

  async cleanupOrphanedFiles(sessionId) {
    const sessionPath = path.join(__dirname, SESSION_PATH_PREFIX, `session-${sessionId}`);
    try {
      await fs.promises.access(sessionPath);
      logger.info(`Removing session files for ${sessionId}`);
      await fs.promises.rm(sessionPath, RECURSIVE_OPTIONS);
    } catch {
      logger.debug(`Session files not found for ${sessionId}`);
    }
  }

  async initializeNewSession(sessionId, existingSession) {
    const sessionPath = path.join(__dirname, SESSION_PATH_PREFIX, `session-${sessionId}`);
    // Security: sessionPath is constructed from a known prefix and sessionId
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.promises.mkdir(sessionPath, { recursive: true });

    const newClient = this.createClient(sessionId);

    const newSession = {
      id: sessionId,
      status: 'initializing',
      client: newClient,
      createdAt: new Date(),
      qrDataUrl: existingSession?.qrDataUrl || null,
    };

    this.clients.set(sessionId, newSession);
    logger.info(`Setting up handlers for session ${sessionId}`);
    
    // Use enhanced handlers if available
    if (this.manager.enhancedHandlers) {
      this.manager.enhancedHandlers.setupHandlers(newClient, sessionId, newSession);
    } else {
      setupHandlers(newClient, sessionId, newSession, this.manager);
    }

    logger.info(`Initializing WhatsApp client for session ${sessionId}`);
    
    // Add timeout to client initialization
    const initTimeout = 30000; // 30 seconds
    try {
      await Promise.race([
        newClient.initialize(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Client initialization timeout')), initTimeout)
        )
      ]);
      logger.info(`✅ Client initialized successfully for session ${sessionId}`);
    } catch (error) {
      logger.error(`❌ Failed to initialize client for session ${sessionId}:`, error);
      // Set error status but don't throw - let the QR timeout handle it
      newSession.status = 'error';
      newSession.error = error.message;
    }

    // Return session with client for internal use
    // The WhatsAppManager will handle extracting serializable data
    return newSession;
  }

  /**
   * Restore an existing session
   * @param {string} sessionId - Session identifier
   * @returns {Promise<Object>} Session object
   */
  async restoreSession(sessionId) {
    logger.info(`Attempting to restore session ${sessionId}`);

    const sessionPath = path.join(__dirname, '../../sessions', `session-${sessionId}`);

    try {
      await fs.access(sessionPath);
      logger.info(`Session data found for ${sessionId}, restoring...`);
      return await this.createSession(sessionId);
    } catch {
      logger.error(`Failed to restore session ${sessionId}`);
      return null;
    }
  }

  /**
   * Destroy a session
   * @param {string} sessionId - Session ID
   * @returns {Promise<void>}
   */
  async destroySession(sessionId) {
    logger.info(`Destroying session ${sessionId}`);

    const session = this.clients.get(sessionId);
    if (!session) {
      logger.warn(`Session ${sessionId} not found`);
      return false;
    }

    try {
      // Logout from WhatsApp and cleanup browser resources
      if (session.client) {
        try {
          await session.client.logout();
        } catch (logoutError) {
          logger.warn(`Failed to logout session ${sessionId}:`, logoutError.message);
        }
        
        try {
          await session.client.destroy();
          
          // Force kill browser process if it exists
          if (session.client.pupBrowser) {
            const browser = session.client.pupBrowser;
            const pages = await browser.pages();
            await Promise.all(pages.map(page => page.close().catch(() => {})));
            await browser.close();
            
            // Kill the browser process
            const browserProcess = browser.process();
            if (browserProcess && !browserProcess.killed) {
              browserProcess.kill('SIGKILL');
            }
          }
        } catch (destroyError) {
          logger.warn(`Failed to destroy client for session ${sessionId}:`, destroyError.message);
        }
      }

      // Remove from memory
      this.clients.delete(sessionId);

      // Clean up session files
      await this.cleanupSessionFiles(sessionId);

      // Remove from Redis (all related keys)
      const keysToDelete = [
        `session:${sessionId}`,
        `qr:${sessionId}`,
        `session_meta:${sessionId}`,
        `flow:${sessionId}`
      ];
      await this.redis.del(keysToDelete);
      await this.redis.sRem('active_sessions', sessionId);

      logger.info(`Session ${sessionId} destroyed successfully with full cleanup`);
      return true;
    } catch (error) {
      logger.error(`Error destroying session ${sessionId}:`, error);
      
      // Force cleanup even on error
      this.clients.delete(sessionId);
      await this.cleanupSessionFiles(sessionId).catch(() => {});
      
      return false;
    }
  }

  async cleanupOrphanedSession(sessionId) {
    logger.warn(`Session ${sessionId} not found in memory`);
    const wwebjsPath = path.join(__dirname, '../../.wwebjs_auth', `session-${sessionId}`);
    try {
      await fs.promises.access(wwebjsPath);
      logger.info(`Removing .wwebjs_auth files for ${sessionId}`);
      await fs.promises.rm(wwebjsPath, RECURSIVE_OPTIONS);
    } catch {
      // File doesn't exist, which is fine
    }
    await this.redis.del(`qr:${sessionId}`).catch(() => {});
  }

  async destroyClient(session, sessionId) {
    if (!session.client) return;

    try {
      const state = await session.client.getState();
      if (state === 'CONNECTED') {
        logger.info(`Logging out session ${sessionId}`);
        await session.client.logout();
        await new Promise((resolve) => {
          setTimeout(resolve, 2000);
        });
      }
    } catch (logoutError) {
      logger.warn(`Could not logout session ${sessionId}:`, logoutError.message);
    }

    logger.info(`Destroying client for session ${sessionId}`);
    await session.client.destroy();
  }

  async cleanupSessionFiles(sessionId) {
    const sessionPath = path.join(__dirname, SESSION_PATH_PREFIX, `session-${sessionId}`);
    try {
      await fs.promises.access(sessionPath);
      logger.info(`Removing session files for ${sessionId}`);
      await fs.promises.rm(sessionPath, RECURSIVE_OPTIONS);
    } catch {
      // File doesn't exist, which is fine
    }
  }

  async cleanupRedisData(sessionId) {
    try {
      await this.redis.del(`qr:${sessionId}`);
      logger.info(`Cleared QR cache for session ${sessionId}`);
    } catch (redisError) {
      logger.warn(`Could not clear Redis QR for session ${sessionId}:`, redisError.message);
    }
  }

  async cleanupWwebjsCache() {
    const wwebjsCachePath = path.join(__dirname, '../../.wwebjs_cache');
    try {
      await fs.promises.access(wwebjsCachePath);
      await fs.promises.rm(wwebjsCachePath, RECURSIVE_OPTIONS);
    } catch {
      // File doesn't exist, which is fine
    }
  }

  /**
   * Handle session reconnection
   * @param {string} sessionId - Session identifier
   */
  async handleReconnection(sessionId) {
    const maxAttempts = Number.parseInt(process.env.MAX_RECONNECT_ATTEMPTS) || 3;
    const currentAttempts = this.manager.reconnectAttempts.get(sessionId) || 0;

    if (currentAttempts >= maxAttempts) {
      logger.error(`Max reconnection attempts reached for session ${sessionId}`);
      await this.destroySession(sessionId);
      return;
    }

    this.manager.reconnectAttempts.set(sessionId, currentAttempts + 1);
    const delay = Number.parseInt(process.env.RECONNECT_DELAY_MS) || 5000;

    logger.info(
      `Attempting reconnection ${currentAttempts + 1}/${maxAttempts} for session ${sessionId}`,
    );

    // Update Redis with reconnection status
    await this.redis.setex(
      `session:${sessionId}`,
      604_800, // 7 days
      JSON.stringify({
        status: 'reconnecting',
        attempt: currentAttempts + 1,
        maxAttempts,
        timestamp: new Date().toISOString(),
      }),
    );

    setTimeout(async () => {
      const session = this.clients.get(sessionId);
      if (session && session.status === 'disconnected') {
        try {
          await session.client.initialize();
          logger.info(`Reconnection successful for session ${sessionId}`);
        } catch (error) {
          logger.error(`Reconnection failed for session ${sessionId}:`, error);
          await this.handleReconnection(sessionId);
        }
      }
    }, delay);
  }
}

export default WhatsAppSessionManager;
