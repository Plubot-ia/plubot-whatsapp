import cluster from 'cluster';
import os from 'os';
import { EventEmitter } from 'events';
import logger from '../utils/logger.js';
import { clusterConfig } from '../config/cluster.config.js';

/**
 * Cluster Manager for horizontal scaling
 * Manages worker processes and load distribution
 */
export class ClusterManager extends EventEmitter {
  constructor() {
    super();
    
    this.workers = new Map();
    this.sessionDistribution = new Map();
    this.workerStats = new Map();
    this.restartCount = new Map();
    
    this.config = clusterConfig;
  }
  
  /**
   * Initialize cluster
   */
  async initialize() {
    if (cluster.isPrimary) {
      await this._initializePrimary();
    } else {
      await this._initializeWorker();
    }
  }
  
  /**
   * Initialize primary process
   */
  async _initializePrimary() {
    logger.info(`Primary process ${process.pid} starting...`);
    
    // Fork workers
    const numWorkers = this.config.workers;
    for (let i = 0; i < numWorkers; i++) {
      this._forkWorker(i);
    }
    
    // Handle worker events
    cluster.on('exit', (worker, code, signal) => {
      logger.error(`Worker ${worker.process.pid} died (${signal || code})`);
      this._handleWorkerExit(worker);
    });
    
    cluster.on('online', (worker) => {
      logger.info(`Worker ${worker.process.pid} is online`);
      this.workers.set(worker.id, worker);
      this._initializeWorkerStats(worker.id);
    });
    
    cluster.on('message', (worker, message) => {
      this._handleWorkerMessage(worker, message);
    });
    
    // Start monitoring
    this._startMonitoring();
    
    // Handle graceful shutdown
    process.on('SIGTERM', () => this._gracefulShutdown());
    process.on('SIGINT', () => this._gracefulShutdown());
  }
  
  /**
   * Initialize worker statistics
   */
  _initializeWorkerStats(workerId) {
    this.workerStats.set(workerId, {
      startTime: Date.now(),
      restarts: 0,
      memoryUsage: 0,
      cpuUsage: 0,
      requestsHandled: 0,
      errors: 0,
      lastActivity: Date.now(),
    });
  }
  
  /**
   * Fork a new worker
   */
  _forkWorker(index) {
    const env = {
      ...process.env,
      WORKER_INDEX: index,
      WORKER_TYPE: 'whatsapp',
    };
    
    const worker = cluster.fork(env);
    worker.workerId = index;
    
    // Set memory limit
    if (this.config.maxMemory) {
      worker.send({
        type: 'SET_MEMORY_LIMIT',
        limit: this.config.maxMemory,
      });
    }
    
    return worker;
  }
  
  /**
   * Handle worker exit
   */
  _handleWorkerExit(worker) {
    this.workers.delete(worker.id);
    
    // Check restart count
    const restarts = this.restartCount.get(worker.workerId) || 0;
    
    if (restarts < this.config.maxRestarts) {
      this.restartCount.set(worker.workerId, restarts + 1);
      
      setTimeout(() => {
        logger.info(`Restarting worker ${worker.workerId}`);
        this._forkWorker(worker.workerId);
      }, this.config.restartDelay);
    } else {
      logger.error(`Worker ${worker.workerId} exceeded max restarts`);
      this.emit('worker:max-restarts', worker.workerId);
    }
  }
  
  /**
   * Handle messages from workers
   */
  _handleWorkerMessage(worker, message) {
    switch (message.type) {
      case 'SESSION_CREATED':
        this._assignSessionToWorker(message.sessionId, worker.id);
        break;
        
      case 'SESSION_DESTROYED':
        this._removeSessionFromWorker(message.sessionId, worker.id);
        break;
        
      case 'METRICS':
        this._updateWorkerMetrics(worker.id, message.metrics);
        break;
        
      case 'HEALTH_CHECK':
        this._handleHealthCheck(worker.id, message.status);
        break;
        
      case 'ERROR':
        logger.error(`Worker ${worker.id} error:`, message.error);
        this.emit('worker:error', { workerId: worker.id, error: message.error });
        break;
        
      default:
        // Forward to other workers if needed
        this._broadcastMessage(message, worker.id);
    }
  }
  
  /**
   * Assign session to worker
   */
  _assignSessionToWorker(sessionId, workerId) {
    this.sessionDistribution.set(sessionId, workerId);
    
    const sessions = this.workerStats.get(workerId)?.sessions || new Set();
    sessions.add(sessionId);
    
    const stats = this.workerStats.get(workerId) || {};
    stats.sessions = sessions;
    this.workerStats.set(workerId, stats);
    
    logger.debug(`Session ${sessionId} assigned to worker ${workerId}`);
  }
  
  /**
   * Remove session from worker
   */
  _removeSessionFromWorker(sessionId, workerId) {
    this.sessionDistribution.delete(sessionId);
    
    const stats = this.workerStats.get(workerId);
    if (stats?.sessions) {
      stats.sessions.delete(sessionId);
    }
    
    logger.debug(`Session ${sessionId} removed from worker ${workerId}`);
  }
  
  /**
   * Update worker metrics
   */
  _updateWorkerMetrics(workerId, metrics) {
    const stats = this.workerStats.get(workerId) || {};
    stats.metrics = metrics;
    stats.lastUpdate = Date.now();
    this.workerStats.set(workerId, stats);
  }
  
  /**
   * Handle health check response
   */
  _handleHealthCheck(workerId, status) {
    const stats = this.workerStats.get(workerId) || {};
    stats.health = status;
    stats.lastHealthCheck = Date.now();
    this.workerStats.set(workerId, stats);
    
    if (status !== 'healthy') {
      logger.warn(`Worker ${workerId} is ${status}`);
      this.emit('worker:unhealthy', { workerId, status });
    }
  }
  
  /**
   * Get optimal worker for new session
   */
  getOptimalWorker() {
    let optimalWorker = null;
    let minLoad = Infinity;
    
    for (const [workerId, stats] of this.workerStats.entries()) {
      const worker = Array.from(this.workers.values()).find(w => w.id === workerId);
      
      if (!worker || stats.health !== 'healthy') {
        continue;
      }
      
      // Calculate load based on strategy
      let load = 0;
      
      switch (this.config.sessionStrategy) {
        case 'least-connections':
          load = stats.sessions?.size || 0;
          break;
          
        case 'least-memory':
          load = stats.metrics?.memory?.heapUsed || 0;
          break;
          
        case 'least-cpu':
          load = stats.metrics?.cpu || 0;
          break;
          
        default: // round-robin
          load = Math.random();
      }
      
      if (load < minLoad) {
        minLoad = load;
        optimalWorker = worker;
      }
    }
    
    return optimalWorker;
  }
  
  /**
   * Route request to appropriate worker
   */
  async routeRequest(sessionId, request) {
    const workerId = this.sessionDistribution.get(sessionId);
    
    if (!workerId) {
      // Assign to optimal worker
      const worker = this.getOptimalWorker();
      if (!worker) {
        throw new Error('No available workers');
      }
      
      this._assignSessionToWorker(sessionId, worker.id);
      return this._sendToWorker(worker, request);
    }
    
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker ${workerId} not found`);
    }
    
    return this._sendToWorker(worker, request);
  }
  
  /**
   * Send message to worker
   */
  async _sendToWorker(worker, message) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Worker response timeout'));
      }, this.config.ipcTimeout);
      
      const messageId = Date.now().toString();
      
      const handler = (response) => {
        if (response.messageId === messageId) {
          clearTimeout(timeout);
          worker.removeListener('message', handler);
          
          if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response.data);
          }
        }
      };
      
      worker.on('message', handler);
      worker.send({ ...message, messageId });
    });
  }
  
  /**
   * Broadcast message to all workers
   */
  _broadcastMessage(message, excludeWorkerId = null) {
    for (const worker of this.workers.values()) {
      if (worker.id !== excludeWorkerId) {
        worker.send(message);
      }
    }
  }
  
  /**
   * Start monitoring workers
   */
  _startMonitoring() {
    // Health check interval
    setInterval(() => {
      for (const worker of this.workers.values()) {
        worker.send({ type: 'HEALTH_CHECK_REQUEST' });
      }
    }, this.config.healthCheckInterval);
    
    // Metrics collection
    setInterval(() => {
      for (const worker of this.workers.values()) {
        worker.send({ type: 'METRICS_REQUEST' });
      }
      
      // Emit aggregated metrics
      this.emit('metrics:aggregated', this.getAggregatedMetrics());
    }, 10000);
    
    // Memory monitoring
    setInterval(() => {
      for (const [workerId, stats] of this.workerStats.entries()) {
        const memoryUsage = stats.metrics?.memory?.heapUsed || 0;
        
        if (memoryUsage > this.config.maxMemory * 0.9) {
          logger.warn(`Worker ${workerId} memory usage high: ${memoryUsage}MB`);
          const worker = Array.from(this.workers.values()).find(w => w.id === workerId);
          
          if (worker) {
            worker.send({ type: 'MEMORY_WARNING' });
          }
        }
      }
    }, 30000);
  }
  
  /**
   * Get aggregated metrics from all workers
   */
  getAggregatedMetrics() {
    const aggregated = {
      workers: this.workers.size,
      totalSessions: 0,
      totalMemory: 0,
      avgCpu: 0,
      workerDetails: [],
    };
    
    for (const [workerId, stats] of this.workerStats.entries()) {
      aggregated.totalSessions += stats.sessions?.size || 0;
      aggregated.totalMemory += stats.metrics?.memory?.heapUsed || 0;
      aggregated.avgCpu += stats.metrics?.cpu || 0;
      
      aggregated.workerDetails.push({
        id: workerId,
        sessions: stats.sessions?.size || 0,
        memory: stats.metrics?.memory?.heapUsed || 0,
        cpu: stats.metrics?.cpu || 0,
        health: stats.health || 'unknown',
      });
    }
    
    if (this.workers.size > 0) {
      aggregated.avgCpu /= this.workers.size;
    }
    
    return aggregated;
  }
  
  /**
   * Graceful shutdown
   */
  async _gracefulShutdown() {
    logger.info('Starting graceful shutdown...');
    
    // Signal all workers to shutdown
    this._broadcastMessage({ type: 'SHUTDOWN' });
    
    // Wait for workers to finish
    const shutdownTimeout = setTimeout(() => {
      logger.warn('Forcing worker shutdown...');
      for (const worker of this.workers.values()) {
        worker.kill();
      }
    }, this.config.shutdownTimeout);
    
    // Wait for all workers to exit
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.workers.size === 0) {
          clearInterval(checkInterval);
          clearTimeout(shutdownTimeout);
          resolve();
        }
      }, 100);
    });
    
    logger.info('All workers shut down');
    process.exit(0);
  }
  
  /**
   * Initialize worker process
   */
  async _initializeWorker() {
    logger.info(`Worker ${process.pid} starting...`);
    
    // Handle messages from primary
    process.on('message', (message) => {
      this._handlePrimaryMessage(message);
    });
    
    // Send ready signal
    process.send({ type: 'WORKER_READY', pid: process.pid });
  }
  
  /**
   * Handle messages from primary process
   */
  _handlePrimaryMessage(message) {
    switch (message.type) {
      case 'HEALTH_CHECK_REQUEST':
        this._sendHealthStatus();
        break;
        
      case 'METRICS_REQUEST':
        this._sendMetrics();
        break;
        
      case 'SHUTDOWN':
        this._workerShutdown();
        break;
        
      case 'MEMORY_WARNING':
        this._handleMemoryWarning();
        break;
        
      default:
        this.emit('message', message);
    }
  }
  
  /**
   * Send health status to primary
   */
  _sendHealthStatus() {
    const status = this._checkHealth();
    process.send({
      type: 'HEALTH_CHECK',
      status,
      timestamp: Date.now(),
    });
  }
  
  /**
   * Check worker health
   */
  _checkHealth() {
    const memUsage = process.memoryUsage();
    const maxMemory = this.config.maxMemory * 1024 * 1024;
    
    if (memUsage.heapUsed > maxMemory * 0.95) {
      return 'critical';
    }
    
    if (memUsage.heapUsed > maxMemory * 0.8) {
      return 'warning';
    }
    
    return 'healthy';
  }
  
  /**
   * Send metrics to primary
   */
  _sendMetrics() {
    const metrics = {
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      uptime: process.uptime(),
      timestamp: Date.now(),
    };
    
    process.send({
      type: 'METRICS',
      metrics,
    });
  }
  
  /**
   * Handle memory warning
   */
  _handleMemoryWarning() {
    logger.warn('Memory warning received, running garbage collection...');
    
    if (global.gc) {
      global.gc();
    }
    
    this.emit('memory:warning');
  }
  
  /**
   * Worker shutdown
   */
  async _workerShutdown() {
    logger.info(`Worker ${process.pid} shutting down...`);
    
    this.emit('shutdown');
    
    // Give time for cleanup
    setTimeout(() => {
      process.exit(0);
    }, 5000);
  }
}

export default ClusterManager;
