import express from 'express';

import { getInstance as getFlowExecutor } from '../services/FlowExecutor.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Validate sync request body
 * @param {Object} body - Request body
 * @returns {Object|null} - Validation error or null
 */
const validateSyncRequest = (body) => {
  const { userId, plubotId } = body;

  if (!userId || !plubotId) {
    return {
      status: 400,
      error: 'userId and plubotId are required',
    };
  }

  return null;
};

/**
 * Update active WhatsApp session with flow data
 * @param {Object} req - Express request
 * @param {string} sessionId - Session ID
 * @param {Array} nodes - Flow nodes
 * @param {Array} edges - Flow edges
 */
const updateActiveSession = (req, sessionId, nodes, edges) => {
  const manager = req.whatsappManager;

  if (manager && manager.sessions && manager.sessions.has(sessionId)) {
    manager.updateFlowData(sessionId, nodes, edges);
    logger.info(`Flow data updated for active WhatsApp session ${sessionId}`);
  }
};

// Sync flow data endpoint
router.post('/sync', (req, res) => {
  try {
    const validationError = validateSyncRequest(req.body);

    if (validationError) {
      return res.status(validationError.status).json({
        success: false,
        error: validationError.error,
      });
    }

    const { userId, plubotId, nodes, edges } = req.body;
    const sessionId = `${userId}-${plubotId}`;

    // Store flow data using FlowExecutor
    const flowExecutor = getFlowExecutor();
    flowExecutor.setFlowData(sessionId, nodes, edges);

    logger.info(`Flow data synced for session ${sessionId}`, {
      nodeCount: nodes?.length || 0,
      edgeCount: edges?.length || 0,
    });

    // Update WhatsApp manager if session exists
    updateActiveSession(req, sessionId, nodes, edges);

    return res.json({
      success: true,
      message: 'Flow data synchronized successfully',
      nodeCount: nodes?.length || 0,
      edgeCount: edges?.length || 0,
    });
  } catch (error) {
    logger.error('Error syncing flow data:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to sync flow data',
    });
  }
});

// Get flow data for a session
router.get('/:userId/:plubotId', (req, res) => {
  try {
    const { userId, plubotId } = req.params;
    const sessionId = `${userId}-${plubotId}`;

    const flowExecutor = getFlowExecutor();
    const flowData = flowExecutor.getFlowData(sessionId);

    if (!flowData) {
      return res.status(404).json({
        success: false,
        error: 'No flow data found for this session',
      });
    }

    return res.json({
      success: true,
      flowData,
    });
  } catch (error) {
    logger.error('Error getting flow data:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get flow data',
    });
  }
});

export default router;
