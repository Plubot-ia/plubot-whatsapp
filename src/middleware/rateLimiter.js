import rateLimit from 'express-rate-limit';
import IORedis from 'ioredis';
import RedisStore from 'rate-limit-redis';

import redisClient from '../config/redis.js';
import logger from '../utils/logger.js';

/**
 * Enterprise Rate Limiter
 * Implements sliding window rate limiting with Redis
 */
export class RateLimiter {
  constructor(config = {}) {
    this.config = {
      windowMs: config.windowMs || 60_000, // 1 minute
      maxRequests: config.maxRequests || 100,
      keyPrefix: config.keyPrefix || 'ratelimit:',
      skipSuccessfulRequests: config.skipSuccessfulRequests || false,
      skipFailedRequests: config.skipFailedRequests || false,
      ...config,
    };

    this.redis = new IORedis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD,
      db: process.env.REDIS_RATELIMIT_DB || 3,
      enableOfflineQueue: true,
    });

    this.redis.on('error', (error) => {
      logger.error('RateLimiter Redis error:', error);
    });
  }

  /**
   * Create middleware for Express
   */
  middleware(options = {}) {
    const config = { ...this.config, ...options };

    return async (req, res, next) => {
      try {
        const key = this._generateKey(req, config);
        const allowed = await this._checkLimit(key, config);

        if (!allowed) {
          const retryAfter = Math.ceil(config.windowMs / 1000);

          res.setHeader('X-RateLimit-Limit', config.maxRequests);
          res.setHeader('X-RateLimit-Remaining', 0);
          res.setHeader('X-RateLimit-Reset', new Date(Date.now() + config.windowMs).toISOString());
          res.setHeader('Retry-After', retryAfter);

          return res.status(429).json({
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Please retry after ${retryAfter} seconds.`,
            retryAfter,
          });
        }

        // Add rate limit headers
        res.setHeader('X-RateLimit-Limit', config.maxRequests);
        res.setHeader('X-RateLimit-Remaining', allowed.remaining);
        res.setHeader('X-RateLimit-Reset', new Date(allowed.resetTime).toISOString());

        // Continue processing
        next();
      } catch (error) {
        logger.error('Rate limiter error:', error);
        // Fail open - allow request if rate limiter fails
        next();
      }
    };
  }

  /**
   * Check if request is within rate limit
   */
  async checkLimit(identifier, options = {}) {
    const config = { ...this.config, ...options };
    const key = `${config.keyPrefix}${identifier}`;
    return this._checkLimit(key, config);
  }

  /**
   * Internal rate limit check using sliding window
   */
  async _checkLimit(key, config) {
    const now = Date.now();
    const windowStart = now - config.windowMs;

    // Use Redis pipeline for atomic operations
    const pipeline = this.redis.pipeline();

    // Remove old entries outside the window
    pipeline.zremrangebyscore(key, 0, windowStart);

    // Count requests in current window
    pipeline.zcard(key);

    // Add current request
    pipeline.zadd(key, now, `${now}-${Math.random()}`);

    // Set expiry
    pipeline.expire(key, Math.ceil(config.windowMs / 1000));

    const results = await pipeline.exec();

    const count = results[1][1];
    const allowed = count < config.maxRequests;

    if (!allowed) {
      // Remove the just-added entry if limit exceeded
      await this.redis.zrem(key, `${now}-${Math.random()}`);
    }

    return {
      allowed,
      count: Math.min(count, config.maxRequests),
      remaining: Math.max(0, config.maxRequests - count - 1),
      resetTime: now + config.windowMs,
    };
  }

  /**
   * Generate rate limit key
   */
  _generateKey(req, config) {
    if (config.keyGenerator) {
      return config.keyGenerator(req);
    }

    // Default: Use IP + endpoint
    const ip = req.ip || req.connection.remoteAddress;
    const endpoint = req.route?.path || req.path;
    return `${config.keyPrefix}${ip}:${endpoint}`;
  }

  /**
   * Reset rate limit for identifier
   */
  async reset(identifier) {
    const key = `${this.config.keyPrefix}${identifier}`;
    await this.redis.del(key);
    logger.info(`Rate limit reset for ${identifier}`);
  }

  /**
   * Get current usage for identifier
   */
  async getUsage(identifier) {
    const key = `${this.config.keyPrefix}${identifier}`;
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    const count = await this.redis.zcount(key, windowStart, now);

    return {
      count,
      limit: this.config.maxRequests,
      remaining: Math.max(0, this.config.maxRequests - count),
      resetTime: now + this.config.windowMs,
    };
  }

  /**
   * Shutdown rate limiter
   */
  async shutdown() {
    await this.redis.quit();
    logger.info('RateLimiter shutdown complete');
  }
}

/**
 * Create tiered rate limiters for different user types
 */
export class TieredRateLimiter {
  constructor(tiers = {}) {
    this.tiers = {
      anonymous: new RateLimiter({ maxRequests: 10, windowMs: 60_000 }),
      basic: new RateLimiter({ maxRequests: 100, windowMs: 60_000 }),
      premium: new RateLimiter({ maxRequests: 1000, windowMs: 60_000 }),
      unlimited: null,
      ...tiers,
    };
  }

  /**
   * Middleware with tier detection
   */
  middleware() {
    return async (req, res, next) => {
      const tier = this._getUserTier(req);
      const limiter = this.tiers[tier];

      if (!limiter) {
        // Unlimited tier
        return next();
      }

      // Apply rate limiting for this tier
      return limiter.middleware()(req, res, next);
    };
  }

  /**
   * Determine user tier from request
   */
  _getUserTier(req) {
    // Check for API key
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
      return 'anonymous';
    }

    // In production, validate API key and get tier from database
    // This is simplified for example
    if (apiKey.startsWith('premium_')) {
      return 'premium';
    }

    if (apiKey.startsWith('unlimited_')) {
      return 'unlimited';
    }

    return 'basic';
  }

  /**
   * Shutdown all tier limiters
   */
  async shutdown() {
    const shutdownPromises = Object.values(this.tiers)
      .filter(Boolean)
      .map((limiter) => limiter.shutdown());

    await Promise.all(shutdownPromises);
  }
}

export default RateLimiter;
