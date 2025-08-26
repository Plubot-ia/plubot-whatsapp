import { EventEmitter } from 'node:events';
import os from 'node:os';

import express from 'express';
import Redis from 'ioredis';

import logger from '../utils/logger.js';

/**
 * Enterprise Health Check System
 * Monitors service health and dependencies
 */
export class HealthChecker {
  constructor(config = {}) {
    this.config = {
      timeout: config.timeout || 5000,
      interval: config.interval || 30_000,
      dependencies: config.dependencies || {},
      thresholds: {
        memory: config.thresholds?.memory || 0.85,
        cpu: config.thresholds?.cpu || 0.9,
        responseTime: config.thresholds?.responseTime || 3000,
        errorRate: config.thresholds?.errorRate || 0.05,
      },
      ...config,
    };

    this.checks = new Map();
    this.results = new Map();
    this.status = 'initializing';

    this._registerDefaultChecks();
  }

  /**
   * Register default health checks
   */
  _registerDefaultChecks() {
    // System checks
    this.registerCheck('system:memory', async () => {
      const total = os.totalmem();
      const free = os.freemem();
      const used = total - free;
      const usage = used / total;

      return {
        status: usage < this.config.thresholds.memory ? 'healthy' : 'unhealthy',
        details: {
          total: total / (1024 * 1024 * 1024),
          free: free / (1024 * 1024 * 1024),
          used: used / (1024 * 1024 * 1024),
          percentage: (usage * 100).toFixed(2),
        },
      };
    });

    this.registerCheck('system:cpu', async () => {
      const cpus = os.cpus();
      const loads = os.loadavg();
      const cpuCount = cpus.length;
      const load1 = loads[0] / cpuCount;

      return {
        status: load1 < this.config.thresholds.cpu ? 'healthy' : 'unhealthy',
        details: {
          cores: cpuCount,
          loadAverage: loads,
          normalizedLoad: load1.toFixed(2),
        },
      };
    });

    this.registerCheck('process:memory', async () => {
      const usage = process.memoryUsage();
      const maxHeap = 512 * 1024 * 1024; // 512MB default
      const heapUsage = usage.heapUsed / maxHeap;

      return {
        status: heapUsage < this.config.thresholds.memory ? 'healthy' : 'unhealthy',
        details: {
          rss: (usage.rss / 1024 / 1024).toFixed(2),
          heapTotal: (usage.heapTotal / 1024 / 1024).toFixed(2),
          heapUsed: (usage.heapUsed / 1024 / 1024).toFixed(2),
          external: (usage.external / 1024 / 1024).toFixed(2),
          percentage: (heapUsage * 100).toFixed(2),
        },
      };
    });

    this.registerCheck('process:uptime', async () => {
      const uptime = process.uptime();

      return {
        status: 'healthy',
        details: {
          uptime: uptime,
          formatted: this._formatUptime(uptime),
        },
      };
    });

    // Redis check
    if (this.config.dependencies.redis) {
      this.registerCheck('dependency:redis', async () => {
        try {
          const redis = new IORedis(this.config.dependencies.redis);
          const start = Date.now();
          await redis.ping();
          const latency = Date.now() - start;

          const info = await redis.info('server');
          const version = info.match(/redis_version:([^\n\r]+)/)?.[1];

          await redis.quit();

          return {
            status: latency < 100 ? 'healthy' : 'degraded',
            details: {
              latency: `${latency}ms`,
              version,
              connected: true,
            },
          };
        } catch (error) {
          return {
            status: 'unhealthy',
            details: {
              error: error.message,
              connected: false,
            },
          };
        }
      });
    }

    // WhatsApp sessions check
    this.registerCheck('whatsapp:sessions', async () => {
      try {
        const { sessionPool } = this.config.dependencies;
        if (!sessionPool) {
          return {
            status: 'unknown',
            details: { message: 'Session pool not configured' },
          };
        }

        const metrics = sessionPool.getMetrics();
        const utilizationThreshold = 0.8;

        return {
          status: metrics.poolUtilization < utilizationThreshold * 100 ? 'healthy' : 'degraded',
          details: {
            totalSessions: metrics.currentSize,
            activeSessions: metrics.activeSize,
            utilization: `${metrics.poolUtilization.toFixed(2)}%`,
            created: metrics.created,
            destroyed: metrics.destroyed,
          },
        };
      } catch (error) {
        return {
          status: 'unhealthy',
          details: { error: error.message },
        };
      }
    });

    // Message queue check
    this.registerCheck('queue:health', async () => {
      try {
        const { messageQueue } = this.config.dependencies;
        if (!messageQueue) {
          return {
            status: 'unknown',
            details: { message: 'Message queue not configured' },
          };
        }

        const stats = await messageQueue.getQueueStats();
        const totalFailed = Object.values(stats.queues).reduce((sum, q) => sum + q.failed, 0);

        return {
          status: totalFailed < 100 ? 'healthy' : 'degraded',
          details: {
            queues: stats.queues,
            metrics: stats.metrics,
          },
        };
      } catch (error) {
        return {
          status: 'unhealthy',
          details: { error: error.message },
        };
      }
    });
  }

  /**
   * Register a health check
   */
  registerCheck(name, checkFunction, options = {}) {
    this.checks.set(name, {
      fn: checkFunction,
      timeout: options.timeout || this.config.timeout,
      critical: options.critical || false,
    });

    logger.debug(`Health check registered: ${name}`);
  }

  /**
   * Run a single health check
   */
  async _checkRedis() {
    const start = Date.now();
    const redis = this.config.dependencies?.redis;

    if (!redis) {
      return this._formatCheck('dependency:redis', 'healthy', Date.now() - start, {
        message: 'Redis not configured',
      });
    }

    try {
      const client = new Redis(redis);

      // Run check with timeout
      const result = await Promise.race([
        client.ping(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Check timeout')), this.config.timeout),
        ),
      ]);

      const latency = Date.now() - start;

      return {
        status: latency < 100 ? 'healthy' : 'degraded',
        details: {
          latency: `${latency}ms`,
          connected: true,
        },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: {
          error: error.message,
          connected: false,
        },
      };
    }
  }

  async runCheck(name) {
    const check = this.checks.get(name);

    if (!check) {
      return {
        name,
        status: 'unknown',
        message: 'Check not found',
      };
    }

    try {
      const start = Date.now();

      // Run check with timeout
      const result = await Promise.race([
        check.fn(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Check timeout')), check.timeout),
        ),
      ]);

      const duration = Date.now() - start;

      return {
        name,
        status: result.status,
        duration: `${duration}ms`,
        details: result.details,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Health check ${name} failed:`, error);

      return {
        name,
        status: 'unhealthy',
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Run all health checks
   */
  async runAllChecks() {
    const results = {};
    const promises = [];

    for (const [name] of this.checks) {
      promises.push(
        this.runCheck(name).then((result) => {
          results[name] = result;
        }),
      );
    }

    await Promise.all(promises);

    // Store results
    for (const [name, result] of Object.entries(results)) {
      this.results.set(name, result);
    }

    // Calculate overall status
    this.status = this._calculateOverallStatus(results);

    return {
      status: this.status,
      timestamp: new Date().toISOString(),
      checks: results,
    };
  }

  /**
   * Calculate overall health status
   */
  _calculateOverallStatus(results) {
    const statuses = new Set(Object.values(results).map((r) => r.status));

    // If any critical check is unhealthy, overall is unhealthy
    const criticalChecks = [...this.checks.entries()]
      .filter(([, check]) => check.critical)
      .map(([name]) => name);

    for (const name of criticalChecks) {
      if (results[name]?.status === 'unhealthy') {
        return 'unhealthy';
      }
    }

    // Check for any unhealthy status
    if (statuses.has('unhealthy')) {
      return 'degraded';
    }

    // Check for degraded status
    if (statuses.has('degraded')) {
      return 'degraded';
    }

    // All checks passed
    return 'healthy';
  }

  /**
   * Get liveness status (is service alive?)
   */
  async getLiveness() {
    return {
      status: 'alive',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      pid: process.pid,
    };
  }

  /**
   * Get readiness status (is service ready to accept traffic?)
   */
  async getReadiness() {
    // Check critical dependencies
    const criticalChecks = ['dependency:redis', 'whatsapp:sessions'];
    const results = {};

    for (const check of criticalChecks) {
      if (this.checks.has(check)) {
        results[check] = await this.runCheck(check);
      }
    }

    const ready = Object.values(results).every(
      (r) => r.status === 'healthy' || r.status === 'degraded',
    );

    return {
      ready,
      status: ready ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: results,
    };
  }

  /**
   * Start periodic health checks
   */
  startMonitoring() {
    this.monitoringInterval = setInterval(async () => {
      try {
        await this.runAllChecks();

        if (this.status === 'unhealthy') {
          logger.error('Service health check failed - status: unhealthy');
        } else if (this.status === 'degraded') {
          logger.warn('Service health check warning - status: degraded');
        }
      } catch (error) {
        logger.error('Health check monitoring error:', error);
      }
    }, this.config.interval);

    logger.info(`Health monitoring started (interval: ${this.config.interval}ms)`);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      logger.info('Health monitoring stopped');
    }
  }

  /**
   * Format uptime
   */
  _formatUptime(seconds) {
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(' ');
  }

  /**
   * Express middleware for health endpoints
   */
  routes() {
    const router = express.Router();

    // Main health check endpoint
    router.get('/health', async (req, res) => {
      try {
        const result = await this.runAllChecks();
        const statusCode =
          result.status === 'healthy' ? 200 : result.status === 'degraded' ? 200 : 503;

        res.status(statusCode).json(result);
      } catch (error) {
        res.status(503).json({
          status: 'error',
          message: error.message,
        });
      }
    });

    // Liveness probe (for Kubernetes)
    router.get('/health/live', async (req, res) => {
      const result = await this.getLiveness();
      res.json(result);
    });

    // Readiness probe (for Kubernetes)
    router.get('/health/ready', async (req, res) => {
      const result = await this.getReadiness();
      res.status(result.ready ? 200 : 503).json(result);
    });

    // Individual check endpoint
    router.get('/health/check/:name', async (req, res) => {
      const result = await this.runCheck(req.params.name);
      const statusCode =
        result.status === 'healthy' ? 200 : result.status === 'degraded' ? 200 : 503;

      res.status(statusCode).json(result);
    });

    return router;
  }

  /**
   * Shutdown health checker
   */
  shutdown() {
    this.stopMonitoring();
    this.checks.clear();
    this.results.clear();
    logger.info('HealthChecker shutdown complete');
  }
}

export default HealthChecker;
