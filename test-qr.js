import fetch from 'node-fetch';
import qrcode from 'qrcode-terminal';

const API_URL = 'http://localhost:3001';

async function testQR() {
  console.log('Creating session...');
  
  // Create session
  const createRes = await fetch(`${API_URL}/api/sessions/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'test', plubotId: '123' })
  });
  
  const session = await createRes.json();
  console.log('Session created:', session);
  
  // Poll for QR
  let attempts = 0;
  const pollQR = setInterval(async () => {
    attempts++;
    console.log(`\nPolling QR (attempt ${attempts})...`);
    
    const qrRes = await fetch(`${API_URL}/api/qr/test/123`);
    const qrData = await qrRes.json();
    
    if (qrData.success && qrData.qr) {
      console.log('\n✅ QR CODE RECEIVED! Scan with WhatsApp:\n');
      qrcode.generate(qrData.qr, { small: true });
      clearInterval(pollQR);
    } else if (attempts > 30) {
      console.log('❌ Timeout waiting for QR');
      clearInterval(pollQR);
    }
  }, 2000);
}

testQR().catch(console.error);
