import { io } from 'socket.io-client';

const socket = io('http://localhost:3001', {
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 5
});

socket.on('connect', () => {
  console.log('✅ Connected to WebSocket server');
  console.log('Socket ID:', socket.id);
  
  // Join a test room
  socket.emit('join-room', 'test-user:test-plubot');
});

socket.on('disconnect', (reason) => {
  console.log('❌ Disconnected:', reason);
});

socket.on('error', (error) => {
  console.error('❌ Socket error:', error);
});

socket.on('qr', (data) => {
  console.log('📱 QR received:', data.qr ? 'QR code available' : 'No QR');
});

socket.on('session-ready', (data) => {
  console.log('✅ Session ready:', data);
});

socket.on('session-authenticated', (data) => {
  console.log('✅ Session authenticated:', data);
});

// Keep the script running
setTimeout(() => {
  console.log('Test completed');
  socket.disconnect();
  process.exit(0);
}, 10000);
