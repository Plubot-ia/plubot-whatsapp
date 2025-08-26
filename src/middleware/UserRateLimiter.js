import logger from '../utils/logger.js';

/**
 * Advanced rate limiter for per-user request throttling
 */
class UserRateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 60000; // 1 minute
    this.maxRequests = options.maxRequests || 30;
    this.maxBurst = options.maxBurst || 10;
    this.userWindows = new Map();
    this.globalMetrics = {
      totalRequests: 0,
      blockedRequests: 0,
      allowedRequests: 0
    };
    
    // Cleanup old windows periodically
    this.startCleanup();
  }

  /**
   * Check if request should be allowed
   */
  async checkLimit(userId, weight = 1) {
    const now = Date.now();
    const userWindow = this.getUserWindow(userId);
    
    // Clean old requests
    userWindow.requests = userWindow.requests.filter(
      req => now - req.timestamp < this.windowMs
    );
    
    // Check burst limit
    const recentBurst = userWindow.requests.filter(
      req => now - req.timestamp < 1000
    ).reduce((sum, req) => sum + req.weight, 0);
    
    if (recentBurst + weight > this.maxBurst) {
      this.globalMetrics.blockedRequests++;
      logger.warn(`🚫 User ${userId} exceeded burst limit`);
      return {
        allowed: false,
        reason: 'burst_limit_exceeded',
        retryAfter: 1000
      };
    }
    
    // Check window limit
    const windowTotal = userWindow.requests.reduce((sum, req) => sum + req.weight, 0);
    
    if (windowTotal + weight > this.maxRequests) {
      this.globalMetrics.blockedRequests++;
      const oldestRequest = userWindow.requests[0];
      const retryAfter = oldestRequest ? 
        this.windowMs - (now - oldestRequest.timestamp) : 
        this.windowMs;
      
      logger.warn(`🚫 User ${userId} exceeded rate limit (${windowTotal}/${this.maxRequests})`);
      return {
        allowed: false,
        reason: 'rate_limit_exceeded',
        retryAfter,
        limit: this.maxRequests,
        remaining: 0,
        resetAt: now + retryAfter
      };
    }
    
    // Allow request
    userWindow.requests.push({ timestamp: now, weight });
    this.globalMetrics.allowedRequests++;
    this.globalMetrics.totalRequests++;
    
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: this.maxRequests - windowTotal - weight,
      resetAt: now + this.windowMs
    };
  }

  /**
   * Get or create user window
   */
  getUserWindow(userId) {
    if (!this.userWindows.has(userId)) {
      this.userWindows.set(userId, {
        requests: [],
        createdAt: Date.now()
      });
    }
    return this.userWindows.get(userId);
  }

  /**
   * Reset limits for a user
   */
  resetUser(userId) {
    this.userWindows.delete(userId);
    logger.info(`🔄 Rate limits reset for user ${userId}`);
  }

  /**
   * Get user statistics
   */
  getUserStats(userId) {
    const userWindow = this.userWindows.get(userId);
    if (!userWindow) {
      return {
        requests: 0,
        limit: this.maxRequests,
        remaining: this.maxRequests
      };
    }
    
    const now = Date.now();
    const activeRequests = userWindow.requests.filter(
      req => now - req.timestamp < this.windowMs
    );
    
    const total = activeRequests.reduce((sum, req) => sum + req.weight, 0);
    
    return {
      requests: total,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - total),
      oldestRequest: activeRequests[0]?.timestamp,
      newestRequest: activeRequests[activeRequests.length - 1]?.timestamp
    };
  }

  /**
   * Get global statistics
   */
  getGlobalStats() {
    return {
      ...this.globalMetrics,
      activeUsers: this.userWindows.size,
      blockRate: this.globalMetrics.totalRequests > 0 ? 
        (this.globalMetrics.blockedRequests / this.globalMetrics.totalRequests * 100).toFixed(2) + '%' : 
        '0%'
    };
  }

  /**
   * Start cleanup interval
   */
  startCleanup() {
    setInterval(() => {
      const now = Date.now();
      const staleThreshold = this.windowMs * 2;
      
      for (const [userId, window] of this.userWindows) {
        // Remove windows with no recent activity
        const hasRecentActivity = window.requests.some(
          req => now - req.timestamp < staleThreshold
        );
        
        if (!hasRecentActivity) {
          this.userWindows.delete(userId);
          logger.debug(`🧹 Cleaned up rate limit window for user ${userId}`);
        }
      }
    }, 60000); // Every minute
  }

  /**
   * Express middleware
   */
  middleware(options = {}) {
    const getUserId = options.getUserId || ((req) => req.ip);
    const weight = options.weight || 1;
    
    return async (req, res, next) => {
      const userId = getUserId(req);
      const result = await this.checkLimit(userId, weight);
      
      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', result.limit || this.maxRequests);
      res.setHeader('X-RateLimit-Remaining', result.remaining || 0);
      
      if (result.resetAt) {
        res.setHeader('X-RateLimit-Reset', new Date(result.resetAt).toISOString());
      }
      
      if (!result.allowed) {
        res.setHeader('Retry-After', Math.ceil(result.retryAfter / 1000));
        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Please retry after ${Math.ceil(result.retryAfter / 1000)} seconds`,
          retryAfter: result.retryAfter
        });
      }
      
      next();
    };
  }
}

// Create instances for different endpoints
const sessionRateLimiter = new UserRateLimiter({
  windowMs: 60000,
  maxRequests: 10,
  maxBurst: 3
});

const messageRateLimiter = new UserRateLimiter({
  windowMs: 60000,
  maxRequests: 60,
  maxBurst: 10
});

const qrRateLimiter = new UserRateLimiter({
  windowMs: 300000, // 5 minutes
  maxRequests: 5,
  maxBurst: 2
});

export { UserRateLimiter, sessionRateLimiter, messageRateLimiter, qrRateLimiter };
