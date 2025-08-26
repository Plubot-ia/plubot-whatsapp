import axios from 'axios';

import logger from './logger.js';

const PYTHON_BACKEND_URL = process.env.PYTHON_BACKEND_URL || 'http://127.0.0.1:5000';
const PYTHON_API_KEY = process.env.PYTHON_API_KEY || 'internal-api-key';

/**
 *
 * @param messageData
 */
const sendMessageToPython = async (messageData) => {
  try {
    const {
      sessionId,
      userId,
      plubotId,
      fromNumber,
      toNumber,
      message,
      timestamp,
      messageId,
      isGroup,
      hasMedia,
    } = messageData;

    const response = await axios.post(
      `${PYTHON_BACKEND_URL}/api/whatsapp/process-message`,
      {
        sessionId,
        userId,
        plubotId,
        from: fromNumber,
        to: toNumber,
        message,
        timestamp,
        messageId,
        isGroup,
        hasMedia,
        type: messageData.type,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': PYTHON_API_KEY,
        },
        timeout: 30_000, // 30 seconds timeout
      },
    );

    return response.data;
  } catch (error) {
    logger.error('Failed to send message to Python backend:', error);

    // Return a default response if backend is unavailable
    if (error.code === 'ECONNREFUSED') {
      return {
        reply: 'El servicio está temporalmente no disponible. Por favor, intenta más tarde.',
        error: true,
      };
    }

    throw error;
  }
};

/**
 *
 * @param statusData
 */
const updateSessionStatus = async (statusData) => {
  try {
    const { sessionId, status, timestamp } = statusData;

    await axios.post(
      `${PYTHON_BACKEND_URL}/api/whatsapp/session-status`,
      {
        sessionId,
        status,
        timestamp,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': PYTHON_API_KEY,
        },
      },
    );
  } catch (error) {
    logger.error('Failed to notify session status to Python backend:', error);
  }
};

/**
 *
 * @param plubotId
 */
const getFlowData = async (plubotId) => {
  try {
    const response = await axios.get(`${PYTHON_BACKEND_URL}/api/plubots/${plubotId}/flow`, {
      headers: {
        'X-API-Key': PYTHON_API_KEY,
      },
    });

    return response.data;
  } catch (error) {
    logger.error(`Failed to get flow data for plubot ${plubotId}:`, error);
    throw error;
  }
};

export { sendMessageToPython, updateSessionStatus, getFlowData };
