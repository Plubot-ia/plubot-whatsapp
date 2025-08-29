import fetch from 'node-fetch';

const API_URL = 'http://localhost:3001';
const sessionId = 'test-123';

async function checkAuth() {
  console.log('Checking authentication status...\n');
  
  setInterval(async () => {
    try {
      // Check health
      const healthRes = await fetch(`${API_URL}/api/health`);
      const health = await healthRes.json();
      console.log('Health:', health);
      
      // Try to send a test message
      const sendRes = await fetch(`${API_URL}/api/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          to: '5491234567890', // Replace with a test number
          text: 'Test message from Baileys!'
        })
      });
      
      const result = await sendRes.json();
      console.log('Send result:', result);
      
    } catch (error) {
      console.error('Error:', error.message);
    }
  }, 5000);
}

checkAuth();
