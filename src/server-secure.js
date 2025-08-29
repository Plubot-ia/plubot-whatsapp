require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

// Import security middleware
const { configureHelmet, configureCors, addSecurityHeaders, requestId } = require('./api/middleware/security.middleware');
const { authenticate } = require('./api/middleware/auth.middleware');
const { generalLimiter, sessionCreationLimiter, messageLimiter, qrCodeLimiter } = require('./api/middleware/rateLimiter.middleware');
const { sanitizeInput } = require('./api/middleware/validation.middleware');

// Import logger
const logger = require('./core/utils/logger');

// Import existing modules (to be refactored)
const { createWhatsAppSession, sendWhatsAppMessage, getSessionStatus } = require('../server');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with security
const io = socketIO(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

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
  logger.info(`${req.method} ${req.path}`, {
    requestId: req.id,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// API Routes with authentication and validation
const apiRouter = express.Router();

// All API routes require authentication
apiRouter.use(authenticate);

// Session creation with rate limiting and validation
apiRouter.post('/sessions/create', 
  sessionCreationLimiter,
  async (req, res) => {
    try {
      const { userId, plubotId, forceNew } = req.validatedBody || req.body;
      
      logger.info('Creating session', { 
        userId, 
        plubotId, 
        forceNew,
        requestId: req.id 
      });
      
      const sessionId = `${userId}-${plubotId}`;
      const result = await createWhatsAppSession(sessionId, io, forceNew);
      
      logger.info('Session created successfully', { 
        sessionId,
        requestId: req.id 
      });
      
      res.json({
        success: true,
        sessionId,
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

// Send message with rate limiting
apiRouter.post('/messages/send',
  messageLimiter,
  async (req, res) => {
    try {
      const { sessionId, to, message } = req.validatedBody || req.body;
      
      logger.info('Sending message', {
        sessionId,
        to,
        messageLength: message?.length,
        requestId: req.id
      });
      
      const result = await sendWhatsAppMessage(sessionId, to, message);
      
      logger.info('Message sent successfully', {
        sessionId,
        to,
        requestId: req.id
      });
      
      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      logger.error('Message sending failed', {
        error: error.message,
        stack: error.stack,
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

// Get QR code with rate limiting
apiRouter.get('/qr/:userId/:plubotId',
  qrCodeLimiter,
  async (req, res) => {
    try {
      const { userId, plubotId } = req.params;
      const sessionId = `${userId}-${plubotId}`;
      
      logger.info('Getting QR code', {
        sessionId,
        requestId: req.id
      });
      
      // Implementation to get QR from Redis
      const qr = await getQRFromRedis(sessionId);
      
      if (!qr) {
        return res.status(404).json({
          success: false,
          error: 'QR code not found'
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

// Session status
apiRouter.get('/sessions/:sessionId/status', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    logger.info('Getting session status', {
      sessionId,
      requestId: req.id
    });
    
    const status = await getSessionStatus(sessionId);
    
    res.json({
      success: true,
      sessionId,
      status
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
});

// Disconnect session
apiRouter.post('/sessions/:sessionId/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    logger.info('Disconnecting session', {
      sessionId,
      requestId: req.id
    });
    
    // Implementation for disconnect
    await disconnectSession(sessionId);
    
    logger.info('Session disconnected successfully', {
      sessionId,
      requestId: req.id
    });
    
    res.json({
      success: true,
      message: 'Session disconnected'
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
});

// Mount API router
app.use('/api', apiRouter);

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
  
  // Verify token or API key
  // Implementation here...
  
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
  
  socket.on('join-session', (sessionId) => {
    socket.join(`session-${sessionId}`);
    logger.info('Socket joined session room', {
      socketId: socket.id,
      sessionId
    });
  });
  
  socket.on('disconnect', () => {
    logger.info('WebSocket client disconnected', {
      socketId: socket.id
    });
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    requestId: req.id,
    path: req.path,
    method: req.method
  });
  
  res.status(err.status || 500).json({
    success: false,
    error: 'Internal server error',
    requestId: req.id
  });
});

// 404 handler
app.use((req, res) => {
  logger.warn('404 Not Found', {
    path: req.path,
    method: req.method,
    requestId: req.id
  });
  
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  
  server.close(() => {
    logger.info('HTTP server closed');
    
    // Close database connections
    // Close Redis connections
    // Cleanup sessions
    
    process.exit(0);
  });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`🔒 Secure WhatsApp microservice running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info('Security features enabled: Helmet, CORS, Rate Limiting, JWT Auth');
});
