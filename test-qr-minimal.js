import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'fs/promises';
import pino from 'pino';

async function testQR() {
  const sessionId = 'test-' + Date.now();
  const authPath = `./test-auth-${sessionId}`;
  
  // Ensure clean start
  try {
    await fs.rm(authPath, { recursive: true, force: true });
  } catch {}
  
  console.log('Creating auth state at:', authPath);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  
  const logger = pino({ level: 'silent' });
  
  console.log('Creating socket...');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // Handle manually
    browser: ['Test Client', 'Chrome', '1.0.0'],
    logger
  });
  
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', (update) => {
    console.log('Connection update:', update);
    
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('\n=== QR CODE GENERATED ===');
      qrcode.generate(qr, { small: true });
      console.log('=========================\n');
    }
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Should reconnect?', shouldReconnect);
      
      if (shouldReconnect) {
        console.log('Reconnecting...');
        testQR();
      }
    } else if (connection === 'open') {
      console.log('✅ Connected successfully!');
      // Clean up after successful connection
      setTimeout(async () => {
        sock.end();
        await fs.rm(authPath, { recursive: true, force: true });
        process.exit(0);
      }, 5000);
    }
  });
}

testQR().catch(console.error);
