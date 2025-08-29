import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import baileys from '@whiskeysockets/baileys';
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, Browsers } = baileys;
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import redis from 'redis';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Redis client
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

await redisClient.connect();

// Express setup
const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true
  }
});

app.use(cors());
app.use(express.json());

// Sessions storage
const sessions = new Map();

// Create WhatsApp session
async function createWhatsAppSession(sessionId) {
  const authFolder = path.join(__dirname, 'auth-sessions', sessionId);
  await fs.mkdir(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: ['Plubot', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: undefined,
    keepAliveIntervalMs: 10000,
    emitOwnEvents: true,
    fireInitQueries: true,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
    qrTimeout: 60000
  });

  sessions.set(sessionId, { sock, isAuthenticated: false });

  // Connection update
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR Code received for', sessionId);
      // Store only the QR string, not a JSON object
      await redisClient.setEx(`qr:${sessionId}`, 300, qr);
      
      io.to(`qr-${sessionId}`).emit('qr-update', { qr });
      io.to(`session-${sessionId}`).emit('qr-update', { qr });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        setTimeout(() => createWhatsAppSession(sessionId), 5000);
      }
    } else if (connection === 'open') {
      console.log('Connected!', sessionId);
      const session = sessions.get(sessionId);
      session.isAuthenticated = true;
      
      await redisClient.setEx(`session:${sessionId}`, 3600, JSON.stringify({
        status: 'ready',
        authenticated: true
      }));
      
      await redisClient.del(`qr:${sessionId}`);
      
      // Emit both authenticated and ready events for compatibility
      io.to(`session-${sessionId}`).emit('session-authenticated', {
        sessionId,
        status: 'authenticated'
      });
      
      io.to(`session-${sessionId}`).emit('session-ready', {
        sessionId,
        status: 'ready'
      });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
      if (text) {
        console.log('Message received:', text);
        io.to(`messages-${sessionId}`).emit('message-received', {
          sessionId,
          from: msg.key.remoteJid,
          text
        });
      }
    }
  });

  return sock;
}

// API Routes
app.post('/api/sessions/create', async (req, res) => {
  try {
    const { userId, plubotId } = req.body;
    const sessionId = `${userId}-${plubotId}`;
    
    if (sessions.has(sessionId)) {
      // Check if session is authenticated
      const session = sessions.get(sessionId);
      const sessionData = await redisClient.get(`session:${sessionId}`);
      
      if (session.isAuthenticated || (sessionData && JSON.parse(sessionData).authenticated)) {
        return res.json({ 
          success: true, 
          sessionId,
          status: 'connected',
          message: 'Session already connected'
        });
      }
      
      // Session exists but not authenticated, try to get QR
      const qr = await redisClient.get(`qr:${sessionId}`);
      return res.json({ 
        success: true, 
        sessionId,
        status: qr ? 'waiting_qr' : 'initializing',
        qr: qr || null,
        message: 'Session exists'
      });
    }
    
    // Create new session
    await createWhatsAppSession(sessionId);
    
    // Wait a bit for QR to be generated
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Try to get the QR from Redis
    const qr = await redisClient.get(`qr:${sessionId}`);
    
    res.json({ 
      success: true, 
      sessionId,
      status: qr ? 'waiting_qr' : 'initializing',
      qr: qr || null
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.get('/api/qr/:userId/:plubotId', async (req, res) => {
  try {
    const sessionId = `${req.params.userId}-${req.params.plubotId}`;
    const qrData = await redisClient.get(`qr:${sessionId}`);
    
    if (qrData) {
      const parsed = JSON.parse(qrData);
      res.json({ success: true, ...parsed });
    } else {
      res.json({ success: false, error: 'QR not available' });
    }
  } catch (error) {
    console.error('Error getting QR:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sessions/refresh-qr', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    // Remove existing session
    if (sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      session.sock?.end();
      sessions.delete(sessionId);
    }
    
    // Clear Redis data
    await redisClient.del(`qr:${sessionId}`);
    await redisClient.del(`session:${sessionId}`);
    
    // Clear auth folder
    const authFolder = path.join(__dirname, 'auth-sessions', sessionId);
    await fs.rm(authFolder, { recursive: true, force: true });
    
    // Recreate session
    await createWhatsAppSession(sessionId);
    
    // Wait for QR
    await new Promise(resolve => setTimeout(resolve, 2000));
    const qr = await redisClient.get(`qr:${sessionId}`);
    
    res.json({
      success: true,
      qr: qr || null,
      status: qr ? 'waiting_qr' : 'initializing'
    });
  } catch (error) {
    console.error('Error refreshing QR:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/messages/send', async (req, res) => {
  try {
    const { sessionId, to, text } = req.body;
    const session = sessions.get(sessionId);
    
    if (!session?.sock || !session.isAuthenticated) {
      return res.status(400).json({ error: 'Session not ready' });
    }
    
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    sessions: sessions.size,
    uptime: process.uptime()
  });
});

// WebSocket
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('join-qr-room', (sessionId) => {
    socket.join(`qr-${sessionId}`);
  });
  
  socket.on('join-session-room', (sessionId) => {
    socket.join(`session-${sessionId}`);
  });
  
  // Support legacy event names for compatibility
  socket.on('join-session', (sessionId) => {
    socket.join(`session-${sessionId}`);
  });
  
  socket.on('subscribe:session', (sessionId) => {
    socket.join(`session-${sessionId}`);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`WhatsApp service running on port ${PORT}`);
});
