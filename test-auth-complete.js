import { makeWASocket, DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const logger = pino({ 
  level: 'debug',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname',
      translateTime: 'SYS:standard'
    }
  }
});

let sock = null;
let authState = null;
let saveCreds = null;

async function connectToWhatsApp(authPath) {
  if (!authState) {
    const auth = await useMultiFileAuthState(authPath);
    authState = auth.state;
    saveCreds = auth.saveCreds;
  }
  
  sock = makeWASocket({
    auth: authState,
    printQRInTerminal: false,
    logger,
    browser: ['WhatsApp Service', 'Chrome', '1.0.0'],
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    qrTimeout: 60000,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin, isOnline } = update;
    
    console.log('\n=== CONNECTION UPDATE ===');
    console.log('Connection:', connection);
    console.log('Has QR:', !!qr);
    console.log('Is New Login:', isNewLogin);
    console.log('Is Online:', isOnline);
    
    if (qr) {
      console.log('\n📱 SCAN THIS QR CODE:');
      qrcode.generate(qr, { small: true });
    }
    
    if (connection === 'connecting') {
      console.log('🔄 Connecting to WhatsApp...');
    }
    
    if (connection === 'open') {
      console.log('✅ CONNECTION OPEN - WhatsApp is ready!');
      console.log('Session successfully authenticated and connected');
      
      // Get user info
      const user = sock.user;
      if (user) {
        console.log('📱 Connected as:', user.id);
        console.log('📱 Phone number:', user.name || 'Unknown');
      }
    }
    
    if (connection === 'close') {
      const errorCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.output?.payload?.error;
      const shouldReconnect = errorCode !== DisconnectReason.loggedOut;
      
      console.log('❌ Connection closed');
      console.log('Error code:', errorCode);
      console.log('Error message:', errorMessage);
      console.log('Should reconnect:', shouldReconnect);
      
      // Handle error 515 (Stream Errored - restart required after pairing)
      if (errorCode === 515 || errorMessage?.includes('Stream Errored')) {
        console.log('⚠️ Error 515 detected - This is normal after QR scan');
        console.log('🔄 Restarting connection in 2 seconds...');
        
        setTimeout(() => {
          console.log('🔄 Reconnecting after pairing...');
          connectToWhatsApp(authPath);
        }, 2000);
        return;
      }
      
      if (!shouldReconnect) {
        console.log('📱 Logged out - Exiting');
        process.exit(0);
      }
      
      // Other reconnection scenarios
      if (shouldReconnect) {
        console.log('🔄 Attempting to reconnect in 5 seconds...');
        setTimeout(() => {
          connectToWhatsApp(authPath);
        }, 5000);
      }
    }
  });

  sock.ev.on('creds.update', async () => {
    console.log('🔐 CREDENTIALS UPDATED - Saving auth state');
    await saveCreds();
  });
}

async function testAuthFlow() {
  const authPath = './test-auth-' + Date.now();
  console.log('📁 Auth path:', authPath);
  console.log('🚀 Starting WhatsApp authentication test...\n');
  
  await connectToWhatsApp(authPath);
}

testAuthFlow().catch(console.error);
