const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const io = require('socket.io-client');

class WhatsAppBridge {
  constructor() {
    this.clients = new Map();
    this.socket = io('http://localhost:3001', {
      transports: ['websocket', 'polling']
    });
    
    this.socket.on('connect', () => {
      console.log('✅ Bridge connected to server');
    });
  }

  async createSession(userId, plubotId) {
    const sessionId = `${userId}-${plubotId}`;
    
    // Don't create duplicate sessions
    if (this.clients.has(sessionId)) {
      console.log(`Session ${sessionId} already exists`);
      return;
    }
    
    console.log(`🔄 Creating WhatsApp session: ${sessionId}`);
    
    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: './whatsapp-sessions'
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

    // Handle QR code
    client.on('qr', async (qr) => {
      console.log(`📱 QR received for ${sessionId}`);
      
      // Send QR to server
      try {
        await axios.post('http://localhost:3001/api/sessions/qr', {
          sessionId,
          qr
        });
        
        // Emit to WebSocket
        this.socket.emit('qr-update', {
          sessionId,
          qr
        });
        
        console.log(`📤 QR sent for ${sessionId}`);
      } catch (error) {
        console.error('Error sending QR:', error.message);
      }
    });

    // Handle authentication
    client.on('authenticated', async () => {
      console.log(`✅ Session ${sessionId} authenticated!`);
      
      try {
        await axios.post('http://localhost:3001/api/sessions/authenticated', {
          sessionId
        });
        
        this.socket.emit('session-authenticated', {
          sessionId,
          status: 'authenticated'
        });
      } catch (error) {
        console.error('Error updating auth:', error.message);
      }
    });

    // Handle ready
    client.on('ready', async () => {
      console.log(`✨ Session ${sessionId} ready!`);
      
      try {
        await axios.post('http://localhost:3001/api/sessions/ready', {
          sessionId
        });
        
        this.socket.emit('session-ready', {
          sessionId,
          status: 'ready'
        });
      } catch (error) {
        console.error('Error updating ready:', error.message);
      }
    });

    // Handle auth failure
    client.on('auth_failure', (msg) => {
      console.error(`❌ Auth failure for ${sessionId}:`, msg);
      this.socket.emit('auth-failure', {
        sessionId,
        error: msg
      });
    });

    // Handle disconnection
    client.on('disconnected', (reason) => {
      console.log(`🔌 Session ${sessionId} disconnected:`, reason);
      this.clients.delete(sessionId);
    });

    // Store client
    this.clients.set(sessionId, client);
    
    // Initialize
    await client.initialize();
    console.log(`✅ Session ${sessionId} initialized`);
  }

  async destroySession(sessionId) {
    const client = this.clients.get(sessionId);
    if (client) {
      await client.destroy();
      this.clients.delete(sessionId);
      console.log(`🗑️ Session ${sessionId} destroyed`);
    }
  }
}

// Start the bridge
const bridge = new WhatsAppBridge();

// Listen for session creation requests
bridge.socket.on('create-session', async (data) => {
  const { userId, plubotId } = data;
  await bridge.createSession(userId, plubotId);
});

// Listen for session destruction requests
bridge.socket.on('destroy-session', async (data) => {
  const { sessionId } = data;
  await bridge.destroySession(sessionId);
});

// Auto-create session for testing
setTimeout(async () => {
  console.log('🚀 Auto-creating session for user123-260');
  await bridge.createSession('user123', '260');
}, 2000);

console.log('🌉 WhatsApp Bridge started');
console.log('📡 Listening for session requests...');

// Keep process alive
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down bridge...');
  bridge.clients.forEach(client => client.destroy());
  bridge.socket.disconnect();
  process.exit(0);
});
