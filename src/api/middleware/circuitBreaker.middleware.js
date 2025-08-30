import CircuitBreaker from 'opossum';
import logger from '../../core/utils/logger.js';
import { logAuditEvent, AUDIT_EVENTS } from './audit.middleware.js';

/**
 * Circuit Breaker Middleware
 * Protects against cascading failures in distributed systems
 */

// Circuit breaker configurations for different services
const BREAKER_CONFIGS = {
  whatsapp: {
    timeout: 30000, // 30 seconds
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    rollingCountTimeout: 10000,
    rollingCountBuckets: 10,
    name: 'WhatsApp Service'
  },
  redis: {
    timeout: 5000, // 5 seconds
    errorThresholdPercentage: 50,
    resetTimeout: 10000,
    rollingCountTimeout: 10000,
    rollingCountBuckets: 10,
    name: 'Redis Service'
  },
  external_api: {
    timeout: 10000, // 10 seconds
    errorThresholdPercentage: 60,
    resetTimeout: 20000,
    rollingCountTimeout: 10000,
    rollingCountBuckets: 10,
    name: 'External API'
  },
  database: {
    timeout: 5000, // 5 seconds
    errorThresholdPercentage: 40,
    resetTimeout: 15000,
    rollingCountTimeout: 10000,
    rollingCountBuckets: 10,
    name: 'Database'
  },
  webhook: {
    timeout: 15000, // 15 seconds
    errorThresholdPercentage: 70,
    resetTimeout: 30000,
    rollingCountTimeout: 10000,
    rollingCountBuckets: 10,
    name: 'Webhook Service'
  }
};

// Store circuit breakers
const breakers = new Map();

// Circuit breaker statistics
const breakerStats = new Map();

/**
 * Create or get circuit breaker for a service
 */
const getCircuitBreaker = (serviceName, customConfig = {}) => {
  if (breakers.has(serviceName)) {
    return breakers.get(serviceName);
  }
  
  const config = {
    ...BREAKER_CONFIGS[serviceName] || BREAKER_CONFIGS.external_api,
    ...customConfig
  };
  
  // Create circuit breaker
  const breaker = new CircuitBreaker(async function(fn, ...args) {
    return await fn(...args);
  }, config);
  
  // Initialize stats
  breakerStats.set(serviceName, {
    requests: 0,
    failures: 0,
    successes: 0,
    rejections: 0,
    timeouts: 0,
    opens: 0,
    halfOpens: 0,
    closes: 0,
    fallbacks: 0,
    lastFailure: null,
    lastSuccess: null
  });
  
  const stats = breakerStats.get(serviceName);
  
  // Event handlers
  breaker.on('success', (result) => {
    stats.successes++;
    stats.lastSuccess = new Date();
    logger.debug(`Circuit breaker ${serviceName}: Success`);
  });
  
  breaker.on('failure', (error) => {
    stats.failures++;
    stats.lastFailure = new Date();
    logger.warn(`Circuit breaker ${serviceName}: Failure`, { error: error.message });
  });
  
  breaker.on('timeout', () => {
    stats.timeouts++;
    logger.error(`Circuit breaker ${serviceName}: Timeout`);
  });
  
  breaker.on('reject', () => {
    stats.rejections++;
    logger.warn(`Circuit breaker ${serviceName}: Request rejected (circuit open)`);
  });
  
  breaker.on('open', () => {
    stats.opens++;
    logger.error(`Circuit breaker ${serviceName}: Circuit opened`);
    
    // Send alert
    sendCircuitBreakerAlert(serviceName, 'opened');
  });
  
  breaker.on('halfOpen', () => {
    stats.halfOpens++;
    logger.info(`Circuit breaker ${serviceName}: Circuit half-open (testing)`);
  });
  
  breaker.on('close', () => {
    stats.closes++;
    logger.info(`Circuit breaker ${serviceName}: Circuit closed (recovered)`);
    
    // Send recovery notification
    sendCircuitBreakerAlert(serviceName, 'closed');
  });
  
  breaker.on('fallback', (data) => {
    stats.fallbacks++;
    logger.info(`Circuit breaker ${serviceName}: Using fallback`);
  });
  
  breakers.set(serviceName, breaker);
  return breaker;
};

/**
 * Send circuit breaker alerts
 */
const sendCircuitBreakerAlert = async (serviceName, status) => {
  try {
    const message = `Circuit breaker for ${serviceName} is now ${status}`;
    logger.error(`ALERT: ${message}`);
    
    // Send to monitoring service if configured
    if (process.env.ALERT_WEBHOOK_URL) {
      // Implement webhook notification
    }
    
    // Log audit event
    await logAuditEvent(AUDIT_EVENTS.SYSTEM_CONFIG_CHANGED, { path: '/circuit-breaker' }, {
      severity: status === 'opened' ? 'ERROR' : 'INFO',
      service: serviceName,
      status: status,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to send circuit breaker alert:', error);
  }
};

/**
 * Wrap function with circuit breaker
 */
const withCircuitBreaker = (serviceName, fn, fallbackFn = null) => {
  const breaker = getCircuitBreaker(serviceName);
  
  if (fallbackFn) {
    breaker.fallback(fallbackFn);
  }
  
  return async (...args) => {
    const stats = breakerStats.get(serviceName);
    stats.requests++;
    
    try {
      return await breaker.fire(fn, ...args);
    } catch (error) {
      // Check if circuit is open
      if (breaker.opened) {
        logger.error(`Circuit breaker ${serviceName} is open, request rejected`);
        throw new Error(`Service ${serviceName} is temporarily unavailable`);
      }
      throw error;
    }
  };
};

/**
 * Circuit breaker middleware for Express routes
 */
const circuitBreakerMiddleware = (serviceName, options = {}) => {
  return async (req, res, next) => {
    const breaker = getCircuitBreaker(serviceName, options);
    
    // Check if circuit is open
    if (breaker.opened) {
      logger.warn(`Request rejected: Circuit breaker ${serviceName} is open`);
      return res.status(503).json({
        success: false,
        error: `Service temporarily unavailable`,
        service: serviceName,
        retryAfter: breaker.options.resetTimeout / 1000
      });
    }
    
    // Attach circuit breaker to request
    req.circuitBreaker = breaker;
    req.withCircuitBreaker = (fn, fallback) => withCircuitBreaker(serviceName, fn, fallback);
    
    next();
  };
};

/**
 * Get circuit breaker statistics
 */
const getCircuitBreakerStats = (serviceName = null) => {
  if (serviceName) {
    const breaker = breakers.get(serviceName);
    const stats = breakerStats.get(serviceName);
    
    if (!breaker) {
      return null;
    }
    
    return {
      name: serviceName,
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      enabled: breaker.enabled,
      stats: {
        ...stats,
        successRate: stats.requests > 0 
          ? ((stats.successes / stats.requests) * 100).toFixed(2) + '%'
          : '0%',
        failureRate: stats.requests > 0
          ? ((stats.failures / stats.requests) * 100).toFixed(2) + '%'
          : '0%'
      },
      options: breaker.options
    };
  }
  
  // Return all circuit breaker stats
  const allStats = {};
  for (const [name, breaker] of breakers) {
    allStats[name] = getCircuitBreakerStats(name);
  }
  return allStats;
};

/**
 * Reset circuit breaker
 */
const resetCircuitBreaker = (serviceName) => {
  const breaker = breakers.get(serviceName);
  if (breaker) {
    breaker.close();
    const stats = breakerStats.get(serviceName);
    if (stats) {
      stats.requests = 0;
      stats.failures = 0;
      stats.successes = 0;
      stats.rejections = 0;
      stats.timeouts = 0;
    }
    logger.info(`Circuit breaker ${serviceName} has been reset`);
    return true;
  }
  return false;
};

/**
 * Health check for circuit breakers
 */
const checkCircuitBreakerHealth = () => {
  const health = {
    healthy: true,
    breakers: {}
  };
  
  for (const [name, breaker] of breakers) {
    const isHealthy = !breaker.opened;
    health.breakers[name] = {
      healthy: isHealthy,
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed'
    };
    
    if (!isHealthy) {
      health.healthy = false;
    }
  }
  
  return health;
};

/**
 * Cleanup circuit breakers
 */
const cleanupCircuitBreakers = () => {
  for (const [name, breaker] of breakers) {
    breaker.shutdown();
  }
  breakers.clear();
  breakerStats.clear();
  logger.info('All circuit breakers have been cleaned up');
};

// Cleanup on process termination
process.on('SIGTERM', cleanupCircuitBreakers);
process.on('SIGINT', cleanupCircuitBreakers);

export {
  getCircuitBreaker,
  withCircuitBreaker,
  circuitBreakerMiddleware,
  getCircuitBreakerStats,
  resetCircuitBreaker,
  checkCircuitBreakerHealth,
  cleanupCircuitBreakers,
  BREAKER_CONFIGS
};
