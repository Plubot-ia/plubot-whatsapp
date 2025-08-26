import express from 'express';

import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Get session status endpoint
 * Returns the current status of a WhatsApp session
 */
router.get('/api/sessions/:sessionId/status', async (req, res) => {
  const { sessionId } = req.params;

  try {
    const manager = req.app.get('whatsappManager');

    // Check if session exists in memory
    const session = manager.getSession(sessionId);

    if (!session) {
      // Check if session exists on disk (persisted)
      const sessionPath = `./sessions/session-${sessionId}`;
      const fs = await import('node:fs/promises');

      try {
        await fs.access(sessionPath);

        // Session exists on disk, try to restore it
        logger.info(`Found persisted session ${sessionId}, attempting restore`);

        const restoredSession = await manager.restoreSession(sessionId);

        if (restoredSession && restoredSession.status === 'ready') {
          return res.json({
            exists: true,
            status: 'authenticated',
            phoneNumber: restoredSession.phoneNumber || null,
            needsReconnection: false,
          });
        }

        return res.json({
          exists: true,
          status: 'disconnected',
          needsReconnection: true,
        });
      } catch {
        // Session doesn't exist
        return res.json({
          exists: false,
          status: 'not_found',
        });
      }
    }

    // Session exists in memory
    const status = {
      exists: true,
      status: session.status,
      isReady: session.isReady,
      phoneNumber: session.phoneNumber || null,
      connectionState: session.connectionState,
      lastActive: session.lastActive || session.createdAt,
    };

    // Determine if session is authenticated
    if (session.status === 'ready' || session.status === 'authenticated') {
      status.status = 'authenticated';
      status.needsReconnection = false;
    } else if (session.status === 'disconnected') {
      status.needsReconnection = true;
    }

    res.json(status);
  } catch (error) {
    logger.error(`Error getting session status for ${sessionId}:`, error);
    res.status(500).json({
      error: 'Failed to get session status',
      message: error.message,
    });
  }
});

/**
 * Reconnect a disconnected session
 */
router.post('/api/sessions/:sessionId/reconnect', async (req, res) => {
  const { sessionId } = req.params;

  try {
    const manager = req.app.get('whatsappManager');

    // Attempt to restore and reconnect
    const session = await manager.restoreSession(sessionId);

    if (!session) {
      return res.status(404).json({
        error: 'Session not found',
        message: 'No persisted session data found',
      });
    }

    res.json({
      success: true,
      status: session.status,
      message: 'Reconnection initiated',
    });
  } catch (error) {
    logger.error(`Error reconnecting session ${sessionId}:`, error);
    res.status(500).json({
      error: 'Failed to reconnect session',
      message: error.message,
    });
  }
});

export default router;
