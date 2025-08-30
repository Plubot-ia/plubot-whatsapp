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
import { requireRole, requirePermission } from './api/middleware/rbac.middleware.js';
import { auditMiddleware, logAuditEvent, AUDIT_EVENTS } from './api/middleware/audit.middleware.js';
import { circuitBreakerMiddleware, withCircuitBreaker } from './api/middleware/circuitBreaker.middleware.js';
import { ipBlacklistMiddleware, recordSecurityViolation, blacklistErrorHandler } from './api/middleware/ipBlacklist.middleware.js';
import { csrfToken, csrfValidation, csrfErrorHandler } from './api/middleware/csrf.middleware.js';

// Import services
import SessionManager from './core/services/SessionManager.js';
import { getMessageQueue } from './core/services/MessageQueue.js';
import { getConnectionPool } from './core/services/ConnectionPool.js';
import { getMetrics } from './core/services/MetricsService.js';
import { getErrorTracking } from './core/services/ErrorTracking.js';
import logger from './core/utils/logger.js';

// Create logs directory if it doesn't exist
if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs');
}

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Redis
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = redis.createClient({
  url: REDIS_URL,
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

// Connect to Redis
await redisClient.connect();

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

// Initialize Services
const sessionManager = new SessionManager(redisClient, io);
const messageQueue = getMessageQueue();
const metricsService = getMetrics();
const errorTracking = getErrorTracking();
errorTracking.setupGlobalHandlers();

// Socket.IO metrics integration
io.on('connection', (socket) => {
  metricsService.recordWSConnection('connect');
  metricsService.setActiveWSConnections(io.engine.clientsCount);
  
  socket.on('disconnect', () => {
    metricsService.recordWSConnection('disconnect');
    metricsService.setActiveWSConnections(io.engine.clientsCount);
  });
  
  socket.on('message', (data) => {
    metricsService.recordWSMessage('message', 'inbound');
  });
  
  socket.use((packet, next) => {
    if (packet[0] !== 'message') {
      metricsService.recordWSMessage(packet[0], 'outbound');
    }
    next();
  });
});

// Initialize Connection Pool
const connectionPool = getConnectionPool({
  maxSize: parseInt(process.env.CONNECTION_POOL_MAX_SIZE) || 100,
  minSize: parseInt(process.env.CONNECTION_POOL_MIN_SIZE) || 10,
  ttl: parseInt(process.env.CONNECTION_POOL_TTL) || 1800000, // 30 minutos
  createMethod: async (sessionId, options) => {
    return await sessionManager.getClient(sessionId);
  },
  disposeMethod: async (connection, sessionId) => {
    if (connection.client) {
      await sessionManager.destroySession(sessionId);
    }
  },
  healthCheckMethod: async (connection) => {
    if (connection.client) {
      const state = await connection.client.getState();
      return state === 'CONNECTED';
    }
    return false;
  }
});

// Apply Sentry request handler (must be first)
app.use(errorTracking.requestHandler());
app.use(errorTracking.tracingHandler());

// Apply security middleware
app.use(configureHelmet());
app.use(configureCors());
app.use(addSecurityHeaders);
app.use(requestId);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(sanitizeInput);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// Apply metrics middleware
app.use(metricsService.httpMiddleware());

// Apply IP blacklist middleware
app.use(ipBlacklistMiddleware({
  checkSuspicious: true,
  autoBlock: true
}));

// Apply audit logging middleware
app.use(auditMiddleware({
  excludePaths: ['/health', '/metrics', '/favicon.ico'],
  includeBody: false,
  includeResponse: false
}));

// Apply CSRF protection for state-changing operations
app.use(csrfToken);

// Apply general rate limiting
// TEMPORARILY DISABLED FOR DEBUGGING
// app.use('/api/', generalLimiter);

// Apply circuit breaker for external services
app.use('/api/messages', circuitBreakerMiddleware('whatsapp'));
app.use('/api/sessions', circuitBreakerMiddleware('whatsapp'));

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
    
    // Track metrics
    metricsService.recordHTTPRequest(req.method, req.path, res.statusCode, duration / 1000);
  });
  
  next();
});

// ===== PUBLIC ENDPOINTS (No Auth Required) =====

// Import health check routes
import { createHealthRoutes } from './api/routes/health.routes.js';
const healthRoutes = createHealthRoutes({
  redisClient,
  sessionManager,
  messageQueue,
  connectionPool
});

// Mount health check routes
app.use('/api/health', healthRoutes);

// Metrics endpoint
app.get('/metrics', authenticate, (req, res) => {
  res.set('Content-Type', metricsService.register.contentType);
  metricsService.register.metrics().then(metrics => {
    res.end(metrics);
  }).catch(err => {
    res.status(500).end();
  });
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
    
    // Log audit event for successful login
    await logAuditEvent(AUDIT_EVENTS.AUTH_LOGIN_SUCCESS, req, {
      username,
      severity: 'INFO'
    });
    
    logger.info('User logged in', { username, requestId: req.id });
    
    res.json({
      success: true,
      token,
      expiresIn: process.env.JWT_EXPIRES_IN || '24h'
    });
  } catch (error) {
    // Log audit event for failed login
    await logAuditEvent(AUDIT_EVENTS.AUTH_LOGIN_FAILED, req, {
      error: error.message,
      severity: 'WARNING'
    });
    
    // Record security violation for potential brute force
    await recordSecurityViolation(req, 'LOGIN_FAILED');
    
    logger.error('Login failed', { error: error.message, requestId: req.id });
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

// ===== PROTECTED API ROUTES =====
const apiRouter = express.Router();

// Debug middleware to log headers
apiRouter.use((req, res, next) => {
  console.log('API Request Debug:', {
    path: req.path,
    method: req.method,
    headers: req.headers,
    hasApiKey: !!req.headers['x-api-key'],
    apiKeyValue: req.headers['x-api-key']
  });
  next();
});

// All API routes require authentication
apiRouter.use(authenticate);

// Apply CSRF validation for state-changing operations
// Temporarily disabled for API key authenticated routes
// apiRouter.use(csrfValidation({
//   skipMethods: ['GET', 'HEAD', 'OPTIONS'],
//   skipPaths: ['/webhooks', '/sessions']
// }));

// Create session
apiRouter.post('/sessions/create', 
  sessionCreationLimiter,
  // requirePermission('session:create'), // Disabled for API key auth
  validateBody(schemas.createSession),
  async (req, res) => {
    try {
      const { userId, plubotId, forceNew } = req.body || req.validatedBody;
      const sessionId = `${userId}-${plubotId}`;
      
      logger.info('Creating session', { 
        sessionId, 
        forceNew,
        requestId: req.id,
        user: req.user?.id
      });
      
      // Temporarily disable circuit breaker for debugging
      // const createSessionWithBreaker = withCircuitBreaker('whatsapp', 
      //   async () => await sessionManager.createSession(sessionId, forceNew),
      //   async () => ({ success: false, error: 'Service temporarily unavailable' })
      // );
      
      // const result = await createSessionWithBreaker();
      const result = await sessionManager.createSession(sessionId, forceNew);
      
      // Log audit event
      await logAuditEvent(AUDIT_EVENTS.SESSION_CREATED, req, {
        sessionId,
        severity: 'INFO'
      });
      
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
  requirePermission('message:send'),
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
      
      // Wrap message sending with circuit breaker
      const sendMessageWithBreaker = withCircuitBreaker('whatsapp',
        async () => await sessionManager.sendMessage(sessionId, to, message, type),
        async () => ({ success: false, error: 'Service temporarily unavailable' })
      );
      
      const result = await sendMessageWithBreaker();
      
      // Log audit event
      await logAuditEvent(AUDIT_EVENTS.MESSAGE_SENT, req, {
        sessionId,
        to,
        type,
        severity: 'INFO'
      });
      
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

// Refresh QR code for session
apiRouter.post('/sessions/:sessionId/refresh-qr',
  validateParams(schemas.sessionId),
  async (req, res) => {
    try {
      const { sessionId } = req.params;
      
      logger.info('Refreshing QR code', { sessionId, requestId: req.id });
      
      // Get session from manager
      const session = sessionManager.sessions.get(sessionId);
      
      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }
      
      // Force a new QR code generation by reconnecting
      if (session.sock) {
        // Trigger reconnection to get new QR
        await session.sock.ws?.close();
        await session.sock.ws?.connect();
      }
      
      // Get QR from Redis
      const qr = await sessionManager.redis.get(`qr:${sessionId}`);
      
      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr);
        return res.json({
          success: true,
          qr,
          qrDataUrl,
          status: 'waiting_qr'
        });
      }
      
      res.json({
        success: true,
        status: 'refreshing',
        message: 'QR code refresh initiated'
      });
      
    } catch (error) {
      logger.error('Failed to refresh QR', {
        sessionId: req.params.sessionId,
        error: error.message,
        requestId: req.id
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to refresh QR code'
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
  requirePermission('session:disconnect'),
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
      
      // Log audit event
      await logAuditEvent(AUDIT_EVENTS.SESSION_DISCONNECTED, req, {
        sessionId,
        severity: 'INFO'
      });
      
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
  requirePermission('session:delete'),
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
      
      // Log audit event
      await logAuditEvent(AUDIT_EVENTS.SESSION_DELETED, req, {
        sessionId,
        severity: 'INFO'
      });
      
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

// CSRF error handler
app.use(csrfErrorHandler);

// Blacklist error handler
app.use(blacklistErrorHandler);

// Sentry error handler (must be before any other error middleware)
app.use(errorTracking.errorHandler());

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
  
  // Close message queue
  await messageQueue.close();
  
  // Close connection pool
  await connectionPool.shutdown();
  
  // Destroy all sessions
  for (const [sessionId] of sessionManager.sessions) {
    await sessionManager.destroySession(sessionId).catch(err => {
      logger.error('Error destroying session during shutdown', { sessionId, error: err.message });
    });
  }
  
  // Flush Sentry events
  await errorTracking.flush(5000);
  
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
      'Graceful Shutdown',
      'Role-Based Access Control',
      'Audit Logging',
      'Circuit Breaker Pattern',
      'Message Queue System',
      'Connection Pool Management',
      'Prometheus Metrics',
      'Health Checks',
      'Sentry Error Tracking',
      'IP Blacklisting',
      'CSRF Protection'
    ]
  });
});

export { app, server, io, sessionManager };
