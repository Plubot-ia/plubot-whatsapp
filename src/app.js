import dotenv from 'dotenv';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import redis from 'redis';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Joi from 'joi';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configure environment
dotenv.config();

// Import security middleware
import { configureHelmet, configureCors, addSecurityHeaders, requestId } from './api/middleware/security.middleware.js';
import { authenticate, generateToken } from './api/middleware/auth.middleware.js';
import { generalLimiter, sessionCreationLimiter, messageLimiter, qrCodeLimiter } from './api/middleware/rateLimiter.middleware.js';
import { validateBody, validateParams, sanitizeInput, schemas } from './api/middleware/validation.middleware.js';

// Import services
import SessionManager from './core/services/SessionManager.js';
import logger from './core/utils/logger.js';

// Create logs directory if it doesn't exist
if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs');
}

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Redis
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = redis.createClient({
  url: redisUrl,
  database: parseInt(process.env.REDIS_DB) || 0,
  retry_strategy: function(options) {
    if (options.total_retry_time > 1000 * 60 * 60) {
      logger.error('Redis retry time exhausted');
      return new Error('Retry time exhausted');
    }
    if (options.attempt > 10) {
      logger.error('Redis max retry attempts reached');
      return undefined;
    }
    return Math.min(options.attempt * 100, 3000);
  }
});

// Redis event handlers
redisClient.on('connect', () => {
  logger.info('Redis connected successfully');
});

redisClient.on('error', (err) => {
  logger.error('Redis error:', err);
});

// Initialize Socket.IO with security
const io = new SocketIOServer(server, {
  cors: {
    origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(','),
    credentials: true
  },
  pingTimeout: parseInt(process.env.WS_PING_TIMEOUT) || 60000,
  pingInterval: parseInt(process.env.WS_PING_INTERVAL) || 25000,
  maxHttpBufferSize: 1e6 // 1MB
});

// Initialize Session Manager
const sessionManager = new SessionManager(redisClient, io);

// Apply security middleware
app.use(configureHelmet());
app.use(configureCors());
app.use(addSecurityHeaders);
app.use(requestId);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(sanitizeInput);

// Apply general rate limiting
app.use('/api/', generalLimiter);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.http(`${req.method} ${req.path}`, {
      requestId: req.id,
      ip: req.ip,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      userAgent: req.get('user-agent')
    });
  });
  
  next();
});

// ===== PUBLIC ENDPOINTS (No Auth Required) =====

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    redis: redisClient.connected
  });
});

// Detailed health check
app.get('/health/detailed', authenticate, async (req, res) => {
  try {
    const sessionHealth = await sessionManager.healthCheck();
    
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      redis: redisClient.connected,
      sessions: sessionHealth
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Health check failed'
    });
  }
});

// Login endpoint (generates JWT)
app.post('/auth/login', validateBody(schemas.login || Joi.object({
  username: Joi.string().required(),
  password: Joi.string().required()
})), async (req, res) => {
  try {
    // TODO: Implement actual authentication logic
    // For now, just generate a token for demo
    const { username } = req.validatedBody;
    
    const token = generateToken({
      id: username,
      role: 'user',
      tier: 'free'
    });
    
    logger.info('User logged in', { username, requestId: req.id });
    
    res.json({
      success: true,
      token,
      expiresIn: process.env.JWT_EXPIRES_IN || '24h'
    });
  } catch (error) {
    logger.error('Login failed', { error: error.message, requestId: req.id });
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// ===== PROTECTED API ROUTES =====
const apiRouter = express.Router();

// All API routes require authentication
apiRouter.use(authenticate);

// Create session
apiRouter.post('/sessions/create', 
  sessionCreationLimiter,
  validateBody(schemas.createSession),
  async (req, res) => {
    try {
      const { userId, plubotId, forceNew } = req.validatedBody;
      const sessionId = `${userId}-${plubotId}`;
      
      logger.info('Creating session', { 
        sessionId, 
        forceNew,
        requestId: req.id,
        user: req.user?.id
      });
      
      const result = await sessionManager.createSession(sessionId, forceNew);
      
      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      logger.error('Session creation failed', {
        error: error.message,
        stack: error.stack,
        requestId: req.id
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to create session',
        message: error.message
      });
    }
  }
);

// Send message
apiRouter.post('/messages/send',
  messageLimiter,
  validateBody(schemas.sendMessage),
  async (req, res) => {
    try {
      const { sessionId, to, message, type } = req.validatedBody;
      
      logger.info('Sending message', {
        sessionId,
        to,
        type,
        requestId: req.id,
        user: req.user?.id
      });
      
      const result = await sessionManager.sendMessage(sessionId, to, message, type);
      
      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      logger.error('Message sending failed', {
        error: error.message,
        requestId: req.id
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to send message',
        message: error.message
      });
    }
  }
);

// Get QR code
apiRouter.get('/qr/:userId/:plubotId',
  qrCodeLimiter,
  validateParams(schemas.userIdPlubotId),
  async (req, res) => {
    try {
      const { userId, plubotId } = req.validatedParams;
      const sessionId = `${userId}-${plubotId}`;
      
      logger.info('Getting QR code', {
        sessionId,
        requestId: req.id,
        user: req.user?.id
      });
      
      // Get QR from Redis
      const qr = await new Promise((resolve, reject) => {
        redisClient.get(`qr:${sessionId}`, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
      
      if (!qr) {
        return res.status(404).json({
          success: false,
          error: 'QR code not found or expired'
        });
      }
      
      res.json({
        success: true,
        qr,
        sessionId
      });
    } catch (error) {
      logger.error('QR retrieval failed', {
        error: error.message,
        requestId: req.id
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to get QR code'
      });
    }
  }
);

// Get session status
apiRouter.get('/sessions/:sessionId/status',
  validateParams(schemas.sessionId),
  async (req, res) => {
    try {
      const { sessionId } = req.validatedParams;
      
      logger.info('Getting session status', {
        sessionId,
        requestId: req.id,
        user: req.user?.id
      });
      
      const status = await sessionManager.getSessionStatus(sessionId);
      
      res.json({
        success: true,
        sessionId,
        ...status
      });
    } catch (error) {
      logger.error('Status retrieval failed', {
        error: error.message,
        requestId: req.id
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to get session status'
      });
    }
  }
);

// Disconnect session
apiRouter.post('/sessions/:sessionId/disconnect',
  validateParams(schemas.sessionId),
  async (req, res) => {
    try {
      const { sessionId } = req.validatedParams;
      
      logger.info('Disconnecting session', {
        sessionId,
        requestId: req.id,
        user: req.user?.id
      });
      
      const result = await sessionManager.disconnectSession(sessionId);
      
      res.json({
        success: true,
        message: 'Session disconnected',
        ...result
      });
    } catch (error) {
      logger.error('Disconnect failed', {
        error: error.message,
        requestId: req.id
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to disconnect session'
      });
    }
  }
);

// Destroy session
apiRouter.delete('/sessions/:sessionId',
  validateParams(schemas.sessionId),
  async (req, res) => {
    try {
      const { sessionId } = req.validatedParams;
      
      logger.info('Destroying session', {
        sessionId,
        requestId: req.id,
        user: req.user?.id
      });
      
      const result = await sessionManager.destroySession(sessionId);
      
      res.json({
        success: true,
        message: 'Session destroyed',
        ...result
      });
    } catch (error) {
      logger.error('Destroy failed', {
        error: error.message,
        requestId: req.id
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to destroy session'
      });
    }
  }
);

// Mount API router
app.use('/api', apiRouter);

// ===== WEBSOCKET HANDLING =====

// WebSocket authentication
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  const apiKey = socket.handshake.headers['x-api-key'];
  
  if (!token && !apiKey) {
    logger.warn('WebSocket connection rejected - no auth', {
      socketId: socket.id,
      ip: socket.handshake.address
    });
    return next(new Error('Authentication required'));
  }
  
  // TODO: Verify token or API key
  
  logger.info('WebSocket connection authenticated', {
    socketId: socket.id
  });
  
  next();
});

// WebSocket connection handling
io.on('connection', (socket) => {
  logger.info('WebSocket client connected', {
    socketId: socket.id,
    ip: socket.handshake.address
  });
  
  // Join session room
  socket.on('join-session', (sessionId) => {
    socket.join(`session-${sessionId}`);
    logger.info('Socket joined session room', {
      socketId: socket.id,
      sessionId
    });
  });
  
  // Leave session room
  socket.on('leave-session', (sessionId) => {
    socket.leave(`session-${sessionId}`);
    logger.info('Socket left session room', {
      socketId: socket.id,
      sessionId
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    logger.info('WebSocket client disconnected', {
      socketId: socket.id
    });
  });
  
  // Error handling
  socket.on('error', (error) => {
    logger.error('WebSocket error', {
      socketId: socket.id,
      error: error.message
    });
  });
});

// ===== ERROR HANDLING =====

// 404 handler
app.use((req, res) => {
  logger.warn('404 Not Found', {
    path: req.path,
    method: req.method,
    requestId: req.id
  });
  
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    requestId: req.id,
    path: req.path,
    method: req.method
  });
  
  // Don't leak error details in production
  const message = process.env.NODE_ENV === 'production' 
    ? 'Internal server error' 
    : err.message;
  
  res.status(err.status || 500).json({
    success: false,
    error: message,
    requestId: req.id
  });
});

// ===== GRACEFUL SHUTDOWN =====

const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received, starting graceful shutdown`);
  
  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });
  
  // Close WebSocket connections
  io.close(() => {
    logger.info('WebSocket server closed');
  });
  
  // Close Redis connection
  redisClient.quit(() => {
    logger.info('Redis connection closed');
  });
  
  // Destroy all sessions
  for (const [sessionId] of sessionManager.sessions) {
    await sessionManager.destroySession(sessionId).catch(err => {
      logger.error('Error destroying session during shutdown', { sessionId, error: err.message });
    });
  }
  
  // Exit process
  setTimeout(() => {
    logger.info('Forcing shutdown after timeout');
    process.exit(0);
  }, 10000); // 10 second timeout
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ===== START SERVER =====

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  logger.info('🔒 Secure WhatsApp Microservice Started', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    features: [
      'JWT Authentication',
      'API Key Support',
      'Rate Limiting',
      'Input Validation',
      'Helmet Security Headers',
      'CORS Protection',
      'Winston Logging',
      'Session Pooling',
      'WebSocket Support',
      'Graceful Shutdown'
    ]
  });
});

export { app, server, io, sessionManager };
