/**
 * Sessions Routes V2
 * Clean API endpoints with proper DTOs and error handling
 */

import { Router } from 'express';
import logger from '../utils/logger.js';
import whatsappManager from '../services/WhatsAppManager.js';
import { authenticateRequest } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validation.js';
import rateLimiter from '../middleware/rateLimiterMiddleware.js';
import { SessionCreateResponseDTO, SessionListResponseDTO } from '../dto/SessionDTO.js';

const router = Router();

// Apply middleware
// router.use(authenticateRequest);
// router.use(rateLimiter);

// Test route
router.get('/test', (req, res) => {
  res.json({ message: 'Sessions router is working' });
});

/**
 * Create new session
 * POST /api/sessions/create
 */
router.post('/create', async (req, res) => {
  const { userId, plubotId } = req.body;
  
  try {
    logger.info(`Creating session for user: ${userId}, plubot: ${plubotId}`);
    
    // Create session using manager (returns clean DTO)
    const response = await whatsappManager.createSession(userId, plubotId);
    
    // Response is already a clean DTO, safe to serialize
    const statusCode = response.success ? 200 : 400;
    
    logger.info(`Session creation ${response.success ? 'successful' : 'failed'} for ${userId}-${plubotId}`);
    
    return res.status(statusCode).json(response);
    
  } catch (error) {
    logger.error('Unexpected error in session creation:', error.message);
    
    const errorResponse = SessionCreateResponseDTO.failure('Internal server error');
    return res.status(500).json(errorResponse);
  }
});

/**
 * Get session by ID
 * GET /api/sessions/:sessionId
 */
router.get('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    const session = await whatsappManager.getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }
    
    return res.status(200).json({
      success: true,
      data: session
    });
    
  } catch (error) {
    logger.error(`Error getting session ${sessionId}:`, error.message);
    
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve session'
    });
  }
});

/**
 * Get all sessions
 * GET /api/sessions
 */
router.get('/', async (req, res) => {
  try {
    const { status, userId } = req.query;
    
    const filter = {};
    if (status) filter.status = status;
    if (userId) filter.userId = userId;
    
    const response = await whatsappManager.getAllSessions(filter);
    
    return res.status(200).json(response);
    
  } catch (error) {
    logger.error('Error getting sessions:', error.message);
    
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve sessions'
    });
  }
});

/**
 * Destroy session
 * DELETE /api/sessions/:sessionId
 */
router.delete('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    logger.info(`Destroying session ${sessionId}`);
    
    const result = await whatsappManager.destroySession(sessionId);
    
    const statusCode = result.success ? 200 : 400;
    
    return res.status(statusCode).json(result);
    
  } catch (error) {
    logger.error(`Error destroying session ${sessionId}:`, error.message);
    
    return res.status(500).json({
      success: false,
      error: 'Failed to destroy session'
    });
  }
});

/**
 * Send message
 * POST /api/sessions/:sessionId/messages
 */
router.post('/:sessionId/messages', validateRequest('sendMessage'), async (req, res) => {
  const { sessionId } = req.params;
  const { to, message, options } = req.body;
  
  try {
    const result = await whatsappManager.sendMessage(sessionId, to, message, options);
    
    return res.status(200).json({
      success: true,
      data: result
    });
    
  } catch (error) {
    logger.error(`Error sending message for session ${sessionId}:`, error.message);
    
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to send message'
    });
  }
});

/**
 * Refresh QR code for a session
 * POST /api/sessions/refresh-qr
 */
router.post('/refresh-qr', async (req, res) => {
  const { userId, plubotId } = req.body;
  
  try {
    logger.info(`Refreshing QR for user: ${userId}, plubot: ${plubotId}`);
    
    // Destroy existing session
    const sessionId = `${userId}-${plubotId}`;
    await whatsappManager.destroySession(sessionId);
    
    // Wait a moment for cleanup
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Create new session to generate fresh QR
    const response = await whatsappManager.createSession(userId, plubotId);
    
    return res.status(200).json(response);
  } catch (error) {
    logger.error('Error refreshing QR:', error);
    // Don't return 500, return success with error info
    return res.status(200).json({
      success: false,
      error: error.message || 'Failed to refresh QR code',
      data: {
        status: 'error',
        isReady: false,
        isAuthenticated: false
      }
    });
  }
});

/**
 * Get session statistics
 * GET /api/sessions/stats
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await whatsappManager.getStatistics();
    
    return res.status(200).json({
      success: true,
      data: stats
    });
    
  } catch (error) {
    logger.error('Error getting session statistics:', error.message);
    
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve statistics'
    });
  }
});

// Get session status
router.get('/:sessionId/status', async (req, res) => {
  const { sessionId } = req.params;
  
  try {
    // Use await for async method
    const sessionState = await whatsappManager.getSessionState(sessionId);
    
    if (!sessionState || sessionState.status === 'not_found') {
      return res.status(404).json({
        success: false,
        exists: false,
        status: 'not_found'
      });
    }
    
    return res.status(200).json({
      success: true,
      exists: true,
      status: sessionState.status || 'initializing',
      phoneNumber: sessionState.phoneNumber || null,
      lastActivity: sessionState.lastActivity || null,
      isReady: sessionState.status === 'ready' || sessionState.status === 'connected',
      isAuthenticated: sessionState.status === 'authenticated' || sessionState.status === 'ready'
    });
    
  } catch (error) {
    logger.error('Error getting session status:', error);
    // Return 404 instead of 500 for missing sessions
    return res.status(404).json({
      success: false,
      exists: false,
      status: 'not_found',
      error: error.message
    });
  }
});

export default router;
