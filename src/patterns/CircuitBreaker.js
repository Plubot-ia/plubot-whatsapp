import logger from '../utils/logger.js';

/**
 * Circuit Breaker pattern implementation
 * Prevents cascading failures in the WhatsApp service
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'CircuitBreaker';
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 60000; // 1 minute
    this.monitoringPeriod = options.monitoringPeriod || 10000; // 10 seconds
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = Date.now();
    this.lastFailureTime = null;
    this.metrics = {
      totalRequests: 0,
      failedRequests: 0,
      successfulRequests: 0,
      rejectedRequests: 0,
      stateChanges: []
    };
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute(fn, fallback = null) {
    this.metrics.totalRequests++;

    // Check circuit state
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        this.metrics.rejectedRequests++;
        logger.warn(`⚡ Circuit breaker ${this.name} is OPEN, rejecting request`);
        
        if (fallback) {
          return fallback();
        }
        
        throw new Error(`Circuit breaker ${this.name} is OPEN`);
      }
      
      // Try half-open state
      this.setState('HALF_OPEN');
    }

    try {
      const result = await this.callWithTimeout(fn);
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  /**
   * Call function with timeout protection
   */
  async callWithTimeout(fn, timeout = 30000) {
    return Promise.race([
      fn(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Operation timeout')), timeout)
      )
    ]);
  }

  /**
   * Handle successful execution
   */
  onSuccess() {
    this.metrics.successfulRequests++;
    
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      
      // Need multiple successes to fully close
      if (this.successes >= 3) {
        this.setState('CLOSED');
        this.failures = 0;
        this.successes = 0;
        logger.info(`✅ Circuit breaker ${this.name} is now CLOSED (recovered)`);
      }
    } else if (this.state === 'CLOSED') {
      // Reset failure count on success in closed state
      this.failures = 0;
    }
  }

  /**
   * Handle failed execution
   */
  onFailure(error) {
    this.metrics.failedRequests++;
    this.lastFailureTime = Date.now();
    
    if (this.state === 'HALF_OPEN') {
      // Immediately open on failure in half-open state
      this.setState('OPEN');
      this.nextAttempt = Date.now() + this.resetTimeout;
      logger.error(`❌ Circuit breaker ${this.name} reopened due to failure in HALF_OPEN state`);
    } else if (this.state === 'CLOSED') {
      this.failures++;
      
      if (this.failures >= this.failureThreshold) {
        this.setState('OPEN');
        this.nextAttempt = Date.now() + this.resetTimeout;
        logger.error(`❌ Circuit breaker ${this.name} opened after ${this.failures} failures`);
      }
    }
    
    logger.error(`Circuit breaker ${this.name} failure:`, error.message);
  }

  /**
   * Set circuit breaker state
   */
  setState(newState) {
    const oldState = this.state;
    this.state = newState;
    
    this.metrics.stateChanges.push({
      from: oldState,
      to: newState,
      timestamp: new Date().toISOString()
    });
    
    logger.info(`🔄 Circuit breaker ${this.name} state changed: ${oldState} -> ${newState}`);
  }

  /**
   * Get current circuit breaker status
   */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.state === 'OPEN' ? this.nextAttempt : null,
      metrics: this.metrics
    };
  }

  /**
   * Reset circuit breaker
   */
  reset() {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = Date.now();
    this.lastFailureTime = null;
    logger.info(`🔄 Circuit breaker ${this.name} has been reset`);
  }

  /**
   * Check if circuit breaker is healthy
   */
  isHealthy() {
    return this.state === 'CLOSED';
  }

  /**
   * Get failure rate
   */
  getFailureRate() {
    if (this.metrics.totalRequests === 0) return 0;
    return (this.metrics.failedRequests / this.metrics.totalRequests) * 100;
  }
}

/**
 * Circuit Breaker Manager for multiple breakers
 */
class CircuitBreakerManager {
  constructor() {
    this.breakers = new Map();
  }

  /**
   * Get or create a circuit breaker
   */
  getBreaker(name, options = {}) {
    if (!this.breakers.has(name)) {
      this.breakers.set(name, new CircuitBreaker({ name, ...options }));
    }
    return this.breakers.get(name);
  }

  /**
   * Get all circuit breakers status
   */
  getAllStatus() {
    const status = {};
    for (const [name, breaker] of this.breakers) {
      status[name] = breaker.getStatus();
    }
    return status;
  }

  /**
   * Reset all circuit breakers
   */
  resetAll() {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Check overall health
   */
  isHealthy() {
    for (const breaker of this.breakers.values()) {
      if (!breaker.isHealthy()) {
        return false;
      }
    }
    return true;
  }
}

// Export singleton instance
const circuitBreakerManager = new CircuitBreakerManager();

export { CircuitBreaker, CircuitBreakerManager, circuitBreakerManager };
