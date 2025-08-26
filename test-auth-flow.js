import { io } from 'socket.io-client';
import fetch from 'node-fetch';

console.log('🔍 Testing WhatsApp Authentication Flow\n');

const API_URL = 'http://localhost:3001';
const userId = 'test-user';
const plubotId = 'test-plubot';
const sessionId = `${userId}:${plubotId}`;

async function testAuthenticationFlow() {
  console.log('1️⃣ Creating session...');
  
  // Create session
  const createResponse = await fetch(`${API_URL}/api/sessions/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, plubotId })
  });
  
  const sessionData = await createResponse.json();
  console.log('✅ Session created:', sessionData.data?.status);
  
  console.log('\n2️⃣ Connecting to WebSocket...');
  
  // Connect to WebSocket
  const socket = io(API_URL, {
    transports: ['websocket', 'polling'],
    reconnection: false
  });
  
  return new Promise((resolve) => {
    socket.on('connect', () => {
      console.log('✅ WebSocket connected');
      console.log('   Socket ID:', socket.id);
      
      // Join the room to receive events
      const roomId = `qr-${sessionId}`;
      console.log(`   Joining room: ${roomId}`);
      socket.emit('join-room', roomId);
    });
    
    socket.on('room-joined', (data) => {
      console.log('✅ Room joined:', data);
    });
    
    // Listen for authentication events
    socket.on('session-authenticated', (data) => {
      console.log('\n🎉 SESSION AUTHENTICATED EVENT RECEIVED!');
      console.log('   Data:', data);
      console.log('\n✅ Authentication flow working correctly!');
      console.log('   The frontend should now show "Plubot Conectado"');
      socket.disconnect();
      resolve();
    });
    
    socket.on('session-ready', (data) => {
      console.log('\n📱 SESSION READY EVENT RECEIVED!');
      console.log('   Data:', data);
    });
    
    socket.on('qr', (data) => {
      console.log('\n📲 QR EVENT RECEIVED');
      console.log('   Has QR:', !!data.qr);
    });
    
    socket.on('auth-failed', (data) => {
      console.log('\n❌ AUTH FAILED EVENT:', data);
    });
    
    socket.on('session-disconnected', (data) => {
      console.log('\n📵 SESSION DISCONNECTED EVENT:', data);
    });
    
    socket.on('connect_error', (error) => {
      console.error('❌ Connection error:', error.message);
      resolve();
    });
    
    // Monitor for 30 seconds
    setTimeout(() => {
      console.log('\n⏱️ Test timeout - no authentication event received');
      console.log('Please scan the QR code with WhatsApp to test authentication');
      socket.disconnect();
      resolve();
    }, 30000);
    
    console.log('\n3️⃣ Waiting for authentication events...');
    console.log('   Please scan the QR code in the frontend');
    console.log('   Monitoring for events for 30 seconds...\n');
  });
}

testAuthenticationFlow()
  .then(() => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Test completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
  });
