import cluster from 'node:cluster';

import { createServer } from 'http';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';

// Core components
import { metricsConfig } from './config/cluster.config.js';
import { ClusterManager } from './core/ClusterManager.js';
import { SessionPool } from './core/SessionPool.js';
import { MessageQueueSystem } from './core/MessageQueue.js';
import { SessionReconnector } from './core/SessionReconnector.js';
import { MetricsCollector } from './core/MetricsCollector.js';
import { HealthChecker } from './core/HealthChecker.js';
import { QueueManager } from './core/QueueManager.js';

// Middleware
import { UserRateLimiter, sessionRateLimiter, messageRateLimiter, qrRateLimiter } from './middleware/UserRateLimiter.js';
import { TieredRateLimiter } from './middleware/rateLimiter.js';
import { CircuitBreakerFactory } from './middleware/CircuitBreaker.js';

// Managers
import WhatsAppManager from './managers/WhatsAppManager.js';
import ImprovedWhatsAppManager from './managers/ImprovedWhatsAppManager.js';

// Routes
import sessionsRouter from './routes/sessions.js';
import qrRouter from './routes/qr.js';
import messagesRouter from './routes/messages.js';
import flowRoutes from './routes/flow.js';

// Utils
import logger from './utils/logger.js';

// Load environment variables
dotenv.config();

/**
 * Enterprise WhatsApp Microservice
 * Scalable, resilient, production-ready
 */
class EnterpriseWhatsAppServer {
  constructor() {
    this.app = express();
    this.isShuttingDown = false;

    // Initialize core components
    this.clusterManager = new ClusterManager();
    this.sessionPool = null;
    this.messageQueue = null;
    this.sessionReconnector = null;
    this.metricsCollector = null;
    this.healthChecker = null;
    this.circuitBreakerFactory = null;
    this.rateLimiter = null;
    this.whatsappManager = null;
    this.queueManager = null;
  }

  /**
   * Initialize server
   */
  async initialize() {
    await (cluster.isPrimary ? this._initializePrimary() : this._initializeWorker());
  }

  /**
   * Initialize primary process
   */
  async _initializePrimary() {
    logger.info('Starting Enterprise WhatsApp Service (Primary)');

    // Initialize cluster manager
    await this.clusterManager.initialize();

    // Monitor cluster events
    this.clusterManager.on('worker:error', ({ workerId, error }) => {
      logger.error(`Worker ${workerId} error:`, error);
    });

    this.clusterManager.on('worker:unhealthy', ({ workerId, status }) => {
      logger.warn(`Worker ${workerId} unhealthy: ${status}`);
    });

    this.clusterManager.on('metrics:aggregated', (metrics) => {
      logger.debug('Cluster metrics:', metrics);
    });

    logger.info('Primary process initialized successfully');
  }

  /**
   * Initialize worker process
   */
  async _initializeWorker() {
    logger.info(`Starting Enterprise WhatsApp Service (Worker ${process.env.WORKER_INDEX})`);

    try {
      // Initialize components
      await this._initializeComponents();

      // Setup middleware
      this._setupMiddleware();

      // Setup routes
      this._setupRoutes();

      // Setup WebSocket
      await this._setupWebSocket();

      // Start server - workers share the port with master
      await this._startServer();

      // Setup graceful shutdown
      this._setupGracefulShutdown();

      // Initialize cluster manager for worker
      await this.clusterManager.initialize();

      logger.info(`Worker ${process.pid} initialized successfully`);
    } catch (error) {
      logger.error('Failed to initialize worker:', error);
      process.exit(1);
    }
  }

  /**
   * Initialize core components
   */
  async _initializeComponents() {
    // Session Pool
    this.sessionPool = new SessionPool({
      maxPoolSize: 100,
      minPoolSize: 10,
      acquireTimeout: 30_000,
      idleTimeout: 300_000,
    });

    // Message Queue System
    this.messageQueue = new MessageQueueSystem({
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD,
      },
    });

    // Session Reconnector
    this.sessionReconnector = new SessionReconnector({
      maxRetries: 10,
      initialDelay: 1000,
      maxDelay: 60_000,
    });

    // Metrics Collector
    this.metricsCollector = new MetricsCollector({
      prefix: 'plubot_whatsapp',
      collectDefaultMetrics: true,
    });
    await this.metricsCollector.startCollection();

    // Health Checker
    this.healthChecker = new HealthChecker({
      dependencies: {
        redis: {
          host: process.env.REDIS_HOST || 'localhost',
          port: process.env.REDIS_PORT || 6379,
        },
        sessionPool: this.sessionPool,
        messageQueue: this.messageQueue,
      },
    });
    this.healthChecker.startMonitoring();

    // Circuit Breaker Factory
    this.circuitBreakerFactory = new CircuitBreakerFactory();

    // Rate Limiter
    this.rateLimiter = new TieredRateLimiter();

    // Queue Manager for demo session management
    this.queueManager = new QueueManager({
      maxConcurrentSessions: parseInt(process.env.MAX_QR_SESSIONS || '20'),
      sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || '1800000'), // 30 minutes
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD,
      },
    });
    await this.queueManager.initialize();

    // WhatsApp Manager with enterprise features
    this.whatsappManager = new WhatsAppManager({
      sessionPool: this.sessionPool,
      messageQueue: this.messageQueue,
      sessionReconnector: this.sessionReconnector,
      metricsCollector: this.metricsCollector,
      circuitBreakerFactory: this.circuitBreakerFactory,
      queueManager: this.queueManager,
    });

    // Register message processors
    this._registerMessageProcessors();

    logger.info('Core components initialized');
  }

  /**
   * Register message processors for queues
   */
  _registerMessageProcessors() {
    // Incoming message processor
    this.messageQueue.registerProcessor('incoming', async (data) => {
      const { sessionId, message } = data;

      try {
        // Process incoming message
        await this.whatsappManager.processIncomingMessage(sessionId, message);

        // Record metrics
        this.metricsCollector.recordMessage('incoming', 'success');

      } catch (error) {
        logger.error('Failed to process incoming message:', error);
        this.metricsCollector.recordMessage('incoming', 'failure');
        throw error;
      }
    });

    // Outgoing message processor
    this.messageQueue.registerProcessor('outgoing', async (data) => {
      const { sessionId, recipient, message, options } = data;

      try {
        // Get session from pool
        const session = await this.sessionPool.acquire(sessionId);

        // Send message with circuit breaker
        const breaker = this.circuitBreakerFactory.getBreaker('whatsapp:send');
        const result = await breaker.execute(async () => await this.whatsappManager.sendMessage(session, recipient, message, options));

        // Release session
        await this.sessionPool.release(sessionId);

        // Record metrics
        this.metricsCollector.recordMessage('outgoing', 'success');

        return result;

      } catch (error) {
        logger.error('Failed to send message:', error);
        this.metricsCollector.recordMessage('outgoing', 'failure');
        throw error;
      }
    });

    // Media processor
    this.messageQueue.registerProcessor('media', async (data) => {
      const { sessionId, media, recipient } = data;

      try {
        const session = await this.sessionPool.acquire(sessionId);
        const result = await this.whatsappManager.sendMedia(session, recipient, media);
        await this.sessionPool.release(sessionId);

        this.metricsCollector.recordMessage('media', 'success');
        return result;

      } catch (error) {
        logger.error('Failed to send media:', error);
        this.metricsCollector.recordMessage('media', 'failure');
        throw error;
      }
    });
  }

  /**
   * Setup Express middleware
   */
  _setupMiddleware() {
    // Security
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
          },
        },
      })
    );

    // CORS
    this.app.use(
      cors({
        origin: process.env.CORS_ORIGIN?.split(',') || [
          'http://localhost:3000',
          'http://localhost:5174',
          'http://localhost:5173',
        ],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'x-api-key'],
      })
    );

    // Compression
    this.app.use(compression());

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Rate limiting
    this.app.use('/api', this.rateLimiter.middleware());

    // Metrics middleware
    this.app.use(this.metricsCollector.middleware());

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();

      res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info({
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration: `${duration}ms`,
          ip: req.ip,
        });
      });

      next();
    });

    // Error handling
    this.app.use((err, req, res, next) => {
      logger.error('Unhandled error:', err);
      this.metricsCollector.recordError('unhandled', 'error');

      res.status(err.status || 500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined,
      });
    });
  }

  /**
   * Setup API routes
   */
  _setupRoutes() {
    const router = express.Router();

    // Health check routes
    this.app.use(this.healthChecker.routes());

    // Register imported routes
    this.app.use('/api/sessions', sessionsRouter);
    this.app.use('/api/qr', qrRouter);
    this.app.use('/api/messages', messagesRouter);
    this.app.use('/api/flow', flowRoutes);

    // Metrics endpoint
    this.app.get('/metrics', async (req, res) => {
      try {
        const metrics = await this.metricsCollector.getMetrics();
        res.set('Content-Type', 'text/plain');
        res.send(metrics);
      } catch (error) {
        logger.error('Failed to get metrics:', error);
        res.status(500).send('Error collecting metrics');
      }
    });

    // Session management (legacy endpoint - keep for backward compatibility)
    router.post('/session/create', async (req, res) => {
      try {
        const { sessionId } = req.body;

        if (!sessionId) {
          return res.status(400).json({ error: 'Session ID required' });
        }

        const session = await this.sessionPool.acquire(sessionId);
        await this.whatsappManager.initializeSession(session);
        await this.sessionPool.release(sessionId);

        this.metricsCollector.recordSessionCreated('success');

        res.json({
          success: true,
          sessionId,
          message: 'Session created successfully',
        });

      } catch (error) {
        logger.error('Failed to create session:', error);
        this.metricsCollector.recordSessionCreated('failure');
        res.status(500).json({ error: error.message });
      }
    });

    router.delete('/session/:sessionId', async (req, res) => {
      try {
        const { sessionId } = req.params;

        await this.sessionPool.destroy(sessionId);
        this.metricsCollector.recordSessionDestroyed();

        res.json({
          success: true,
          message: 'Session destroyed successfully',
        });

      } catch (error) {
        logger.error('Failed to destroy session:', error);
        res.status(500).json({ error: error.message });
      }
    });

    router.get('/session/:sessionId/status', async (req, res) => {
      try {
        const { sessionId } = req.params;
        const status = this.sessionReconnector.getSessionStatus(sessionId);

        res.json({
          sessionId,
          status,
        });

      } catch (error) {
        logger.error('Failed to get session status:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Message sending
    router.post('/message/send', async (req, res) => {
      try {
        const { sessionId, recipient, message, options } = req.body;

        // Add to queue for processing
        const job = await this.messageQueue.addMessage('outgoing', {
          sessionId,
          recipient,
          message,
          options,
        });

        res.json({
          success: true,
          jobId: job.id,
          message: 'Message queued for sending',
        });

      } catch (error) {
        logger.error('Failed to queue message:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Queue statistics
    router.get('/queue/stats', async (req, res) => {
      try {
        const stats = await this.messageQueue.getStats();
        res.json(stats);
      } catch (error) {
        logger.error('Failed to get queue stats:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Demo queue management endpoints
    router.post('/queue/join', async (req, res) => {
      try {
        const { userId } = req.body;
        if (!userId) {
          return res.status(400).json({ error: 'User ID required' });
        }

        const result = await this.queueManager.joinQueue(userId);
        res.json(result);
      } catch (error) {
        logger.error('Failed to join queue:', error);
        res.status(500).json({ error: error.message });
      }
    });

    router.get('/queue/status/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const status = await this.queueManager.getQueueStatus(userId);
        res.json(status);
      } catch (error) {
        logger.error('Failed to get queue status:', error);
        res.status(500).json({ error: error.message });
      }
    });

    router.post('/queue/leave/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        await this.queueManager.leaveQueue(userId);
        res.json({ success: true, message: 'Left queue successfully' });
      } catch (error) {
        logger.error('Failed to leave queue:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Circuit breaker status
    router.get('/circuit-breakers', async (req, res) => {
      try {
        const breakers = this.circuitBreakerFactory.getAllBreakers();
        res.json(breakers);
      } catch (error) {
        logger.error('Failed to get circuit breakers:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // Mount the router
    this.app.use('/api', router);

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not Found' });
    });
  }

  /**
   * Setup WebSocket server
   */
  async _setupWebSocket() {
    this.io = new SocketServer(this.server, {
      cors: {
        origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60_000,
      pingInterval: 25_000,
    });

    // WebSocket authentication middleware
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;

        // Allow connections without token for testing
        if (!token) {
          logger.warn('WebSocket connection without token - allowing for testing');
          socket.userId = 'test-user';
          return next();
        }

        // Validate token (implement your auth logic)
        socket.userId = 'authenticated-user';
        next();

      } catch {
        next(new Error('Authentication failed'));
      }
    });

    // WebSocket connection handler
    this.io.on('connection', (socket) => {
      logger.info(`WebSocket client connected: ${socket.id}`);

      // Join user room
      socket.join(`user:${socket.userId}`);

      // Handle session subscription
      socket.on('subscribe:session', (sessionId) => {
        socket.join(`session:${sessionId}`);
        logger.debug(`Client ${socket.id} subscribed to session ${sessionId}`);
      });

      // Handle unsubscribe
      socket.on('unsubscribe:session', (sessionId) => {
        socket.leave(`session:${sessionId}`);
        logger.debug(`Client ${socket.id} unsubscribed from session ${sessionId}`);
      });

      // Handle disconnect
      socket.on('disconnect', () => {
        logger.info(`WebSocket client disconnected: ${socket.id}`);
      });
    });

    // Setup event forwarding from WhatsApp manager
    this.whatsappManager.on('qr', (data) => {
      this.io.to(`session:${data.sessionId}`).emit('qr', data);
    });

    this.whatsappManager.on('session:authenticated', (data) => {
      logger.info(`📤 Emitting session-authenticated event for ${data.sessionId}`);
      // Emit to the session room
      this.io.to(data.sessionId).emit('session-authenticated', data);
      // Also emit to the specific session room
      this.io.to(`session:${data.sessionId}`).emit('session-authenticated', data);
    });

    this.whatsappManager.on('session:ready', (data) => {
      logger.info(`📤 Emitting session-ready event for ${data.sessionId}`);
      // Emit to the session room
      this.io.to(data.sessionId).emit('session-ready', data);
      // Also emit to the specific session room  
      this.io.to(`session:${data.sessionId}`).emit('session-ready', data);
    });

    this.whatsappManager.on('message', (data) => {
      this.io.to(`session:${data.sessionId}`).emit('message', data);
    });

    logger.info('WebSocket server initialized');
  }

  /**
   * Start HTTP server
   */
  async _startServer() {
    const port = process.env.PORT || 3001;

    this.server = createServer(this.app);

    // In cluster mode, the master process handles port binding
    // Workers receive connections from master
    await new Promise((resolve, reject) => {
      this.server.listen(port, '0.0.0.0', (err) => {
        if (err) {
          // Check if it's a port in use error and we're a worker
          if (err.code === 'EADDRINUSE' && cluster.isWorker) {
            // This is expected for workers, they share the master's port
            logger.info(`Worker ${process.pid} sharing port ${port} with master`);
            resolve();
          } else {
            reject(err);
          }
        } else {
          resolve();
        }
      });
    });

    if (cluster.isPrimary) {
      logger.info(`Master server listening on port ${port}`);
    } else {
      logger.info(`Worker ${process.pid} ready to handle requests`);
    }
  }

  /**
   * Setup graceful shutdown
   */
  _setupGracefulShutdown() {
    const shutdown = async (signal) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;

      logger.info(`Received ${signal}, starting graceful shutdown...`);

      // Stop accepting new connections
      this.server.close(() => {
        logger.info('HTTP server closed');
      });

      // Close WebSocket connections
      if (this.io) {
        this.io.close(() => {
          logger.info('WebSocket server closed');
        });
      }

      // Shutdown components
      try {
        await Promise.all([
          this.sessionPool?.shutdown(),
          this.messageQueue?.shutdown(),
          this.healthChecker?.shutdown(),
          this.metricsCollector?.stopCollection(),
          this.rateLimiter?.shutdown(),
          this.circuitBreakerFactory?.shutdownAll(),
          this.queueManager?.shutdown(),
        ]);

        logger.info('All components shut down successfully');
        process.exit(0);

      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught exception:', error);
      this.metricsCollector?.recordError('uncaught_exception', 'critical');
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled rejection:', reason);
      this.metricsCollector?.recordError('unhandled_rejection', 'critical');
    });
  }
}

// Start server
const server = new EnterpriseWhatsAppServer();
server.initialize().catch((error) => {
  logger.error('Failed to start server:', error);
  process.exit(1);
});
