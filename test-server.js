import cors from 'cors';
import express from 'express';

import { authenticateRequest } from './src/middleware/auth.js';
import logger from './src/utils/logger.js';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Test route with auth
app.post('/test-auth', authenticateRequest, (req, res) => {
  logger.info('Auth test endpoint hit');
  res.json({ message: 'Auth successful', body: req.body });
});

// Test route without auth
app.post('/test-no-auth', (req, res) => {
  logger.info('No auth test endpoint hit');
  res.json({ message: 'No auth successful', body: req.body });
});

const server = app.listen(3002, () => {
  logger.info('Test server listening on port 3002');
});

// Test both endpoints
setTimeout(async () => {
  try {
    // Test with auth
    logger.info('Testing WITH auth:');
    const response1 = await fetch('http://localhost:3002/test-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'internal-api-key',
      },
      body: JSON.stringify({ test: 'data' }),
    });
    const data1 = await response1.json();
    logger.info('Auth response:', data1);

    // Test without auth
    logger.info('Testing WITHOUT auth:');
    const response2 = await fetch('http://localhost:3002/test-no-auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ test: 'data' }),
    });
    const data2 = await response2.json();
    logger.info('No auth response:', data2);

    server.close();
    logger.info('Tests completed successfully');
  } catch (error) {
    logger.error('Test failed:', error);
    server.close();
    throw error;
  }
}, 1000);
