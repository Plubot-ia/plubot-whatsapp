import express from 'express';

import { authenticateRequest } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Check if session is ready
 * @param {Object} whatsappManager - Whatsapp manager object
 * @param {string} sessionId - Session ID
 * @returns {Object|null} - Response if ready, null otherwise
 */
const checkSessionReady = (whatsappManager, sessionId) => {
  const session = whatsappManager.getSession(sessionId);
  if (session && session.status === 'ready') {
    logger.info('Session is ready, returning connected status');
    return {
      success: true,
      status: 'already_connected',
      phoneNumber: session.phoneNumber,
    };
  }
  return null;
};

/**
 * Get QR code from Redis
 * @param {Object} redis - Redis client
 * @param {string} userId - User ID
 * @returns {Promise<Object|null>} - QR data or null
 */
const getRedisQR = async (redis, userId) => {
  logger.info(`Checking Redis for QR with key: qr:${userId}`);
  const qrData = await redis.get(`qr:${userId}`);

  if (qrData) {
    logger.info('QR found in Redis, returning it');
    return JSON.parse(qrData);
  }

  logger.info('QR not found in Redis');
  return null;
};

/**
 * Wait for QR code to be available in Redis
 * @param {Object} redis - Redis client
 * @param {string} sessionId - Session ID
 * @returns {Promise<Object|null>} - QR data or null
 */
const waitForQR = (redis, sessionId, maxAttempts = 30, delay = 1000) => {
  const checkQR = async (attempt) => {
    if (attempt >= maxAttempts) {
      return null;
    }

    const qrData = await getRedisQR(redis, sessionId);
    if (qrData) {
      return qrData;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, delay);
    });

    return checkQR(attempt + 1);
  };

  return checkQR(0);
};

// Helper to check session and return early response if ready
const checkAndReturnIfReady = (whatsappManager, sessionId) => {
  const sessionData = checkSessionReady(whatsappManager, sessionId);
  if (sessionData) {
    return {
      success: true,
      status: 'ready',
      message: 'Session is already authenticated',
      ...sessionData,
    };
  }
  return null;
};

// Helper function to handle QR generation logic
/**
 * Process QR data response
 * @private
 */
function processQRResponse(res, qrData, qrDataUrl, status) {
  const response = {
    success: true,
    qr: qrData,
    qrDataUrl,
    status: status || 'waiting_qr',
  };

  res.status(200).json(response);
}

/**
 * Handle QR timeout
 * @private
 */
async function handleQRTimeout(redis, sessionId) {
  // First check if QR already exists in Redis
  const existingQR = await getRedisQR(redis, sessionId);
  if (existingQR) {
    const { qrData } = existingQR;
    const { qrDataUrl } = existingQR;
    return { qrData, qrDataUrl };
  }

  // If not, wait for it
  const qrInfo = await waitForQR(redis, sessionId, 30, 1000);
  if (!qrInfo) {
    return null;
  }
  const { qrData } = qrInfo;
  const { qrDataUrl } = qrInfo;
  return { qrData, qrDataUrl };
}

async function handleQRGeneration(req, res) {
  const { sessionId } = res.locals;
  const whatsappManager = req.whatsappManager || req.app.locals.whatsappManager;
  const redis = whatsappManager?.redis;

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: 'Session ID is required',
    });
  }

  logger.info(`Getting QR code for session: ${sessionId}`);

  // Check if session is already ready
  const earlyReturn = await checkAndReturnIfReady(whatsappManager, sessionId);
  if (earlyReturn) {
    return res.status(200).json(earlyReturn);
  }

  // Wait for QR with timeout
  const timeoutResult = await handleQRTimeout(redis, sessionId);

  if (!timeoutResult) {
    return res.status(408).json({
      success: false,
      error: 'QR code generation timeout',
    });
  }

  return processQRResponse(res, timeoutResult.qrData, timeoutResult.qrDataUrl, 'waiting_qr');
}

// Helper to check existing QR
function checkExistingQR(whatsappManager, redis, sessionId) {
  const session = whatsappManager.getSession(sessionId);
  if (session?.qr) {
    return { qrData: session.qr, qrDataUrl: null };
  }
  return getRedisQR(redis, sessionId);
}

// Helper to handle QR response
async function handleQRResponse(req, res) {
  const { userId, plubotId } = req.params;
  const sessionId = `${userId}-${plubotId}`;
  const { whatsappManager } = req.app.locals;
  const redis = whatsappManager?.redis;

  logger.info(`Getting QR code for session: ${sessionId}`);

  // Check if session is already ready
  const earlyReturn = checkAndReturnIfReady(whatsappManager, sessionId);
  if (earlyReturn) {
    return res.status(200).json(earlyReturn);
  }

  // Check for existing QR
  const existingQR = await checkExistingQR(whatsappManager, redis, sessionId);
  if (existingQR) {
    return processQRResponse(res, existingQR.qrData, existingQR.qrDataUrl, 'waiting_qr');
  }

  // Start new session and wait for QR
  return startNewSessionAndWaitForQR(whatsappManager, redis, sessionId, res);
}

// Helper to start new session and wait for QR
async function startNewSessionAndWaitForQR(whatsappManager, redis, sessionId, res) {
  logger.info(`Starting new session for ${sessionId}`);
  try {
    // Parse sessionId to extract userId and plubotId
    const parts = sessionId.split('-');
    if (parts.length >= 2) {
      const userId = parts.slice(0, -1).join('-');
      const plubotId = parts[parts.length - 1];
      await whatsappManager.createSession(userId, plubotId);
    } else {
      // Fall back to using getOrCreateSessionById if available
      await whatsappManager.getOrCreateSessionById(sessionId);
    }
    logger.info(`Session created, waiting for QR for ${sessionId}`);
  } catch (error) {
    logger.error(`Failed to create session ${sessionId}:`, error);
    return res.status(500).json({
      success: false,
      error: 'Failed to create session',
    });
  }

  // Wait for QR with timeout
  const timeoutResult = await handleQRTimeout(redis, sessionId);

  if (!timeoutResult) {
    return res.status(408).json({
      success: false,
      error: 'QR code generation timeout',
    });
  }

  return processQRResponse(res, timeoutResult.qrData, timeoutResult.qrDataUrl, 'waiting_qr');
}

// Get QR code for a session by userId and plubotId (more specific route first)
// Temporarily disabled auth for debugging
router.get('/:userId/:plubotId', handleQRResponse);

// Get QR code for a session by sessionId (less specific route last)
// Temporarily disabled auth for debugging
router.get('/:sessionId', handleQRGeneration);

export default router;
