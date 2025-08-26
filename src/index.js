import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';

import { errorHandler } from './middleware/errorHandler.js';
import flowRoutes from './routes/flow.js';
import sessionsRouter from './routes/sessions.js';
import sessionStatusRoutes from './routes/sessions-status.js';
import qrRouter from './routes/qr.js';
import messagesRouter from './routes/messages.js';
import healthRouter from './routes/health.js';
import metricsRouter from './routes/metrics.js';
import { sessionRateLimiter, messageRateLimiter, qrRateLimiter } from './middleware/UserRateLimiter.js';
import whatsappManager from './services/WhatsAppManager.js';
import logger from './utils/logger.js';
import metricsService from './services/MetricsService.js';
import redis from './config/redis.js';

const app = express();
let io = null;

// Initialize WhatsApp Manager
await whatsappManager.initialize();

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`Incoming request: ${req.method} ${req.url}`);
  next();
});

// Middleware
app.use(helmet());

// Add metrics middleware
app.use(metricsService.apiMetricsMiddleware());

app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:001',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes with rate limiting
app.use('/api/sessions', 
  sessionRateLimiter.middleware({ 
    getUserId: (req) => req.body?.userId || req.params?.userId || req.ip 
  }),
  sessionsRouter
);
app.use('/api/qr', 
  qrRateLimiter.middleware({ 
    getUserId: (req) => req.params?.userId || req.ip 
  }),
  qrRouter
);
app.use('/api/messages', 
  messageRateLimiter.middleware({ 
    getUserId: (req) => req.body?.userId || req.ip 
  }),
  messagesRouter
);
app.use('/api/sessions', sessionStatusRoutes);
app.use('/api/flow', flowRoutes);
app.use('/api/health', healthRouter);
app.use('/api/metrics', metricsRouter);

// Health check endpoint
app.get('/health', async (req, res) => {
  if (whatsappManager.healthCheckService) {
    return whatsappManager.healthCheckService.middleware()(req, res);
  }
  res.json({ healthy: true, message: 'Service running' });
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', 'text/plain');
  const metrics = await metricsService.getMetrics();
  res.send(metrics);
});

// Dashboard metrics endpoint (JSON format)
app.get('/api/metrics/dashboard', async (req, res) => {
  const dashboardMetrics = await metricsService.getDashboardMetrics();
  res.json(dashboardMetrics);
});

// Legacy metrics endpoint
app.get('/api/metrics/legacy', async (req, res) => {
  const metrics = {
    sessionPool: whatsappManager.sessionPool?.getStatistics(),
    circuitBreakers: whatsappManager.circuitBreaker?.getStatus(),
    rateLimits: {
      sessions: sessionRateLimiter.getGlobalStats(),
      messages: messageRateLimiter.getGlobalStats(),
      qr: qrRateLimiter.getGlobalStats()
    },
    handlers: whatsappManager.enhancedHandlers?.getAllMetrics()
  };
  res.json(metrics);
});

// Make WhatsApp Manager available to routes
app.locals.whatsappManager = whatsappManager;
app.locals.redis = whatsappManager.redis;

app.use((req, res, next) => {
  // eslint-disable-next-line no-param-reassign
  req.whatsappManager = whatsappManager;
  // eslint-disable-next-line no-param-reassign
  req.io = io;
  next();
});


// Error handling
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  logger.info(`WhatsApp service running on port ${PORT}`);

  // Create and attach Socket.IO after server is created
  io = new Server(server, {
    cors: {
      origin: process.env.CORS_ORIGIN || [
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175',
      ],
      credentials: true,
    },
  });

  // Update WhatsAppManager with Socket.IO instance
  whatsappManager.io = io;

  // Configure Socket.IO events
  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    // Join room for QR updates
    socket.on('subscribe-qr', ({ userId, plubotId }) => {
      const sessionId = `${userId}-${plubotId}`;
      socket.join(`qr-${sessionId}`);
      logger.info(`Socket ${socket.id} subscribed to QR updates for session ${sessionId}`);
    });

    // Leave room
    socket.on('unsubscribe-qr', ({ userId, plubotId }) => {
      const sessionId = `${userId}-${plubotId}`;
      socket.leave(`qr-${sessionId}`);
      logger.info(`Socket ${socket.id} unsubscribed from QR updates for session ${sessionId}`);
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  // Socket.IO is now ready, update the manager's io instance
  // No need to initialize again since we already did it at startup
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  if (whatsappManager) {
    await whatsappManager.shutdown();
  }
  server.close(() => {
    logger.info('Server closed');
    // eslint-disable-next-line no-process-exit, node/no-process-exit
    process.exit(0);
  });
});

export default app;
