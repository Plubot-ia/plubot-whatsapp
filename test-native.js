import http from 'node:http';

import { Client } from 'whatsapp-web.js';

import logger from './src/utils/logger.js';

const client = new Client();
logger.info('Creating WhatsApp client...');

client.on('qr', (qr) => {
  // Generate and scan this code with your phone
  logger.info('QR RECEIVED', qr);
});

client.on('ready', () => {
  logger.info('Client is ready!');
});

client.initialize();

const server = http.createServer((req, res) => {
  logger.info(`Request: ${req.method} ${req.url}`);

  if (req.url === '/test') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(3001, () => {
  logger.info('Test server running on port 3001');
});
