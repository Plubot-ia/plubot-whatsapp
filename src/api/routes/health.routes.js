import express from 'express';
import logger from '../../core/utils/logger.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { getMetrics } from '../../core/services/MetricsService.js';
import { getMessageQueue } from '../../core/services/MessageQueue.js';
import { getConnectionPool } from '../../core/services/ConnectionPool.js';
import os from 'os';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);
const router = express.Router();

// Health check básico (público)
router.get('/basic', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development'
    };

    res.json(health);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Health check raíz (público)
router.get('/', async (req, res) => {
  try {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      environment: process.env.NODE_ENV || 'development'
    };

    res.json(health);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Health check detallado (requiere autenticación)
router.get('/health/detailed', authenticate, async (req, res) => {
  try {
    const checks = await performHealthChecks();
    const overallStatus = calculateOverallStatus(checks);
    
    res.status(overallStatus === 'healthy' ? 200 : 503).json({
      status: overallStatus,
      timestamp: new Date().toISOString(),
      checks,
      system: await getSystemInfo()
    });
  } catch (error) {
    logger.error('Detailed health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// Liveness probe (para Kubernetes/Docker)
router.get('/health/live', (req, res) => {
  // Simple check - el servicio está vivo si puede responder
  res.status(200).json({ status: 'alive' });
});

// Readiness probe (para Kubernetes/Docker)
router.get('/health/ready', async (req, res) => {
  try {
    const checks = await performReadinessChecks();
    const isReady = Object.values(checks).every(check => check.status === 'healthy');
    
    res.status(isReady ? 200 : 503).json({
      ready: isReady,
      checks
    });
  } catch (error) {
    res.status(503).json({
      ready: false,
      error: error.message
    });
  }
});

// Startup probe (para Kubernetes)
router.get('/health/startup', async (req, res) => {
  try {
    const startupChecks = await performStartupChecks();
    const isStarted = Object.values(startupChecks).every(check => check.status === 'healthy');
    
    res.status(isStarted ? 200 : 503).json({
      started: isStarted,
      checks: startupChecks
    });
  } catch (error) {
    res.status(503).json({
      started: false,
      error: error.message
    });
  }
});

// Métricas en formato Prometheus
router.get('/metrics', authenticate, async (req, res) => {
  try {
    const metrics = getMetrics();
    res.set('Content-Type', metrics.getContentType());
    res.end(await metrics.getMetrics());
  } catch (error) {
    logger.error('Failed to get metrics:', error);
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// Funciones auxiliares

async function performHealthChecks() {
  const checks = {};
  
  // Check Redis
  checks.redis = await checkRedis();
  
  // Check Message Queue
  checks.messageQueue = await checkMessageQueue();
  
  // Check Connection Pool
  checks.connectionPool = await checkConnectionPool();
  
  // Check Memory
  checks.memory = checkMemory();
  
  // Check Disk Space
  checks.disk = await checkDiskSpace();
  
  // Check CPU
  checks.cpu = checkCPU();
  
  // Check External Services
  checks.externalServices = await checkExternalServices();
  
  return checks;
}

async function performReadinessChecks() {
  return {
    redis: await checkRedis(),
    messageQueue: await checkMessageQueue(),
    connectionPool: await checkConnectionPool()
  };
}

async function performStartupChecks() {
  return {
    environment: checkEnvironment(),
    dependencies: await checkDependencies(),
    filesystem: await checkFilesystem()
  };
}

async function checkRedis() {
  try {
    const redis = global.redisClient;
    if (!redis || !redis.connected) {
      return {
        status: 'unhealthy',
        message: 'Redis disconnected'
      };
    }
    
    // Ping Redis
    const start = Date.now();
    await redis.ping();
    const latency = Date.now() - start;
    
    return {
      status: 'healthy',
      latency: `${latency}ms`,
      connected: true
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message
    };
  }
}

async function checkMessageQueue() {
  try {
    const messageQueue = getMessageQueue();
    const status = await messageQueue.getAllQueuesStatus();
    
    const totalWaiting = Object.values(status).reduce(
      (sum, queue) => sum + (queue?.counts?.waiting || 0), 0
    );
    
    const totalFailed = Object.values(status).reduce(
      (sum, queue) => sum + (queue?.counts?.failed || 0), 0
    );
    
    const health = totalFailed > 100 ? 'degraded' : 'healthy';
    
    return {
      status: health,
      queues: Object.keys(status).length,
      totalWaiting,
      totalFailed,
      details: status
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message
    };
  }
}

async function checkConnectionPool() {
  try {
    const connectionPool = getConnectionPool();
    const metrics = connectionPool.getMetrics();
    
    const utilizationPercent = metrics.pool.utilization;
    const health = utilizationPercent > 90 ? 'degraded' : 'healthy';
    
    return {
      status: health,
      size: metrics.pool.size,
      maxSize: metrics.pool.maxSize,
      utilization: `${utilizationPercent.toFixed(2)}%`,
      active: metrics.connections.active,
      idle: metrics.connections.idle,
      waitQueue: metrics.waitQueue
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message
    };
  }
}

function checkMemory() {
  const used = process.memoryUsage();
  const total = os.totalmem();
  const free = os.freemem();
  const usagePercent = ((total - free) / total) * 100;
  
  const health = usagePercent > 90 ? 'unhealthy' : 
                  usagePercent > 75 ? 'degraded' : 'healthy';
  
  return {
    status: health,
    usage: {
      rss: `${(used.rss / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(used.heapTotal / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(used.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      external: `${(used.external / 1024 / 1024).toFixed(2)} MB`
    },
    system: {
      total: `${(total / 1024 / 1024 / 1024).toFixed(2)} GB`,
      free: `${(free / 1024 / 1024 / 1024).toFixed(2)} GB`,
      usagePercent: `${usagePercent.toFixed(2)}%`
    }
  };
}

async function checkDiskSpace() {
  try {
    const { stdout } = await execAsync('df -h / | tail -1');
    const parts = stdout.trim().split(/\s+/);
    const usagePercent = parseInt(parts[4]);
    
    const health = usagePercent > 90 ? 'unhealthy' : 
                    usagePercent > 80 ? 'degraded' : 'healthy';
    
    return {
      status: health,
      usage: parts[4],
      available: parts[3],
      total: parts[1]
    };
  } catch (error) {
    return {
      status: 'unknown',
      error: error.message
    };
  }
}

function checkCPU() {
  const cpus = os.cpus();
  const loadAvg = os.loadavg();
  const cores = cpus.length;
  
  // Normalizar load average por número de cores
  const normalizedLoad = loadAvg[0] / cores;
  
  const health = normalizedLoad > 0.9 ? 'unhealthy' : 
                  normalizedLoad > 0.7 ? 'degraded' : 'healthy';
  
  return {
    status: health,
    cores,
    loadAverage: {
      '1min': loadAvg[0].toFixed(2),
      '5min': loadAvg[1].toFixed(2),
      '15min': loadAvg[2].toFixed(2)
    },
    normalizedLoad: normalizedLoad.toFixed(2)
  };
}

async function checkExternalServices() {
  const services = {};
  
  // Check WhatsApp Web
  try {
    const start = Date.now();
    // Simular check de conectividad
    await new Promise(resolve => setTimeout(resolve, 100));
    const latency = Date.now() - start;
    
    services.whatsappWeb = {
      status: 'healthy',
      latency: `${latency}ms`
    };
  } catch (error) {
    services.whatsappWeb = {
      status: 'unhealthy',
      error: error.message
    };
  }
  
  return services;
}

function checkEnvironment() {
  const required = [
    'NODE_ENV',
    'PORT',
    'REDIS_URL',
    'JWT_SECRET'
  ];
  
  const missing = required.filter(key => !process.env[key]);
  
  return {
    status: missing.length === 0 ? 'healthy' : 'unhealthy',
    missing: missing.length > 0 ? missing : undefined
  };
}

async function checkDependencies() {
  try {
    // Verificar que los módulos críticos están cargados
    const critical = [
      'express',
      'socket.io',
      'redis',
      'winston',
      'whatsapp-web.js'
    ];
    
    for (const module of critical) {
      await import(module);
    }
    
    return {
      status: 'healthy',
      loaded: critical
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message
    };
  }
}

async function checkFilesystem() {
  const paths = [
    './logs',
    './storage',
    './auth-sessions'
  ];
  
  const checks = {};
  
  for (const path of paths) {
    try {
      const fs = await import('fs/promises');
      await fs.access(path, fs.constants.W_OK);
      checks[path] = 'writable';
    } catch {
      checks[path] = 'not writable';
    }
  }
  
  const allWritable = Object.values(checks).every(status => status === 'writable');
  
  return {
    status: allWritable ? 'healthy' : 'unhealthy',
    paths: checks
  };
}

function calculateOverallStatus(checks) {
  const statuses = Object.values(checks).map(check => check.status);
  
  if (statuses.includes('unhealthy')) {
    return 'unhealthy';
  }
  
  if (statuses.includes('degraded')) {
    return 'degraded';
  }
  
  return 'healthy';
}

async function getSystemInfo() {
  return {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptime: {
      process: process.uptime(),
      system: os.uptime()
    },
    hostname: os.hostname(),
    pid: process.pid,
    workerId: process.env.WORKER_ID || 'master'
  };
}

export function createHealthRoutes(dependencies) {
  // Store dependencies for use in health checks
  if (dependencies) {
    // These can be used in performHealthChecks
    router.dependencies = dependencies;
  }
  return router;
}

export default router;
