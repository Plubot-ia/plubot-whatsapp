import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import QRCode from 'qrcode';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: 'http://localhost:5174',
    credentials: true
  }
});

app.use(cors({
  origin: 'http://localhost:5174',
  credentials: true
}));
app.use(express.json());

// Store sessions
const sessions = new Map();
const clients = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    sessions: sessions.size 
  });
});

// Create session endpoint
app.post('/api/sessions/create', async (req, res) => {
  try {
    const { userId, plubotId } = req.body;
    const sessionId = `${userId}-${plubotId}`;
    
    console.log(`Creating WhatsApp session: ${sessionId}`);
    
    // Check if session exists
    if (clients.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (session && session.qr) {
        return res.json({
          success: true,
          sessionId,
          status: session.status,
          qr: session.qr,
          qrDataUrl: session.qrDataUrl
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
    
    // Wait for QR
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

// Get QR
app.get('/api/qr/:userId/:plubotId', (req, res) => {
  const { userId, plubotId } = req.params;
  const sessionId = `${userId}-${plubotId}`;
  
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  res.json({
    success: true,
    qr: session.qr,
    qrDataUrl: session.qrDataUrl,
    status: session.status
  });
});

// Refresh QR
app.post('/api/sessions/refresh-qr', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    // Destroy old client
    const oldClient = clients.get(sessionId);
    if (oldClient) {
      await oldClient.destroy();
      clients.delete(sessionId);
    }
    
    // Create new session
    const [userId, ...plubotParts] = sessionId.split('-');
    const plubotId = plubotParts.join('-');
    
    // Redirect to create
    const createRes = await fetch('http://localhost:3001/api/sessions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, plubotId })
    });
    
    const data = await createRes.json();
    res.json(data);
    
  } catch (error) {
    console.error('Error refreshing QR:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

const PORT = 3001;
httpServer.listen(PORT, () => {
  console.log(`🚀 Real WhatsApp service running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for localhost:5174`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  
  for (const [sessionId, client] of clients) {
    await client.destroy();
  }
  
  httpServer.close(() => {
    process.exit(0);
  });
});
