import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';

// Load environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: {
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

// Middleware
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'x-api-key'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store sessions in memory
const sessions = new Map();
const qrCodes = new Map();

// Routes
app.post('/api/sessions/create', async (req, res) => {
  const { userId, plubotId } = req.body;
  const sessionId = `${userId}-${plubotId}`;
  
  console.log(`Creating session: ${sessionId}`);
  
  // Create mock session
  sessions.set(sessionId, {
    id: sessionId,
    userId,
    plubotId,
    status: 'waiting_qr',
    createdAt: new Date().toISOString()
  });
  
  // Generate mock QR code
  const qrCode = `QR_CODE_FOR_${sessionId}_${Date.now()}`;
  qrCodes.set(sessionId, qrCode);
  
  // Emit QR code through WebSocket
  io.to(sessionId).emit('qr', { qr: qrCode });
  
  res.json({
    success: true,
    sessionId,
    status: 'waiting_qr',
    qr: qrCode
  });
});

app.get('/api/sessions/:sessionId/status', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);
  
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  res.json({
    success: true,
    status: session.status,
    sessionId
  });
});

app.get('/api/qr/:userId/:plubotId', (req, res) => {
  const { userId, plubotId } = req.params;
  const sessionId = `${userId}-${plubotId}`;
  const qr = qrCodes.get(sessionId);
  
  if (!qr) {
    return res.status(404).json({ success: false, error: 'QR not found' });
  }
  
  res.json({
    success: true,
    qr,
    status: 'waiting_qr'
  });
});

app.post('/api/sessions/refresh-qr', (req, res) => {
  const { userId, plubotId } = req.body;
  const sessionId = `${userId}-${plubotId}`;
  
  // Generate new QR code
  const qrCode = `QR_CODE_REFRESHED_${sessionId}_${Date.now()}`;
  qrCodes.set(sessionId, qrCode);
  
  // Update session
  const session = sessions.get(sessionId);
  if (session) {
    session.status = 'waiting_qr';
    sessions.set(sessionId, session);
  }
  
  // Emit new QR code
  io.to(sessionId).emit('qr', { qr: qrCode });
  
  res.json({
    success: true,
    qr: qrCode,
    status: 'waiting_qr'
  });
});

app.post('/api/sessions/:sessionId/disconnect', (req, res) => {
  const { sessionId } = req.params;
  
  sessions.delete(sessionId);
  qrCodes.delete(sessionId);
  
  io.to(sessionId).emit('session-disconnected', { sessionId });
  
  res.json({
    success: true,
    message: 'Session disconnected'
  });
});

app.post('/api/messages/send', (req, res) => {
  const { sessionId, to, message } = req.body;
  
  console.log(`Sending message from ${sessionId} to ${to}: ${message}`);
  
  res.json({
    success: true,
    messageId: `msg_${Date.now()}`,
    status: 'sent'
  });
});

// Health checks
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/health/live', (req, res) => {
  res.json({ status: 'alive' });
});

app.get('/health/ready', (req, res) => {
  res.json({ status: 'ready' });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('subscribe', (data) => {
    const { sessionId } = data;
    if (sessionId) {
      socket.join(sessionId);
      console.log(`Client ${socket.id} subscribed to session ${sessionId}`);
      
      // Send current QR if exists
      const qr = qrCodes.get(sessionId);
      if (qr) {
        socket.emit('qr', { qr });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Make io available to routes
app.set('io', io);

// Error handling
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`WhatsApp microservice running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS enabled for all origins`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
