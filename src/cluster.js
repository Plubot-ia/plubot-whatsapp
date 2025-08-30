import cluster from 'cluster';
import os from 'os';
import { createAdapter } from '@socket.io/cluster-adapter';
import { setupWorker } from '@socket.io/sticky';
import { setupMaster } from '@socket.io/sticky';
import logger from './core/utils/logger.js';

const WORKER_COUNT = parseInt(process.env.WORKER_COUNT) || os.cpus().length;
const PORT = process.env.PORT || 3001;

if (cluster.isPrimary) {
  logger.info(`🚀 Master process ${process.pid} is running`);
  logger.info(`📊 Starting ${WORKER_COUNT} workers...`);

  // Setup sticky sessions for WebSocket
  const httpServer = require('http').createServer();
  setupMaster(httpServer, {
    loadBalancingMethod: 'least-connection'
  });

  httpServer.listen(PORT, () => {
    logger.info(`🎯 Master listening on port ${PORT}`);
  });

  // Fork workers
  for (let i = 0; i < WORKER_COUNT; i++) {
    const worker = cluster.fork();
    logger.info(`👷 Worker ${worker.process.pid} started`);
  }

  // Handle worker lifecycle
  cluster.on('exit', (worker, code, signal) => {
    logger.error(`💀 Worker ${worker.process.pid} died (${signal || code})`);
    
    // Restart worker after crash
    if (!worker.exitedAfterDisconnect) {
      logger.info('🔄 Starting a new worker...');
      const newWorker = cluster.fork();
      logger.info(`👷 New worker ${newWorker.process.pid} started`);
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('🛑 SIGTERM received, shutting down gracefully...');
    
    for (const id in cluster.workers) {
      cluster.workers[id].disconnect();
    }
    
    setTimeout(() => {
      process.exit(0);
    }, 10000);
  });

  // Monitor worker health
  setInterval(() => {
    const workers = Object.values(cluster.workers);
    const activeWorkers = workers.filter(w => !w.isDead());
    
    logger.info(`📊 Cluster Status: ${activeWorkers.length}/${WORKER_COUNT} workers active`, {
      workers: activeWorkers.map(w => ({
        pid: w.process.pid,
        state: w.state
      }))
    });
  }, 30000); // Every 30 seconds

} else {
  // Worker process
  logger.info(`👷 Worker ${process.pid} started`);
  
  // Import and start the application
  import('./app.js').then(({ startApp }) => {
    setupWorker(io => {
      io.adapter(createAdapter());
    });
    
    startApp().catch(err => {
      logger.error('Failed to start worker app:', err);
      process.exit(1);
    });
  });

  // Handle worker shutdown
  process.on('SIGTERM', () => {
    logger.info(`👷 Worker ${process.pid} shutting down...`);
    process.exit(0);
  });

  // Monitor worker memory
  setInterval(() => {
    const usage = process.memoryUsage();
    logger.debug(`💾 Worker ${process.pid} memory:`, {
      rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`
    });

    // Restart worker if memory usage is too high
    if (usage.rss > 500 * 1024 * 1024) { // 500MB
      logger.warn(`⚠️ Worker ${process.pid} memory usage too high, restarting...`);
      process.exit(0);
    }
  }, 60000); // Every minute
}

export default cluster;
