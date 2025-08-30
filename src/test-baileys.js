import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';

const logger = pino({ level: 'info' });

async function connectToWhatsApp() {
    const sessionId = 'test-' + Date.now();
    const authFolder = `./auth-sessions/${sessionId}`;
    
    console.log('🚀 Starting WhatsApp connection...');
    console.log('📁 Auth folder:', authFolder);
    
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger,
        browser: ['Ubuntu', 'Chrome', '22.04.4']
    });
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('✅ QR CODE RECEIVED!');
            console.log('QR Length:', qr.length);
            console.log('QR Preview:', qr.substring(0, 50) + '...');
            
            // This is where we would store in Redis and emit to WebSocket
            console.log('📤 Would emit QR to WebSocket and store in Redis');
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Connection closed. Should reconnect?', shouldReconnect);
            
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp!');
        }
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    return sock;
}

// Run the test
connectToWhatsApp().catch(console.error);
