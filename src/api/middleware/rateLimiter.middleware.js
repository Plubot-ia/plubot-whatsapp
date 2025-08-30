import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import logger from '../../core/utils/logger.js';
import securityConfig from '../../config/security.config.js';

const { rateLimit: rateLimitConfig, slowDown: slowDownConfig } = securityConfig;

/**
 * General Rate Limiter
 */
const generalLimiter = rateLimit({
  windowMs: rateLimitConfig.windowMs,
  max: rateLimitConfig.max,
  message: rateLimitConfig.message,
  standardHeaders: rateLimitConfig.standardHeaders,
  legacyHeaders: rateLimitConfig.legacyHeaders,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: rateLimitConfig.message,
      retryAfter: req.rateLimit.resetTime
    });
  }
});

/**
 * Session Creation Rate Limiter
 */
const sessionCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // limit each IP to 10 session creations per hour
  message: 'Too many session creation attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: false
});

/**
 * Message Sending Rate Limiter
 */
const messageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 messages per minute
  message: 'Message rate limit exceeded, please slow down.',
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * QR Code Request Rate Limiter
 */
const qrCodeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 QR requests per minute
  message: 'Too many QR code requests, please wait.',
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Auth Rate Limiter
 */
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 auth attempts per minute
  message: 'Too many auth attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * Speed Limiter - gradually slows down responses
 */
const speedLimiter = slowDown({
  windowMs: slowDownConfig.windowMs,
  delayAfter: slowDownConfig.delayAfter,
  delayMs: slowDownConfig.delayMs,
  maxDelayMs: 20000, // maximum delay of 20 seconds
  skipFailedRequests: false,
  skipSuccessfulRequests: false
});

/**
 * Per-User Rate Limiter (requires user identification)
 */
const createUserRateLimiter = (options = {}) => {
  return rateLimit({
    windowMs: options.windowMs || 60 * 1000,
    max: options.max || 100,
    keyGenerator: (req) => {
      // Use user ID from JWT or session ID as key
      return req.user?.id || req.session?.id || req.ip;
    },
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        error: 'User rate limit exceeded',
        retryAfter: req.rateLimit.resetTime
      });
    }
  });
};

/**
 * Dynamic Rate Limiter based on user tier
 */
const tieredRateLimiter = (req, res, next) => {
  const userTier = req.user?.tier || 'free';
  
  const limits = {
    free: { windowMs: 60000, max: 10 },
    basic: { windowMs: 60000, max: 50 },
    premium: { windowMs: 60000, max: 200 },
    enterprise: { windowMs: 60000, max: 1000 }
  };
  
  const tierLimit = limits[userTier];
  
  const limiter = rateLimit({
    windowMs: tierLimit.windowMs,
    max: tierLimit.max,
    keyGenerator: (req) => req.user?.id || req.ip,
    handler: (req, res) => {
      res.status(429).json({
        success: false,
        error: `Rate limit exceeded for ${userTier} tier`,
        tier: userTier,
        limit: tierLimit.max,
        windowMs: tierLimit.windowMs
      });
    }
  });
  
  limiter(req, res, next);
};

export {
  generalLimiter,
  sessionCreationLimiter,
  messageLimiter,
  qrCodeLimiter,
  authLimiter,
  speedLimiter,
  createUserRateLimiter,
  tieredRateLimiter
};
