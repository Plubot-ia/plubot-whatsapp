import EventEmitter from 'node:events';

import logger from '../utils/logger.js';

/**
 * Circuit Breaker States
 */
const States = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half-open',
};

/**
 * Enterprise Circuit Breaker Pattern
 * Prevents cascading failures in distributed systems
 */
export class CircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      timeout: options.timeout || 10_000,
      errorThreshold: options.errorThreshold || 50,
      errorThresholdPercentage: options.errorThresholdPercentage || 50,
      resetTimeout: options.resetTimeout || 30_000,
      volumeThreshold: options.volumeThreshold || 10,
      sleepWindow: options.sleepWindow || 5000,
      rollingWindowSize: options.rollingWindowSize || 10_000,
      healthCheckInterval: options.healthCheckInterval || 5000,
      fallback: options.fallback || null,
      ...options,
    };

    this.state = States.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.requests = [];
    this.lastFailureTime = null;
    this.nextAttempt = Date.now();
    this.stateChangeTime = Date.now();

    // Metrics
    this.metrics = {
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      totalTimeouts: 0,
      totalFallbacks: 0,
      consecutiveFailures: 0,
      lastStateChange: Date.now(),
    };

    // Start monitoring
    this._startMonitoring();
  }

  /**
   * Execute function with circuit breaker protection
   */
  async execute(function_, ...arguments_) {
    // Check if circuit should be opened
    this._updateState();

    if (this.state === States.OPEN) {
      return this._handleOpen();
    }

    if (this.state === States.HALF_OPEN) {
      return this._handleHalfOpen(function_, arguments_);
    }

    // Circuit is closed, execute normally
    return this._handleClosed(function_, arguments_);
  }

  /**
   * Handle open state
   */
  async _handleOpen() {
    const now = Date.now();

    if (now < this.nextAttempt) {
      // Still in sleep window
      this.metrics.totalFallbacks++;

      if (this.options.fallback) {
        logger.debug('Circuit breaker open, using fallback');
        return this.options.fallback();
      }

      const error = new Error('Circuit breaker is OPEN');
      error.code = 'CIRCUIT_OPEN';
      error.retryAfter = this.nextAttempt - now;
      throw error;
    }

    // Sleep window expired, transition to half-open
    this._transitionTo(States.HALF_OPEN);
    return this._handleHalfOpen(arguments[0], Array.prototype.slice.call(arguments, 1));
  }

  /**
   * Handle half-open state
   */
  async _handleHalfOpen(function_, arguments_) {
    try {
      const result = await this._executeWithTimeout(function_, arguments_);
      this._recordSuccess();

      // Success in half-open state, close circuit
      this._transitionTo(States.CLOSED);
      return result;
    } catch (error) {
      this._recordFailure();

      // Failure in half-open state, reopen circuit
      this._transitionTo(States.OPEN);
      throw error;
    }
  }

  /**
   * Handle closed state
   */
  async _handleClosed(function_, arguments_) {
    try {
      const result = await this._executeWithTimeout(function_, arguments_);
      this._recordSuccess();
      return result;
    } catch (error) {
      this._recordFailure();

      // Check if we should open the circuit
      if (this._shouldOpen()) {
        this._transitionTo(States.OPEN);
      }

      throw error;
    }
  }

  /**
   * Execute function with timeout
   */
  async _executeWithTimeout(function_, arguments_) {
    return new Promise(async (resolve, reject) => {
      let timeoutId;

      // Set timeout
      if (this.options.timeout) {
        timeoutId = setTimeout(() => {
          this.metrics.totalTimeouts++;
          const error = new Error('Circuit breaker timeout');
          error.code = 'CIRCUIT_TIMEOUT';
          reject(error);
        }, this.options.timeout);
      }

      try {
        const result = await function_(...arguments_);
        clearTimeout(timeoutId);
        resolve(result);
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Record successful request
   */
  _recordSuccess() {
    const now = Date.now();

    this.successes++;
    this.failures = 0;
    this.consecutiveFailures = 0;
    this.metrics.totalSuccesses++;
    this.metrics.totalRequests++;
    this.metrics.consecutiveFailures = 0;

    this.requests.push({
      timestamp: now,
      success: true,
    });

    this._cleanOldRequests();
    this.emit('success');
  }

  /**
   * Record failed request
   */
  _recordFailure() {
    const now = Date.now();

    this.failures++;
    this.consecutiveFailures++;
    this.lastFailureTime = now;
    this.metrics.totalFailures++;
    this.metrics.totalRequests++;
    this.metrics.consecutiveFailures++;

    this.requests.push({
      timestamp: now,
      success: false,
    });

    this._cleanOldRequests();
    this.emit('failure');
  }

  /**
   * Check if circuit should open
   */
  _shouldOpen() {
    // Check volume threshold
    const recentRequests = this._getRecentRequests();
    if (recentRequests.length < this.options.volumeThreshold) {
      return false;
    }

    // Check error threshold percentage
    const failureCount = recentRequests.filter((r) => !r.success).length;
    const failurePercentage = (failureCount / recentRequests.length) * 100;

    if (failurePercentage >= this.options.errorThresholdPercentage) {
      logger.warn(`Circuit breaker opening: ${failurePercentage.toFixed(2)}% failure rate`);
      return true;
    }

    // Check absolute error threshold
    if (this.consecutiveFailures >= this.options.errorThreshold) {
      logger.warn(`Circuit breaker opening: ${this.consecutiveFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  /**
   * Update circuit state
   */
  _updateState() {
    if (this.state === States.OPEN) {
      const now = Date.now();
      if (now >= this.nextAttempt) {
        this._transitionTo(States.HALF_OPEN);
      }
    }
  }

  /**
   * Transition to new state
   */
  _transitionTo(newState) {
    const oldState = this.state;
    this.state = newState;
    this.stateChangeTime = Date.now();
    this.metrics.lastStateChange = this.stateChangeTime;

    logger.info(`Circuit breaker state transition: ${oldState} -> ${newState}`);

    switch (newState) {
      case States.OPEN: {
        this.nextAttempt = Date.now() + this.options.sleepWindow;
        this.emit('open');
        break;
      }

      case States.HALF_OPEN: {
        this.emit('half-open');
        break;
      }

      case States.CLOSED: {
        this.failures = 0;
        this.consecutiveFailures = 0;
        this.emit('closed');
        break;
      }
    }

    this.emit('stateChange', { from: oldState, to: newState });
  }

  /**
   * Get recent requests within rolling window
   */
  _getRecentRequests() {
    const cutoff = Date.now() - this.options.rollingWindowSize;
    return this.requests.filter((r) => r.timestamp > cutoff);
  }

  /**
   * Clean old requests outside rolling window
   */
  _cleanOldRequests() {
    const cutoff = Date.now() - this.options.rollingWindowSize;
    this.requests = this.requests.filter((r) => r.timestamp > cutoff);
  }

  /**
   * Start monitoring
   */
  _startMonitoring() {
    // Periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this._cleanOldRequests();
    }, 60_000);

    // Health check for auto-recovery
    if (this.options.healthCheckInterval) {
      this.healthCheckInterval = setInterval(() => {
        if (this.state === States.OPEN) {
          const now = Date.now();
          if (now >= this.nextAttempt) {
            logger.debug('Circuit breaker health check: attempting recovery');
            this._transitionTo(States.HALF_OPEN);
          }
        }
      }, this.options.healthCheckInterval);
    }
  }

  /**
   * Get current state
   */
  getState() {
    return {
      state: this.state,
      metrics: this.getMetrics(),
      nextAttempt: this.state === States.OPEN ? this.nextAttempt : null,
    };
  }

  /**
   * Get metrics
   */
  getMetrics() {
    const recentRequests = this._getRecentRequests();
    const recentFailures = recentRequests.filter((r) => !r.success).length;
    const recentSuccesses = recentRequests.filter((r) => r.success).length;

    return {
      ...this.metrics,
      state: this.state,
      recentRequests: recentRequests.length,
      recentFailures,
      recentSuccesses,
      failureRate: recentRequests.length > 0 ? (recentFailures / recentRequests.length) * 100 : 0,
      uptime: Date.now() - this.stateChangeTime,
    };
  }

  /**
   * Force open circuit
   */
  forceOpen() {
    this._transitionTo(States.OPEN);
  }

  /**
   * Force close circuit
   */
  forceClose() {
    this._transitionTo(States.CLOSED);
  }

  /**
   * Reset circuit breaker
   */
  reset() {
    this.state = States.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.requests = [];
    this.lastFailureTime = null;
    this.nextAttempt = Date.now();
    this.stateChangeTime = Date.now();
    this.metrics.consecutiveFailures = 0;

    logger.info('Circuit breaker reset');
    this.emit('reset');
  }

  /**
   * Shutdown circuit breaker
   */
  shutdown() {
    clearInterval(this.cleanupInterval);
    clearInterval(this.healthCheckInterval);
    this.removeAllListeners();
    logger.info('Circuit breaker shutdown');
  }
}

/**
 * Circuit Breaker Factory
 */
export class CircuitBreakerFactory {
  constructor() {
    this.breakers = new Map();
  }

  /**
   * Get or create circuit breaker
   */
  getBreaker(name, options = {}) {
    if (!this.breakers.has(name)) {
      const breaker = new CircuitBreaker({
        name,
        ...options,
      });

      this.breakers.set(name, breaker);
      logger.info(`Created circuit breaker: ${name}`);
    }

    return this.breakers.get(name);
  }

  /**
   * Get all breakers
   */
  getAllBreakers() {
    return [...this.breakers.entries()].map(([name, breaker]) => ({
      name,
      ...breaker.getState(),
    }));
  }

  /**
   * Reset all breakers
   */
  resetAll() {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  /**
   * Shutdown all breakers
   */
  shutdownAll() {
    for (const breaker of this.breakers.values()) {
      breaker.shutdown();
    }
    this.breakers.clear();
  }
}

export default CircuitBreaker;
