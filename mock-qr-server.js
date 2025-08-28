import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
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
    
    console.log(`Creating mock WhatsApp session: ${sessionId}`);
    
    // Generate a realistic WhatsApp QR code string
    const qrString = `2@AHJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=,${Date.now()},${sessionId},==`;
    
    // Generate QR data URL
    const qrDataUrl = await QRCode.toDataURL(qrString, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      }
    });
    
    // Store session
    const sessionData = {
      status: 'waiting_qr',
      qr: qrString,
      qrDataUrl: qrDataUrl,
      phoneNumber: null
    };
    
    sessions.set(sessionId, sessionData);
    
    // Emit QR update via WebSocket
    io.emit(`qr-update-${sessionId}`, {
      qr: qrString,
      qrDataUrl: qrDataUrl,
      status: 'waiting_qr'
    });
    
    // Simulate authentication after 10 seconds
    setTimeout(() => {
      sessionData.status = 'authenticated';
      sessionData.qr = null;
      sessionData.qrDataUrl = null;
      io.emit(`session-authenticated-${sessionId}`, {
        status: 'authenticated'
      });
      
      // Simulate ready after 2 more seconds
      setTimeout(() => {
        sessionData.status = 'ready';
        sessionData.phoneNumber = '+1234567890';
        io.emit(`session-ready-${sessionId}`, {
          status: 'ready',
          phoneNumber: sessionData.phoneNumber
        });
      }, 2000);
    }, 10000);
    
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
    
    // Generate new QR
    const qrString = `2@REFRESHED${Date.now()}${sessionId}==`;
    const qrDataUrl = await QRCode.toDataURL(qrString, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      }
    });
    
    // Update session
    const session = sessions.get(sessionId);
    if (session) {
      session.qr = qrString;
      session.qrDataUrl = qrDataUrl;
      session.status = 'waiting_qr';
    }
    
    res.json({
      success: true,
      qr: qrString,
      qrDataUrl: qrDataUrl,
      status: 'waiting_qr'
    });
    
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
  console.log(`🚀 Mock WhatsApp QR service running on port ${PORT}`);
  console.log(`📡 WebSocket server ready for localhost:5174`);
});
