import express from 'express';

import logger from './src/utils/logger.js';

const app = express();

app.get('/test', (req, res) => {
  logger.info('Test endpoint hit');
  res.json({ message: 'Test successful' });
});

const server = app.listen(3002, () => {
  logger.info('Test server running on port 3002');
});

const testServer = async () => {
  try {
    logger.info('Testing server connection...');
    const response = await fetch('http://localhost:3001/health');
    const data = await response.json();

    if (data.status === 'ok') {
      logger.info('✅ Server is running');
    } else {
      throw new Error('Server health check failed');
    }
  } catch (error) {
    logger.error('❌ Error:', error.message);
    if (error.code === 'ECONNREFUSED') {
      logger.error('Server is not running. Start it with: npm start');
    }
    throw error;
  }

  logger.info('✅ Test completed successfully!');
};

// Test after 2 seconds
setTimeout(async () => {
  try {
    await testServer();
    const response = await fetch('http://localhost:3002/test');
    const data = await response.json();
    logger.info('Response received:', data);
    server.close();
  } catch (error) {
    logger.error('Error:', error);
    server.close();
    throw error;
  }
}, 2000);
