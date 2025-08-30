import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';

async function testQR() {
  console.log('🚀 Testing simple QR generation...\n');
  
  // Clean auth folder
  const authPath = './test-auth-' + Date.now();
  
  // Create auth state
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  
  // Create socket
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });
  
  // Listen for QR
  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update;
    
    if (qr) {
      console.log('✅ QR GENERATED!\n');
      qrcode.generate(qr, { small: true });
      console.log('\nQR String:', qr.substring(0, 50) + '...');
    }
    
    if (connection === 'close') {
      console.log('❌ Connection closed');
    }
    
    if (connection === 'open') {
      console.log('✅ Connected!');
    }
  });
  
  sock.ev.on('creds.update', saveCreds);
}

testQR().catch(console.error);
