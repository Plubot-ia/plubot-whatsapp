import os from 'node:os';

export const clusterConfig = {
  // Number of worker processes
  workers: process.env.CLUSTER_WORKERS || os.cpus().length,

  // Worker restart settings
  maxRestarts: 10,
  restartDelay: 5000,

  // Memory limits per worker (MB)
  maxMemory: Number.parseInt(process.env.WORKER_MAX_MEMORY, 10) || 512,

  // Session distribution strategy
  sessionStrategy: process.env.SESSION_STRATEGY || 'least-connections', // round-robin, least-connections, ip-hash

  // Health check interval
  healthCheckInterval: 30_000,

  // Graceful shutdown timeout
  shutdownTimeout: 30_000,

  // IPC message timeout
  ipcTimeout: 10_000,

  // Worker settings
  workerSettings: {
    execArgv: ['--max-old-space-size=512'],
    silent: false,
  },
};

export const redisClusterConfig = {
  nodes: process.env.REDIS_CLUSTER_NODES?.split(',') || ['localhost:6379'],
  options: {
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    retryDelayOnFailover: 100,
    retryDelayOnClusterDown: 300,
    slotsRefreshTimeout: 2000,
    clusterRetryStrategy: (times) => Math.min(100 * times, 2000),
    redisOptions: {
      password: process.env.REDIS_PASSWORD,
      tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    },
  },
};

export const queueConfig = {
  // Bull queue settings
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 500,
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },

  // Queue concurrency
  concurrency: {
    messages: 50,
    media: 20,
    status: 100,
    qr: 10,
  },

  // Rate limiting per queue
  rateLimits: {
    messages: {
      max: 100,
      duration: 1000,
    },
    media: {
      max: 20,
      duration: 1000,
    },
  },
};

export const metricsConfig = {
  enabled: process.env.METRICS_ENABLED !== 'false',
  port: Number.parseInt(process.env.METRICS_PORT, 10) || 9090,
  path: '/metrics',
  collectDefaultMetrics: true,
  defaultLabels: {
    service: 'plubot-whatsapp',
    environment: process.env.NODE_ENV || 'development',
  },
};
