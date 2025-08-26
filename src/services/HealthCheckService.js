import os from 'node:os';
import logger from '../utils/logger.js';
import { circuitBreakerManager } from '../patterns/CircuitBreaker.js';

/**
 * Comprehensive health check service for WhatsApp microservice
 */
class HealthCheckService {
  constructor(manager) {
    this.manager = manager;
    this.checks = new Map();
    this.history = [];
    this.maxHistorySize = 100;
    this.lastCheckResult = null;
    this.startTime = Date.now();
    
    // Register default checks
    this.registerDefaultChecks();
    
    // Start periodic health checks
    this.startPeriodicChecks();
  }

  /**
   * Register default health checks
   */
  registerDefaultChecks() {
    // Redis connectivity
    this.registerCheck('redis', async () => {
      try {
        if (!this.manager.redis) {
          return { healthy: false, message: 'Redis not configured' };
        }
        
        await this.manager.redis.ping();
        const info = await this.manager.redis.info('memory');
        const memoryUsage = this.parseRedisMemory(info);
        
        return {
          healthy: true,
          message: 'Redis connected',
          metrics: {
            connected: true,
            memoryUsage
          }
        };
      } catch (error) {
        return {
          healthy: false,
          message: `Redis error: ${error.message}`
        };
      }
    });

    // Session pool health
    this.registerCheck('sessionPool', async () => {
      if (!this.manager.sessionPool) {
        return { healthy: false, message: 'Session pool not initialized' };
      }
      
      const poolHealth = this.manager.sessionPool.getHealthStatus();
      return {
        healthy: poolHealth.healthy,
        message: `Session pool at ${poolHealth.capacity} capacity`,
        metrics: poolHealth.stats
      };
    });

    // Circuit breakers
    this.registerCheck('circuitBreakers', async () => {
      const breakers = circuitBreakerManager.getAllStatus();
      const unhealthyBreakers = [];
      
      for (const [name, status] of Object.entries(breakers)) {
        if (status.state !== 'CLOSED') {
          unhealthyBreakers.push(name);
        }
      }
      
      return {
        healthy: unhealthyBreakers.length === 0,
        message: unhealthyBreakers.length > 0 ? 
          `Circuit breakers open: ${unhealthyBreakers.join(', ')}` : 
          'All circuit breakers healthy',
        metrics: breakers
      };
    });

    // WebSocket connectivity
    this.registerCheck('websocket', async () => {
      if (!this.manager.io) {
        return { healthy: false, message: 'WebSocket not initialized' };
      }
      
      const sockets = await this.manager.io.fetchSockets();
      return {
        healthy: true,
        message: `${sockets.length} WebSocket connections`,
        metrics: {
          connectedClients: sockets.length,
          rooms: this.manager.io.sockets.adapter.rooms.size
        }
      };
    });

    // Active sessions
    this.registerCheck('sessions', async () => {
      const sessions = this.manager.clients;
      const sessionStats = {
        total: sessions.size,
        ready: 0,
        authenticated: 0,
        disconnected: 0,
        error: 0
      };
      
      for (const session of sessions.values()) {
        if (session.status === 'ready') sessionStats.ready++;
        else if (session.status === 'authenticated') sessionStats.authenticated++;
        else if (session.status === 'disconnected') sessionStats.disconnected++;
        else if (session.status === 'error') sessionStats.error++;
      }
      
      const healthyRatio = (sessionStats.ready + sessionStats.authenticated) / Math.max(1, sessionStats.total);
      
      return {
        healthy: sessionStats.error === 0 && healthyRatio > 0.5,
        message: `${sessionStats.total} sessions (${sessionStats.ready} ready, ${sessionStats.error} errors)`,
        metrics: sessionStats
      };
    });

    // System resources
    this.registerCheck('system', async () => {
      const memUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      const loadAvg = os.loadavg();
      const freeMemory = os.freemem();
      const totalMemory = os.totalmem();
      
      const memoryUsagePercent = ((totalMemory - freeMemory) / totalMemory) * 100;
      const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
      
      return {
        healthy: memoryUsagePercent < 90 && heapUsagePercent < 90,
        message: `Memory: ${memoryUsagePercent.toFixed(1)}%, Heap: ${heapUsagePercent.toFixed(1)}%`,
        metrics: {
          memory: {
            rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
            external: Math.round(memUsage.external / 1024 / 1024) + 'MB',
            systemFree: Math.round(freeMemory / 1024 / 1024) + 'MB',
            systemTotal: Math.round(totalMemory / 1024 / 1024) + 'MB'
          },
          cpu: {
            user: Math.round(cpuUsage.user / 1000) + 'ms',
            system: Math.round(cpuUsage.system / 1000) + 'ms'
          },
          loadAverage: {
            '1min': loadAvg[0].toFixed(2),
            '5min': loadAvg[1].toFixed(2),
            '15min': loadAvg[2].toFixed(2)
          }
        }
      };
    });

    // Persistence service
    this.registerCheck('persistence', async () => {
      if (!this.manager.persistenceService) {
        return { healthy: false, message: 'Persistence service not initialized' };
      }
      
      try {
        // Test persistence by checking a dummy key
        await this.manager.redis.set('health:check', Date.now(), 'EX', 10);
        const value = await this.manager.redis.get('health:check');
        
        return {
          healthy: value !== null,
          message: 'Persistence service operational',
          metrics: {
            redisConnected: true,
            lastCheck: value
          }
        };
      } catch (error) {
        return {
          healthy: false,
          message: `Persistence error: ${error.message}`
        };
      }
    });

    // Reconnection service
    this.registerCheck('reconnection', async () => {
      if (!this.manager.reconnectService) {
        return { healthy: false, message: 'Reconnection service not initialized' };
      }
      
      const reconnectingCount = this.manager.reconnectService.reconnectTimers.size;
      
      return {
        healthy: reconnectingCount < 10,
        message: `${reconnectingCount} sessions reconnecting`,
        metrics: {
          reconnectingSessions: reconnectingCount
        }
      };
    });
  }

  /**
   * Register a custom health check
   */
  registerCheck(name, checkFn) {
    this.checks.set(name, checkFn);
    logger.info(`📋 Registered health check: ${name}`);
  }

  /**
   * Run all health checks
   */
  async runAllChecks() {
    const results = {};
    const startTime = Date.now();
    let overallHealthy = true;
    
    for (const [name, checkFn] of this.checks) {
      try {
        const checkStart = Date.now();
        const result = await checkFn();
        result.duration = Date.now() - checkStart;
        results[name] = result;
        
        if (!result.healthy) {
          overallHealthy = false;
        }
      } catch (error) {
        logger.error(`Health check ${name} failed:`, error);
        results[name] = {
          healthy: false,
          message: `Check failed: ${error.message}`,
          error: true
        };
        overallHealthy = false;
      }
    }
    
    const checkResult = {
      timestamp: new Date().toISOString(),
      healthy: overallHealthy,
      duration: Date.now() - startTime,
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      checks: results
    };
    
    // Store in history
    this.history.push(checkResult);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
    
    this.lastCheckResult = checkResult;
    
    return checkResult;
  }

  /**
   * Get current health status
   */
  async getHealth() {
    if (!this.lastCheckResult || Date.now() - new Date(this.lastCheckResult.timestamp) > 5000) {
      return await this.runAllChecks();
    }
    return this.lastCheckResult;
  }

  /**
   * Get detailed health report
   */
  async getDetailedReport() {
    const current = await this.runAllChecks();
    
    return {
      current,
      history: this.history.slice(-10),
      statistics: this.calculateStatistics(),
      recommendations: this.generateRecommendations(current)
    };
  }

  /**
   * Calculate health statistics
   */
  calculateStatistics() {
    if (this.history.length === 0) {
      return { healthyPercentage: 100, averageDuration: 0 };
    }
    
    const healthyCount = this.history.filter(h => h.healthy).length;
    const totalDuration = this.history.reduce((sum, h) => sum + h.duration, 0);
    
    return {
      healthyPercentage: (healthyCount / this.history.length * 100).toFixed(2),
      averageDuration: Math.round(totalDuration / this.history.length),
      totalChecks: this.history.length,
      failureCount: this.history.length - healthyCount
    };
  }

  /**
   * Generate recommendations based on health status
   */
  generateRecommendations(healthStatus) {
    const recommendations = [];
    
    if (!healthStatus.healthy) {
      for (const [check, result] of Object.entries(healthStatus.checks)) {
        if (!result.healthy) {
          switch (check) {
            case 'redis':
              recommendations.push('Check Redis connection and configuration');
              break;
            case 'sessionPool':
              recommendations.push('Session pool may be at capacity, consider scaling');
              break;
            case 'circuitBreakers':
              recommendations.push('Circuit breakers are open, investigate service failures');
              break;
            case 'system':
              recommendations.push('System resources are constrained, consider scaling or optimization');
              break;
            case 'sessions':
              recommendations.push('High error rate in sessions, check WhatsApp connectivity');
              break;
            default:
              recommendations.push(`Investigate ${check} health check failure`);
          }
        }
      }
    }
    
    // Add performance recommendations
    if (healthStatus.duration > 1000) {
      recommendations.push('Health checks are slow, consider optimization');
    }
    
    return recommendations;
  }

  /**
   * Start periodic health checks
   */
  startPeriodicChecks() {
    // Run health checks every 30 seconds
    setInterval(async () => {
      const result = await this.runAllChecks();
      
      if (!result.healthy) {
        logger.warn('⚠️ Health check failed:', result);
      } else {
        logger.debug('✅ Health check passed');
      }
    }, 30000);
  }

  /**
   * Parse Redis memory info
   */
  parseRedisMemory(info) {
    const lines = info.split('\r\n');
    const memoryLine = lines.find(line => line.startsWith('used_memory_human:'));
    return memoryLine ? memoryLine.split(':')[1] : 'unknown';
  }

  /**
   * Express middleware for health endpoint
   */
  middleware() {
    return async (req, res) => {
      try {
        const detailed = req.query.detailed === 'true';
        
        if (detailed) {
          const report = await this.getDetailedReport();
          return res.status(report.current.healthy ? 200 : 503).json(report);
        }
        
        const health = await this.getHealth();
        return res.status(health.healthy ? 200 : 503).json(health);
      } catch (error) {
        logger.error('Health check endpoint error:', error);
        return res.status(503).json({
          healthy: false,
          error: error.message
        });
      }
    };
  }
}

export default HealthCheckService;
