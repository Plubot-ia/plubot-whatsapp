import redis from 'redis';
import { promisify } from 'util';
import logger from '../../core/utils/logger.js';
import { logSecurityEvent, AUDIT_EVENTS } from './audit.middleware.js';

/**
 * IP Blacklist Middleware
 * Automatically blocks malicious IPs based on suspicious behavior
 */

class IPBlacklistManager {
  constructor() {
    this.redisClient = null;
    this.blacklistPrefix = 'ip:blacklist:';
    this.suspiciousPrefix = 'ip:suspicious:';
    this.whitelistPrefix = 'ip:whitelist:';
    this.attemptPrefix = 'ip:attempts:';
    
    // Configuration
    this.config = {
      maxFailedAttempts: parseInt(process.env.MAX_FAILED_ATTEMPTS) || 5,
      suspiciousThreshold: parseInt(process.env.SUSPICIOUS_THRESHOLD) || 10,
      blacklistDuration: parseInt(process.env.BLACKLIST_DURATION) || 86400, // 24 hours in seconds
      suspiciousDuration: parseInt(process.env.SUSPICIOUS_DURATION) || 3600, // 1 hour in seconds
      attemptWindow: parseInt(process.env.ATTEMPT_WINDOW) || 900, // 15 minutes in seconds
      permanentBlacklistAfter: parseInt(process.env.PERMANENT_BLACKLIST_AFTER) || 3, // permanent after 3 blacklists
      whitelistedIPs: (process.env.WHITELISTED_IPS || '').split(',').filter(ip => ip),
      trustedProxies: (process.env.TRUSTED_PROXIES || '').split(',').filter(ip => ip)
    };
    
    this.initializeRedis();
    this.initializeWhitelist();
  }
  
  async initializeRedis() {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      this.redisClient = redis.createClient({ url: redisUrl });
      
      this.redisClient.on('error', (err) => {
        logger.error('Redis client error in IP Blacklist:', err);
      });
      
      await this.redisClient.connect();
      
      // Redis v4 methods are already promisified
      this.redisGet = this.redisClient.get.bind(this.redisClient);
      this.redisSet = this.redisClient.set.bind(this.redisClient);
      this.redisSetex = this.redisClient.setEx.bind(this.redisClient);
      this.redisDel = this.redisClient.del.bind(this.redisClient);
      this.redisIncr = this.redisClient.incr.bind(this.redisClient);
      this.redisExpire = this.redisClient.expire.bind(this.redisClient);
      this.redisKeys = this.redisClient.keys.bind(this.redisClient);
      
      logger.info('IP Blacklist Redis connection established');
    } catch (error) {
      logger.error('Failed to initialize Redis for IP Blacklist:', error);
    }
  }
  
  async initializeWhitelist() {
    // Add configured whitelisted IPs to Redis
    for (const ip of this.config.whitelistedIPs) {
      if (ip) {
        await this.whitelistIP(ip, 'system_config');
      }
    }
  }
  
  /**
   * Extract real IP from request
   */
  getClientIP(req) {
    // Check for trusted proxy headers
    if (this.config.trustedProxies.includes(req.ip)) {
      const forwardedFor = req.headers['x-forwarded-for'];
      if (forwardedFor) {
        return forwardedFor.split(',')[0].trim();
      }
      
      const realIP = req.headers['x-real-ip'];
      if (realIP) {
        return realIP;
      }
    }
    
    return req.ip || req.connection.remoteAddress;
  }
  
  /**
   * Check if IP is whitelisted
   */
  async isWhitelisted(ip) {
    if (!this.redisClient) return false;
    
    try {
      const key = `${this.whitelistPrefix}${ip}`;
      const result = await this.redisGet(key);
      return result !== null;
    } catch (error) {
      logger.error('Error checking whitelist:', error);
      return false;
    }
  }
  
  /**
   * Check if IP is blacklisted
   */
  async isBlacklisted(ip) {
    if (!this.redisClient) return false;
    
    try {
      const key = `${this.blacklistPrefix}${ip}`;
      const result = await this.redisGet(key);
      return result !== null;
    } catch (error) {
      logger.error('Error checking blacklist:', error);
      return false;
    }
  }
  
  /**
   * Check if IP is suspicious
   */
  async isSuspicious(ip) {
    if (!this.redisClient) return false;
    
    try {
      const key = `${this.suspiciousPrefix}${ip}`;
      const count = await this.redisGet(key);
      return count && parseInt(count) >= this.config.suspiciousThreshold;
    } catch (error) {
      logger.error('Error checking suspicious IP:', error);
      return false;
    }
  }
  
  /**
   * Record failed attempt
   */
  async recordFailedAttempt(ip, reason, req) {
    if (!this.redisClient) return;
    
    try {
      // Check if whitelisted
      if (await this.isWhitelisted(ip)) {
        return;
      }
      
      const attemptKey = `${this.attemptPrefix}${ip}`;
      const suspiciousKey = `${this.suspiciousPrefix}${ip}`;
      
      // Increment attempt counter
      const attempts = await this.redisIncr(attemptKey);
      
      // Set expiry on first attempt
      if (attempts === 1) {
        await this.redisExpire(attemptKey, this.config.attemptWindow);
      }
      
      // Increment suspicious counter
      await this.redisIncr(suspiciousKey);
      await this.redisExpire(suspiciousKey, this.config.suspiciousDuration);
      
      logger.warn(`Failed attempt recorded for IP ${ip}: ${reason} (${attempts} attempts)`);
      
      // Check if should be blacklisted
      if (attempts >= this.config.maxFailedAttempts) {
        await this.blacklistIP(ip, reason, req);
      }
      
      // Log security event
      await logSecurityEvent(AUDIT_EVENTS.SECURITY_BREACH_ATTEMPT, req, {
        ip,
        reason,
        attempts
      });
    } catch (error) {
      logger.error('Error recording failed attempt:', error);
    }
  }
  
  /**
   * Blacklist an IP
   */
  async blacklistIP(ip, reason, req = null) {
    if (!this.redisClient) return;
    
    try {
      // Check if whitelisted
      if (await this.isWhitelisted(ip)) {
        logger.warn(`Attempted to blacklist whitelisted IP: ${ip}`);
        return;
      }
      
      const blacklistKey = `${this.blacklistPrefix}${ip}`;
      const blacklistCountKey = `${this.blacklistPrefix}count:${ip}`;
      
      // Increment blacklist count
      const blacklistCount = await this.redisIncr(blacklistCountKey);
      
      // Determine if permanent blacklist
      const isPermanent = blacklistCount >= this.config.permanentBlacklistAfter;
      const duration = isPermanent ? 0 : this.config.blacklistDuration;
      
      // Store blacklist entry
      const blacklistData = JSON.stringify({
        reason,
        timestamp: new Date().toISOString(),
        count: blacklistCount,
        permanent: isPermanent
      });
      
      if (isPermanent) {
        await this.redisSet(blacklistKey, blacklistData);
        logger.error(`IP ${ip} permanently blacklisted: ${reason}`);
      } else {
        await this.redisSetex(blacklistKey, duration, blacklistData);
        logger.warn(`IP ${ip} blacklisted for ${duration} seconds: ${reason}`);
      }
      
      // Clear attempts
      await this.redisDel(`${this.attemptPrefix}${ip}`);
      
      // Log security event
      if (req) {
        await logSecurityEvent(AUDIT_EVENTS.SECURITY_IP_BLOCKED, req, {
          ip,
          reason,
          permanent: isPermanent,
          duration
        });
      }
      
      // Send alert for permanent blacklist
      if (isPermanent) {
        this.sendBlacklistAlert(ip, reason, true);
      }
    } catch (error) {
      logger.error('Error blacklisting IP:', error);
    }
  }
  
  /**
   * Whitelist an IP
   */
  async whitelistIP(ip, reason) {
    if (!this.redisClient) return;
    
    try {
      const whitelistKey = `${this.whitelistPrefix}${ip}`;
      const whitelistData = JSON.stringify({
        reason,
        timestamp: new Date().toISOString()
      });
      
      await this.redisSet(whitelistKey, whitelistData);
      
      // Remove from blacklist if present
      await this.removeFromBlacklist(ip);
      
      logger.info(`IP ${ip} whitelisted: ${reason}`);
    } catch (error) {
      logger.error('Error whitelisting IP:', error);
    }
  }
  
  /**
   * Remove IP from blacklist
   */
  async removeFromBlacklist(ip) {
    if (!this.redisClient) return;
    
    try {
      const blacklistKey = `${this.blacklistPrefix}${ip}`;
      await this.redisDel(blacklistKey);
      logger.info(`IP ${ip} removed from blacklist`);
    } catch (error) {
      logger.error('Error removing IP from blacklist:', error);
    }
  }
  
  /**
   * Get blacklist statistics
   */
  async getBlacklistStats() {
    if (!this.redisClient) return null;
    
    try {
      const blacklistKeys = await this.redisKeys(`${this.blacklistPrefix}*`);
      const suspiciousKeys = await this.redisKeys(`${this.suspiciousPrefix}*`);
      const whitelistKeys = await this.redisKeys(`${this.whitelistPrefix}*`);
      
      const stats = {
        blacklisted: blacklistKeys.filter(k => !k.includes('count:')).length,
        suspicious: suspiciousKeys.length,
        whitelisted: whitelistKeys.length,
        details: {
          blacklist: [],
          suspicious: [],
          whitelist: []
        }
      };
      
      // Get blacklist details
      for (const key of blacklistKeys.filter(k => !k.includes('count:'))) {
        const ip = key.replace(this.blacklistPrefix, '');
        const data = await this.redisGet(key);
        try {
          stats.details.blacklist.push({
            ip,
            ...JSON.parse(data)
          });
        } catch (e) {
          stats.details.blacklist.push({ ip, data });
        }
      }
      
      return stats;
    } catch (error) {
      logger.error('Error getting blacklist stats:', error);
      return null;
    }
  }
  
  /**
   * Send blacklist alert
   */
  async sendBlacklistAlert(ip, reason, isPermanent) {
    try {
      const message = `${isPermanent ? 'PERMANENT' : 'TEMPORARY'} BLACKLIST: IP ${ip} - ${reason}`;
      logger.error(message);
      
      // Send to monitoring service if configured
      if (process.env.SECURITY_ALERT_WEBHOOK) {
        // Implement webhook notification
      }
    } catch (error) {
      logger.error('Failed to send blacklist alert:', error);
    }
  }
  
  /**
   * Cleanup expired entries
   */
  async cleanup() {
    // Redis handles expiration automatically
    logger.info('IP Blacklist cleanup completed');
  }
}

// Create singleton instance
const blacklistManager = new IPBlacklistManager();

/**
 * IP Blacklist middleware
 */
const ipBlacklistMiddleware = (options = {}) => {
  const {
    checkSuspicious = true,
    autoBlock = true,
    customMessage = null
  } = options;
  
  return async (req, res, next) => {
    try {
      const ip = blacklistManager.getClientIP(req);
      
      // Check whitelist first
      if (await blacklistManager.isWhitelisted(ip)) {
        return next();
      }
      
      // Check blacklist
      if (await blacklistManager.isBlacklisted(ip)) {
        logger.warn(`Blocked request from blacklisted IP: ${ip}`);
        
        await logSecurityEvent(AUDIT_EVENTS.SECURITY_BREACH_ATTEMPT, req, {
          ip,
          action: 'blocked',
          reason: 'blacklisted'
        });
        
        return res.status(403).json({
          success: false,
          error: customMessage || 'Access denied',
          code: 'IP_BLACKLISTED'
        });
      }
      
      // Check suspicious IPs
      if (checkSuspicious && await blacklistManager.isSuspicious(ip)) {
        logger.warn(`Request from suspicious IP: ${ip}`);
        
        // Add delay for suspicious IPs
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Attach blacklist manager to request
      req.blacklistManager = blacklistManager;
      req.clientIP = ip;
      
      next();
    } catch (error) {
      logger.error('Error in IP blacklist middleware:', error);
      // Don't block on error
      next();
    }
  };
};

/**
 * Record security violation
 */
const recordSecurityViolation = async (req, reason) => {
  const ip = blacklistManager.getClientIP(req);
  await blacklistManager.recordFailedAttempt(ip, reason, req);
};

/**
 * Express error handler for automatic blacklisting
 */
const blacklistErrorHandler = (err, req, res, next) => {
  // Check for specific error types that should trigger blacklisting
  const blacklistErrors = [
    'INVALID_TOKEN',
    'MALFORMED_REQUEST',
    'SQL_INJECTION_ATTEMPT',
    'XSS_ATTEMPT',
    'PATH_TRAVERSAL_ATTEMPT',
    'BRUTE_FORCE_ATTEMPT'
  ];
  
  if (blacklistErrors.includes(err.code)) {
    recordSecurityViolation(req, err.code);
  }
  
  next(err);
};

// Cleanup on process termination
process.on('SIGTERM', () => {
  if (blacklistManager.redisClient) {
    blacklistManager.redisClient.quit();
  }
});

export {
  ipBlacklistMiddleware,
  recordSecurityViolation,
  blacklistErrorHandler,
  blacklistManager
};
