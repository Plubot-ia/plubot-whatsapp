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

async function testAuthFlow() {
  const authPath = './test-auth-' + Date.now();
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  
  const sock = makeWASocket({
    auth: state,
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
      console.log('Session should now be authenticated');
      
      // Get user info
      const user = sock.user;
      if (user) {
        console.log('📱 Connected as:', user.id);
        console.log('📱 Phone number:', user.name || 'Unknown');
      }
    }
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ Connection closed');
      console.log('Should reconnect:', shouldReconnect);
      console.log('Reason:', lastDisconnect?.error?.output?.payload?.error);
      
      if (!shouldReconnect) {
        process.exit(0);
      }
    }
  });

  sock.ev.on('creds.update', async () => {
    console.log('🔐 CREDENTIALS UPDATED - Saving auth state');
    await saveCreds();
  });

  // Listen for auth state changes
  sock.authState.creds.me && console.log('👤 Authenticated user:', sock.authState.creds.me);
}

testAuthFlow().catch(console.error);
