import qrcode from 'qrcode';

import logger from '../utils/logger.js';
import { sendMessageToPython, updateSessionStatus } from '../utils/pythonConnector.js';

import { getInstance as getFlowExecutor } from './FlowExecutor.js';

/**
 * Setup QR code handler
 * @param {Object} client - WhatsApp client instance
 * @param {string} sessionId - Session identifier
 * @param {Object} session - Session object
 * @param {Object} redis - Redis client instance
 * @param {Object} manager - WhatsApp manager instance
 */
const setupQRHandler = (client, sessionId, session, manager) => {
  const { redis } = manager;
  let qrCount = 0;
  const handleQR = async (qr) => {
    qrCount++;
    logger.info(`QR Code generated for session ${sessionId} (attempt ${qrCount})`);

    // Update session with new status
    const updatedSession = { ...session, status: 'waiting_qr' };
    Object.assign(session, updatedSession);

    // Generate QR code as data URL
    let qrDataUrl = null;
    try {
      qrDataUrl = await qrcode.toDataURL(qr);
      Object.assign(session, { qrDataUrl });
    } catch (error) {
      logger.error(`Failed to generate QR data URL for session ${sessionId}:`, error);
    }

    // Store QR and emit events
    const qrContext = { redis, sessionId, qr, qrDataUrl, manager, qrCount };
    await storeQRAndEmit(qrContext);
  };

  client.on('qr', handleQR);
};

/**
 * Setup authentication handlers
 * @param {Object} client - WhatsApp client instance
 * @param {string} sessionId - Session identifier
 * @param {Object} manager - WhatsApp manager instance
 */
// Helper to store QR and emit events
async function storeQRAndEmit(context) {
  const { redis, sessionId, qr, qrDataUrl, manager, qrCount } = context;
  try {
    const qrData = JSON.stringify({
      qrData: qr,
      qrDataUrl: qrDataUrl || null,
    });
    await redis.setex(`qr:${sessionId}`, 120, qrData);

    // Emit socket event if io is available
    const { io } = manager || {};
    if (io) {
      logger.info(`Emitting QR update to room qr-${sessionId}`);
      io.to(`qr-${sessionId}`).emit('qr-update', {
        sessionId,
        qr,
        status: 'waiting_qr',
        attempt: qrCount,
      });

      // Check for too many attempts
      if (qrCount > 5) {
        logger.warn(`Too many QR attempts for session ${sessionId}`);
        io.to(`qr-${sessionId}`).emit('qr-limit-reached', {
          sessionId,
          message:
            'Demasiados intentos de QR. Por favor, desvincula dispositivos antiguos en WhatsApp.',
        });
      }
    } else {
      logger.warn(`Socket.IO not available for QR update, session ${sessionId}`);
    }

    logger.info(`QR stored for session ${sessionId}`);
  } catch (error) {
    logger.error(`Failed to store QR for session ${sessionId}:`, error);
  }
}

const setupAuthHandlers = (client, sessionId, session, manager) => {
  client.on('authenticated', () => {
    logger.info(`🔐 Session ${sessionId} authenticated!`);

    // Update session status
    const updatedSession = { ...session, status: 'authenticated', isAuthenticated: true };
    Object.assign(session, updatedSession);

    // Emit socket event for authentication
    const { io } = manager || {};
    if (io) {
      const { rooms } = io.sockets.adapter;
      logger.info('📡 Current WebSocket rooms:', [...rooms.keys()]);

      logger.info(`📤 Emitting session-authenticated to room qr-${sessionId}`);
      io.to(`qr-${sessionId}`).emit('session-authenticated', {
        sessionId,
        status: 'authenticated',
      });

      // Also emit to global channel
      logger.info('🌍 Emitting global session-authenticated event');
      io.emit('session-authenticated', {
        sessionId,
        status: 'authenticated',
      });

      // Log connected sockets
      const connectedSockets = manager.io.sockets.sockets;
      logger.info(`🔌 Connected sockets: ${connectedSockets.size}`);
    } else {
      logger.warn(`⚠️ Socket.IO not available for authenticated event, session ${sessionId}`);
    }
  });

  client.on('auth_failure', (message) => {
    logger.error(`Authentication failed for session ${sessionId}:`, message);
    // eslint-disable-next-line no-param-reassign
    session.status = 'auth_failed';
    // eslint-disable-next-line no-param-reassign
    session.error = message;

    // Emit auth failure event
    if (manager && manager.io) {
      logger.info(`Emitting auth-failed to room qr-${sessionId}`);
      manager.io.to(`qr-${sessionId}`).emit('auth-failed', {
        sessionId,
        status: 'auth_failed',
        error: message,
      });
    }
  });

  client.on('disconnected', async (reason) => {
    logger.info(`Session ${sessionId} disconnected: ${reason}`);
    // eslint-disable-next-line no-param-reassign
    session.status = 'disconnected';

    // Notify Python backend
    await updateSessionStatus({
      sessionId,
      status: 'disconnected',
      timestamp: new Date().toISOString(),
    });

    // Attempt reconnection
    if (reason !== 'LOGOUT') {
      // Handle reconnection if manager is available
      // await manager.handleReconnection(sessionId);
    }
  });
};

/**
 * Setup ready handler
 * @param {Object} client - WhatsApp client instance
 * @param {string} sessionId - Session identifier
 * @param {Object} session - Session object
 * @param {Object} manager - WhatsApp manager instance
 */
const setupReadyHandler = (client, sessionId, session, manager) => {
  client.on('ready', () => {
    logger.info(`WhatsApp client ready for session ${sessionId}`);

    // Update session status
    const { info } = client;
    const phoneNumber = info?.wid?.user || null;
    const updatedSession = {
      ...session,
      isReady: true,
      status: 'ready',
      phoneNumber,
    };
    Object.assign(session, updatedSession);

    // Emit socket event for ready status
    const { io } = manager || {};
    if (io) {
      logger.info(`Emitting session-ready to room qr-${sessionId}`);
      io.to(`qr-${sessionId}`).emit('session-ready', {
        sessionId,
        status: 'ready',
        phoneNumber: session.phoneNumber,
      });

      // Also emit to global channel
      logger.info('Emitting global session-ready event');
      io.emit('session-ready', {
        sessionId,
        status: 'ready',
        phoneNumber: session.phoneNumber,
      });
    } else {
      logger.warn(`Socket.IO not available for ready event, session ${sessionId}`);
    }
  });
};

/**
 * Setup message handler
 * @param {Object} client - WhatsApp client instance
 * @param {string} sessionId - Session identifier
 * @param {Object} manager - WhatsApp manager instance
 */
const setupMessageHandlers = (client, sessionId) => {
  // Message handler
  client.on('message', async (message) => {
    logger.info(
      `Incoming WhatsApp message for session ${sessionId} from ${message.from}: ${message.body}`,
    );

    try {
      // Extract user and plubot IDs from session ID
      const [userId, plubotId] = sessionId.split('-');

      // Execute flow logic
      const flowExecutor = getFlowExecutor();
      const flowResponse = await flowExecutor.executeFlow(sessionId, message.body);

      if (flowResponse && flowResponse.text) {
        // Send automated response
        await message.reply(flowResponse.text);
        logger.info(`Sent flow response for session ${sessionId}: ${flowResponse.text}`);
      }

      // Send to Python backend for processing
      const messageData = {
        sessionId,
        userId,
        plubotId,
        fromNumber: message.from,
        toNumber: message.to,
        message: message.body,
        timestamp: message.timestamp,
        messageId: message.id._serialized,
        isGroup: message.isGroupMsg,
        hasMedia: message.hasMedia,
        type: message.type,
      };

      const response = await sendMessageToPython(messageData);

      if (response && response.reply && !flowResponse) {
        await message.reply(response.reply);
        logger.info(`Sent Python backend response for session ${sessionId}`);
      }
    } catch (error) {
      logger.error(`Error processing message for session ${sessionId}:`, error);
    }
  });
};

/**
 * Setup state change handler
 * @param {Object} client - WhatsApp client instance
 * @param {string} sessionId - Session identifier
 * @param {Object} session - Session object
 */
const setupStateChangeHandler = (client, sessionId, session) => {
  client.on('change_state', (state) => {
    logger.info(`Session ${sessionId} state changed to: ${state}`);
    // eslint-disable-next-line no-param-reassign
    session.connectionState = state;
  });
};

/**
 * Setup loading screen handler
 * @param {Object} client - WhatsApp client instance
 * @param {string} sessionId - Session identifier
 */
const setupLoadingScreenHandler = (client, sessionId) => {
  client.on('loading_screen', (percent, message) => {
    logger.info(`Session ${sessionId} loading: ${percent}% - ${message}`);
  });
};

/**
 * Setup connection handlers
 * @param {Object} client - WhatsApp client instance
 * @param {string} sessionId - Session identifier
 * @param {Object} session - Session object
 * @param {Object} manager - WhatsApp manager instance
 */
const setupConnectionHandlers = (client, sessionId, session, manager) => {
  client.on('disconnected', (reason) => {
    logger.info(`Session ${sessionId} disconnected: ${reason}`);
    // eslint-disable-next-line no-param-reassign
    session.status = 'disconnected';
    // eslint-disable-next-line no-param-reassign
    session.isReady = false;

    // Emit socket event for disconnection
    if (manager && manager.io) {
      logger.info(`Emitting disconnected to room qr-${sessionId}`);
      manager.io.to(`qr-${sessionId}`).emit('disconnected', {
        sessionId,
        status: 'disconnected',
        reason,
      });
    }
  });
};

/**
 * Setup all event handlers for a WhatsApp client
 * @param {Object} client - WhatsApp client instance
 * @param {string} sessionId - Session identifier
 * @param {Object} session - Session object
 * @param {Object} redis - Redis client instance
 * @param {Object} manager - WhatsApp manager instance
 */
const setupHandlers = (client, sessionId, session, manager) => {
  setupQRHandler(client, sessionId, session, manager);
  setupAuthHandlers(client, sessionId, session, manager);
  setupReadyHandler(client, sessionId, session, manager);
  setupMessageHandlers(client, sessionId);
  setupLoadingScreenHandler(client, sessionId);
  setupConnectionHandlers(client, sessionId, session, manager);
};

export {
  setupHandlers,
  setupQRHandler,
  setupAuthHandlers,
  setupReadyHandler,
  setupMessageHandlers,
  setupStateChangeHandler,
  setupLoadingScreenHandler,
  setupConnectionHandlers,
};
