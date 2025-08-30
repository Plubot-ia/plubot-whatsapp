import axios from 'axios';

const API_URL = 'http://localhost:3001';
const API_KEY = 'dev-api-key-2024-secure';

async function testQRGeneration() {
  try {
    console.log('🚀 Testing QR generation...\n');
    
    const userId = 'test-user-' + Date.now();
    const plubotId = String(Date.now());
    
    // Create session
    console.log('📝 Creating session...');
    const createResponse = await axios.post(
      `${API_URL}/api/sessions/create`,
      { userId, plubotId },
      { headers: { 'x-api-key': API_KEY } }
    );
    
    console.log('✅ Session created:', createResponse.data);
    
    // Wait a bit for QR generation
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Get QR
    console.log('\n📱 Getting QR code...');
    const qrResponse = await axios.get(
      `${API_URL}/api/qr/${userId}/${plubotId}`,
      { headers: { 'x-api-key': API_KEY } }
    );
    
    if (qrResponse.data.success && qrResponse.data.qr) {
      console.log('✅ QR received!');
      console.log('QR Length:', qrResponse.data.qr.length);
      console.log('QR Preview:', qrResponse.data.qr.substring(0, 50) + '...');
    } else {
      console.log('❌ No QR received:', qrResponse.data);
    }
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

testQRGeneration();
