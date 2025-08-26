import express from 'express';
import logger from '../utils/logger.js';

const router = express.Router();

// Health check endpoint
router.get('/', async (req, res) => {
  try {
    const whatsappManager = req.app.locals.whatsappManager;
    
    if (whatsappManager?.healthCheckService) {
      return whatsappManager.healthCheckService.middleware()(req, res);
    }
    
    // Basic health check
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      service: 'plubot-whatsapp'
    };
    
    res.json(health);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Detailed health check
router.get('/detailed', async (req, res) => {
  try {
    const whatsappManager = req.app.locals.whatsappManager;
    
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      service: 'plubot-whatsapp',
      components: {
        redis: 'unknown',
        whatsapp: 'unknown',
        websocket: 'unknown'
      }
    };
    
    // Check Redis
    try {
      const redis = req.app.locals.redis;
      if (redis) {
        await redis.ping();
        health.components.redis = 'healthy';
      }
    } catch (error) {
      health.components.redis = 'unhealthy';
      health.status = 'degraded';
    }
    
    // Check WhatsApp sessions
    if (whatsappManager?.sessionPool) {
      const stats = whatsappManager.sessionPool.getStatistics();
      health.components.whatsapp = stats.active > 0 ? 'healthy' : 'idle';
      health.sessions = stats;
    }
    
    // Check WebSocket
    if (whatsappManager?.io) {
      health.components.websocket = 'healthy';
      health.websocket = {
        connected: whatsappManager.io.sockets.sockets.size
      };
    }
    
    res.json(health);
  } catch (error) {
    logger.error('Detailed health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

export default router;
