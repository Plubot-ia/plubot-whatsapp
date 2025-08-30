import crypto from 'crypto';
import logger from '../../core/utils/logger.js';
import { logSecurityEvent, AUDIT_EVENTS } from './audit.middleware.js';

/**
 * CSRF Protection Middleware
 * Protects against Cross-Site Request Forgery attacks
 * Note: csurf is deprecated, so implementing custom CSRF protection
 */

class CSRFProtection {
  constructor() {
    this.tokenStore = new Map();
    this.config = {
      tokenLength: 32,
      tokenExpiry: 3600000, // 1 hour in milliseconds
      cookieName: '_csrf',
      headerName: 'x-csrf-token',
      paramName: '_csrf',
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      skipMethods: ['GET', 'HEAD', 'OPTIONS'],
      skipPaths: ['/health', '/metrics', '/api/webhooks', '/api/sessions'],
      doubleSubmitCookie: true
    };
    
    // Cleanup expired tokens periodically
    this.startCleanup();
  }
  
  /**
   * Generate CSRF token
   */
  generateToken() {
    return crypto.randomBytes(this.config.tokenLength).toString('hex');
  }
  
  /**
   * Store token with expiry
   */
  storeToken(sessionId, token) {
    const expiry = Date.now() + this.config.tokenExpiry;
    this.tokenStore.set(`${sessionId}:${token}`, {
      token,
      expiry,
      created: Date.now()
    });
    
    // Also store by session for retrieval
    this.tokenStore.set(`session:${sessionId}`, token);
    
    return token;
  }
  
  /**
   * Validate token
   */
  validateToken(sessionId, token) {
    const key = `${sessionId}:${token}`;
    const tokenData = this.tokenStore.get(key);
    
    if (!tokenData) {
      return false;
    }
    
    // Check if expired
    if (Date.now() > tokenData.expiry) {
      this.tokenStore.delete(key);
      this.tokenStore.delete(`session:${sessionId}`);
      return false;
    }
    
    return true;
  }
  
  /**
   * Get token for session
   */
  getTokenForSession(sessionId) {
    return this.tokenStore.get(`session:${sessionId}`);
  }
  
  /**
   * Revoke token
   */
  revokeToken(sessionId, token) {
    this.tokenStore.delete(`${sessionId}:${token}`);
    this.tokenStore.delete(`session:${sessionId}`);
  }
  
  /**
   * Cleanup expired tokens
   */
  cleanup() {
    const now = Date.now();
    const toDelete = [];
    
    for (const [key, value] of this.tokenStore) {
      if (key.startsWith('session:')) continue;
      
      if (value.expiry && value.expiry < now) {
        toDelete.push(key);
      }
    }
    
    toDelete.forEach(key => this.tokenStore.delete(key));
    
    if (toDelete.length > 0) {
      logger.debug(`CSRF cleanup: removed ${toDelete.length} expired tokens`);
    }
  }
  
  /**
   * Start periodic cleanup
   */
  startCleanup() {
    // Run cleanup every 10 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 600000);
  }
  
  /**
   * Stop cleanup
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Create singleton instance
const csrfProtection = new CSRFProtection();

/**
 * CSRF token generation middleware
 */
const csrfToken = (req, res, next) => {
  // Generate or retrieve token for session
  const sessionId = req.sessionID || req.user?.id || req.ip;
  
  let token = csrfProtection.getTokenForSession(sessionId);
  
  if (!token) {
    token = csrfProtection.generateToken();
    csrfProtection.storeToken(sessionId, token);
  }
  
  // Attach token to request
  req.csrfToken = () => token;
  
  // Set token in response locals for templates
  res.locals.csrfToken = token;
  
  // Set token as cookie if double submit cookie pattern
  if (csrfProtection.config.doubleSubmitCookie) {
    res.cookie(csrfProtection.config.cookieName, token, {
      httpOnly: csrfProtection.config.httpOnly,
      secure: csrfProtection.config.secure,
      sameSite: csrfProtection.config.sameSite,
      maxAge: csrfProtection.config.tokenExpiry
    });
  }
  
  next();
};

/**
 * CSRF validation middleware
 */
const csrfValidation = (options = {}) => {
  const config = { ...csrfProtection.config, ...options };
  
  return async (req, res, next) => {
    // Skip for safe methods
    if (config.skipMethods.includes(req.method)) {
      return next();
    }
    
    // Skip for configured paths
    if (config.skipPaths.some(path => req.path.startsWith(path))) {
      return next();
    }
    
    // Skip if API key authentication is present
    if (req.headers['x-api-key']) {
      return next();
    }
    
    // Get session ID
    const sessionId = req.sessionID || req.user?.id || req.ip;
    
    // Get token from request
    let token = null;
    
    // Check header
    token = req.headers[config.headerName] || req.headers[config.headerName.toLowerCase()];
    
    // Check body
    if (!token && req.body) {
      token = req.body[config.paramName];
    }
    
    // Check query
    if (!token && req.query) {
      token = req.query[config.paramName];
    }
    
    // Check cookie (double submit cookie pattern)
    if (!token && config.doubleSubmitCookie && req.cookies) {
      token = req.cookies[config.cookieName];
    }
    
    // Validate token
    if (!token) {
      logger.warn(`CSRF token missing for ${req.method} ${req.path} from ${req.ip}`);
      
      await logSecurityEvent(AUDIT_EVENTS.SECURITY_BREACH_ATTEMPT, req, {
        reason: 'CSRF_TOKEN_MISSING',
        method: req.method,
        path: req.path
      });
      
      return res.status(403).json({
        success: false,
        error: 'CSRF token missing',
        code: 'CSRF_TOKEN_MISSING'
      });
    }
    
    if (!csrfProtection.validateToken(sessionId, token)) {
      logger.warn(`Invalid CSRF token for ${req.method} ${req.path} from ${req.ip}`);
      
      await logSecurityEvent(AUDIT_EVENTS.SECURITY_BREACH_ATTEMPT, req, {
        reason: 'CSRF_TOKEN_INVALID',
        method: req.method,
        path: req.path,
        token: token.substring(0, 8) + '...' // Log partial token for debugging
      });
      
      return res.status(403).json({
        success: false,
        error: 'Invalid CSRF token',
        code: 'CSRF_TOKEN_INVALID'
      });
    }
    
    // Token is valid, continue
    next();
  };
};

/**
 * CSRF error handler
 */
const csrfErrorHandler = (err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN') {
    logger.warn(`CSRF error: ${err.message}`);
    
    return res.status(403).json({
      success: false,
      error: 'Invalid CSRF token',
      code: 'CSRF_TOKEN_INVALID'
    });
  }
  
  next(err);
};

/**
 * Generate and return CSRF token endpoint
 */
const csrfTokenEndpoint = (req, res) => {
  const token = req.csrfToken();
  
  res.json({
    success: true,
    csrfToken: token
  });
};

/**
 * Revoke CSRF token
 */
const revokeCSRFToken = (req, res) => {
  const sessionId = req.sessionID || req.user?.id || req.ip;
  const token = req.csrfToken();
  
  if (token) {
    csrfProtection.revokeToken(sessionId, token);
  }
  
  res.json({
    success: true,
    message: 'CSRF token revoked'
  });
};

/**
 * Get CSRF statistics
 */
const getCSRFStats = () => {
  const stats = {
    totalTokens: 0,
    activeSessions: 0,
    expiredTokens: 0
  };
  
  const now = Date.now();
  const sessions = new Set();
  
  for (const [key, value] of csrfProtection.tokenStore) {
    if (key.startsWith('session:')) {
      stats.activeSessions++;
    } else {
      stats.totalTokens++;
      
      if (value.expiry && value.expiry < now) {
        stats.expiredTokens++;
      }
      
      const sessionId = key.split(':')[0];
      sessions.add(sessionId);
    }
  }
  
  stats.uniqueSessions = sessions.size;
  
  return stats;
};

// Cleanup on process termination
process.on('SIGTERM', () => {
  csrfProtection.stopCleanup();
});

process.on('SIGINT', () => {
  csrfProtection.stopCleanup();
});

export {
  csrfToken,
  csrfValidation,
  csrfErrorHandler,
  csrfTokenEndpoint,
  revokeCSRFToken,
  getCSRFStats,
  csrfProtection
};
