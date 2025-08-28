/**
 * Simple WhatsApp API Server
 * Clean implementation without over-engineering
 */

const express = require('express');
const cors = require('cors');
const { createServer } = require('http');
const { Server } = require('socket.io');
const SimpleWhatsAppService = require('./services/SimpleWhatsAppService');
const QueueManager = require('./services/QueueManager');
const logger = require('./utils/logger');

// Initialize Express app
const app = express();
const server = createServer(app);

// Initialize Socket.IO
const io = new Server(server, {
  cors: {
    origin: ['http://localhost:3000', 'http://localhost:5173'],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Initialize WhatsApp service and Queue Manager
const whatsappService = new SimpleWhatsAppService();
const queueManager = new QueueManager({
  maxConcurrentSessions: 20,
  sessionTimeout: 30 * 60 * 1000, // 30 minutos
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6380
  }
});

// Initialize queue manager
queueManager.initialize().catch(err => {
  logger.error('Failed to initialize queue manager:', err);
});

// Middleware
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174'],
  credentials: true
}));
app.use(express.json());

// Health check
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/health/ready', (req, res) => {
  res.json({ 
    status: 'ready', 
    sessions: whatsappService.sessions.size,
    timestamp: Date.now() 
  });
});

// Create session with queue management
app.post('/api/sessions/create', async (req, res) => {
  try {
    const { userId, plubotId } = req.body;
    
    if (!userId || !plubotId) {
      return res.status(400).json({
        success: false,
        message: 'userId and plubotId are required'
      });
    }

    const sessionId = `${userId}-${plubotId}`;
    logger.info(`📱 Creating session: ${sessionId}`);

    // Check queue position
    const position = await queueManager.joinQueue(userId, sessionId);
    
    if (position === 1) {
      // Active immediately
      const result = await whatsappService.createSession(sessionId, userId, plubotId);
      res.json({
        ...result,
        queuePosition: 0,
        status: 'active'
      });
    } else {
      // In queue
      res.json({
        success: true,
        sessionId,
        queuePosition: position - 1,
        status: 'queued',
        message: `En cola. Posición: ${position - 1}`,
        estimatedWait: queueManager.estimateWaitTime(position - 1)
      });
    }
  } catch (error) {
    logger.error('Error creating session:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Get session status
app.get('/api/sessions/:sessionId/status', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await whatsappService.getSessionStatus(sessionId);
    res.json(result);
  } catch (error) {
    logger.error('Error getting session status:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Get QR code
app.get('/api/qr/:userId/:plubotId', async (req, res) => {
  try {
    const { userId, plubotId } = req.params;
    const sessionId = `${userId}-${plubotId}`;
    
    logger.info(`📱 Getting QR for session: ${sessionId}`);
    
    const result = await whatsappService.getQR(sessionId);
    res.json(result);
  } catch (error) {
    logger.error('Error getting QR:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Send message
app.post('/api/messages/send', async (req, res) => {
  try {
    const { sessionId, to, message } = req.body;
    
    if (!sessionId || !to || !message) {
      return res.status(400).json({
        success: false,
        message: 'sessionId, to, and message are required'
      });
    }

    const result = await whatsappService.sendMessage(sessionId, to, message);
    res.json(result);
  } catch (error) {
    logger.error('Error sending message:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Disconnect session and update queue
app.post('/api/sessions/:sessionId/disconnect', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await whatsappService.disconnectSession(sessionId);
    
    // Extract userId from sessionId
    const [userId] = sessionId.split('-');
    await queueManager.leaveQueue(userId);
    
    res.json(result);
  } catch (error) {
    logger.error('Error disconnecting session:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Get queue status
app.get('/api/queue/status', async (req, res) => {
  try {
    const status = await queueManager.getQueueStatus();
    res.json({
      success: true,
      ...status
    });
  } catch (error) {
    logger.error('Error getting queue status:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info(`🔌 Socket connected: ${socket.id}`);

  socket.on('join-session', (sessionId) => {
    socket.join(`session-${sessionId}`);
    logger.info(`Socket ${socket.id} joined room: session-${sessionId}`);
  });

  socket.on('leave-session', (sessionId) => {
    socket.leave(`session-${sessionId}`);
    logger.info(`Socket ${socket.id} left room: session-${sessionId}`);
  });

  socket.on('disconnect', () => {
    logger.info(`🔌 Socket disconnected: ${socket.id}`);
  });
});

// WhatsApp service event forwarding to Socket.IO
whatsappService.on('qr-update', (data) => {
  logger.info(`📱 Emitting QR update for session ${data.sessionId}`);
  io.to(`session-${data.sessionId}`).emit('qr-update', data);
});

whatsappService.on('session-authenticated', (data) => {
  logger.info(`🔐 Emitting authenticated event for session ${data.sessionId}`);
  io.to(`session-${data.sessionId}`).emit('session-authenticated', data);
});

whatsappService.on('session-ready', (data) => {
  logger.info(`✅ Emitting ready event for session ${data.sessionId}`);
  io.to(`session-${data.sessionId}`).emit('session-ready', data);
});

whatsappService.on('session-disconnected', (data) => {
  logger.info(`⚠️ Emitting disconnected event for session ${data.sessionId}`);
  io.to(`session-${data.sessionId}`).emit('session-disconnected', data);
});

whatsappService.on('message', (data) => {
  logger.info(`📨 Emitting message event for session ${data.sessionId}`);
  io.to(`session-${data.sessionId}`).emit('message', data);
});

whatsappService.on('auth-failure', (data) => {
  logger.error(`❌ Emitting auth failure for session ${data.sessionId}`);
  io.to(`session-${data.sessionId}`).emit('auth-failure', data);
});

// Queue Manager event forwarding
queueManager.on('session-activated', (data) => {
  logger.info(`🚀 Session activated for user ${data.userId}`);
  io.to(`session-${data.sessionId}`).emit('session-activated', data);
  // Create WhatsApp session when activated from queue
  whatsappService.createSession(data.sessionId, data.userId, data.sessionId.split('-')[1]);
});

queueManager.on('user-queued', (data) => {
  logger.info(`⏳ User ${data.userId} queued at position ${data.position}`);
  io.to(`session-${data.sessionId}`).emit('queue-update', data);
});

queueManager.on('queue-position-updated', (data) => {
  logger.info(`📊 Queue position updated for ${data.userId}: ${data.position}`);
  io.to(`session-${data.sessionId}`).emit('queue-position-update', data);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  await whatsappService.cleanup();
  await queueManager.shutdown();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  await whatsappService.cleanup();
  await queueManager.shutdown();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`🚀 WhatsApp API Server running on port ${PORT}`);
  logger.info(`📡 WebSocket server ready`);
  logger.info(`🔗 CORS enabled for: http://localhost:3000, http://localhost:5173, http://localhost:5174`);
});
