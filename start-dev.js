#!/usr/bin/env node

import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import logger from './src/utils/logger.js';

// Load environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',') || [
      'http://localhost:3000',
      'http://localhost:5174',
      'http://localhost:5173',
    ],
    credentials: true,
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || [
    'http://localhost:3000',
    'http://localhost:5174',
    'http://localhost:5173',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'x-api-key'],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Import routes
import sessionsRouter from './src/routes/sessions.js';
import qrRouter from './src/routes/qr.js';
import messagesRouter from './src/routes/messages.js';
import flowRoutes from './src/routes/flow.js';

// Routes
app.use('/api/sessions', sessionsRouter);
app.use('/api/qr', qrRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/flow', flowRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/health/live', (req, res) => {
  res.json({ status: 'alive' });
});

app.get('/health/ready', (req, res) => {
  res.json({ status: 'ready' });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  socket.on('subscribe', (data) => {
    const { sessionId } = data;
    if (sessionId) {
      socket.join(sessionId);
      logger.info(`Client ${socket.id} subscribed to session ${sessionId}`);
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// Make io available to routes
app.set('io', io);

// Error handling
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  logger.info(`WhatsApp microservice running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`CORS enabled for: ${process.env.CORS_ORIGIN || 'http://localhost:5174'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  httpServer.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});
