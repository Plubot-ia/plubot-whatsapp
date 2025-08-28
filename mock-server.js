import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    credentials: true
  }
});

app.use(cors());
app.use(express.json());

// Mock QR data
const MOCK_QR = '2@AhKpQwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUiOpAsDfGhJkLzXcVbNm1234567890,qwertyuiopasdfghjklzxcvbnm,1234567890==';

// Store sessions
const sessions = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Create session - returns mock QR immediately
app.post('/api/sessions/create', async (req, res) => {
  const { userId, plubotId } = req.body;
  const sessionId = `${userId}-${plubotId}`;
  
  console.log(`Creating mock session: ${sessionId}`);
  
  // Create mock session
  const sessionData = {
    status: 'waiting_qr',
    qr: MOCK_QR,
    qrDataUrl: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==`
  };
  
  sessions.set(sessionId, sessionData);
  
  // Emit QR update via WebSocket
  setTimeout(() => {
    io.emit(`qr-update-${sessionId}`, {
      qr: MOCK_QR,
      qrDataUrl: sessionData.qrDataUrl,
      status: 'waiting_qr'
    });
  }, 100);
  
  res.json({
    success: true,
    sessionId,
    status: 'waiting_qr',
    qr: MOCK_QR,
    qrDataUrl: sessionData.qrDataUrl
  });
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
app.post('/api/sessions/refresh-qr', (req, res) => {
  const { sessionId } = req.body;
  
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  
  // Generate new mock QR
  session.qr = MOCK_QR + Date.now();
  
  res.json({
    success: true,
    qr: session.qr,
    qrDataUrl: session.qrDataUrl
  });
});

const PORT = 3001;
httpServer.listen(PORT, () => {
  console.log(`Mock WhatsApp service running on port ${PORT}`);
  console.log(`WebSocket server ready`);
});
