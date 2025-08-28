import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { Client, LocalAuth } from 'whatsapp-web.js';
import QRCode from 'qrcode';

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
const clients = new Map();

// Routes
app.post('/api/sessions/create', async (req, res) => {
  try {
    const { userId, plubotId } = req.body;
    const sessionId = `${userId}-${plubotId}`;
    
    console.log(`Creating WhatsApp session: ${sessionId}`);
    
    // Check if session already exists
    if (clients.has(sessionId)) {
      const existingSession = sessions.get(sessionId);
      if (existingSession && existingSession.qr) {
        return res.json({
          success: true,
          sessionId,
          status: existingSession.status,
          qr: existingSession.qr,
          qrDataUrl: existingSession.qrDataUrl
        });
      }
    }
    
    // Create new WhatsApp client
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: './sessions'
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      }
    });
    
    // Initialize session data
    const sessionData = {
      status: 'initializing',
      qr: null,
      qrDataUrl: null,
      phoneNumber: null
    };
    
    sessions.set(sessionId, sessionData);
    clients.set(sessionId, client);
    
    // Setup event handlers
    client.on('qr', async (qr) => {
      console.log(`QR received for session: ${sessionId}`);
      const qrDataUrl = await QRCode.toDataURL(qr);
      
      sessionData.qr = qr;
      sessionData.qrDataUrl = qrDataUrl;
      sessionData.status = 'waiting_qr';
      
      // Emit to WebSocket
      io.emit(`qr-update-${sessionId}`, {
        qr,
        qrDataUrl,
        status: 'waiting_qr'
      });
    });
    
    client.on('authenticated', () => {
      console.log(`Session authenticated: ${sessionId}`);
      sessionData.status = 'authenticated';
      sessionData.qr = null;
      sessionData.qrDataUrl = null;
      
      io.emit(`session-authenticated-${sessionId}`, {
        status: 'authenticated'
      });
    });
    
    client.on('ready', () => {
      console.log(`Session ready: ${sessionId}`);
      sessionData.status = 'ready';
      sessionData.phoneNumber = client.info?.wid?.user || 'Connected';
      
      io.emit(`session-ready-${sessionId}`, {
        status: 'ready',
        phoneNumber: sessionData.phoneNumber
      });
    });
    
    client.on('disconnected', (reason) => {
      console.log(`Session disconnected: ${sessionId}, reason: ${reason}`);
      sessionData.status = 'disconnected';
      
      io.emit(`session-disconnected-${sessionId}`, {
        status: 'disconnected',
        reason
      });
    });
    
    // Initialize client
    await client.initialize();
    
    // Wait for QR to be generated
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    res.json({
      success: true,
      sessionId,
      status: sessionData.status,
      qr: sessionData.qr,
      qrDataUrl: sessionData.qrDataUrl
    });
    
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/api/sessions/qr', async (req, res) => {
  const { sessionId, qr } = req.body;
  console.log(`QR received for session: ${sessionId}`);
  qrCodes.set(sessionId, qr);
  
  // Also store with userId-plubotId format
  const parts = sessionId.split('-');
  if (parts.length >= 2) {
    const userId = parts[0];
    const plubotId = parts.slice(1).join('');
    const altKey = `${userId}-${plubotId}`;
    qrCodes.set(altKey, qr);
  }
  
  io.to(sessionId).emit('qr-update', { sessionId, qr });
  res.json({ success: true });
});

app.post('/api/sessions/authenticated', async (req, res) => {
  const { sessionId } = req.body;
  console.log(`✅ Session authenticated: ${sessionId}`);
  if (sessions.has(sessionId)) {
    sessions.get(sessionId).status = 'authenticated';
  }
  io.to(sessionId).emit('session-authenticated', { sessionId });
  res.json({ success: true });
});

app.post('/api/sessions/ready', async (req, res) => {
  const { sessionId } = req.body;
  console.log(`✨ Session ready: ${sessionId}`);
  if (sessions.has(sessionId)) {
    sessions.get(sessionId).status = 'ready';
  }
  io.to(sessionId).emit('session-ready', { sessionId });
  res.json({ success: true });
});

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

app.get('/api/qr/:userId/:plubotId', async (req, res) => {
  const { userId, plubotId } = req.params;
  const sessionId = `${userId}-${plubotId}`;
  
  console.log(`Getting QR for session: ${sessionId}`);
  
  const qr = qrCodes.get(sessionId);
  
  if (qr) {
    res.json({
      success: true,
      qr: qr,
      qrDataUrl: qr,
      status: sessions.get(sessionId)?.status || 'waiting_qr'
    });
  } else {
    // Return empty if no QR yet
    res.json({
      success: false,
      error: 'No QR available yet',
      status: 'initializing'
    });
  }
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
  console.log('Client connected:', socket.id);
  
  socket.on('join-room', (sessionId) => {
    socket.join(sessionId);
    console.log(`Socket ${socket.id} joined room ${sessionId}`);
    
    // Send current status if session exists
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (session.status === 'authenticated') {
        socket.emit('session-authenticated', { sessionId });
      } else if (session.status === 'ready') {
        socket.emit('session-ready', { sessionId });
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
