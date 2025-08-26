import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import logger from './src/utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logFile = path.join(__dirname, 'server-test.log');

/**
 *
 * @param message
 */
const logToFile = async (message) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;

  await fs.appendFile(logFile, logMessage);
  logger.info(message);
};

const app = express();
const PORT = 3004;

app.get('/test', async (req, res) => {
  await logToFile('Test endpoint called');
  const response = { status: 'ok', timestamp: new Date().toISOString() };
  res.status(200).json(response);
  await logToFile('Response sent');
});

app.listen(PORT, async () => {
  await logToFile(`Test server running on port ${PORT}`);
});
