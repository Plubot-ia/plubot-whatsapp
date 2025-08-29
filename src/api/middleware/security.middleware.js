const helmet = require('helmet');
const cors = require('cors');
const { helmet: helmetConfig, cors: corsConfig } = require('../../config/security.config');

/**
 * Configure Helmet for security headers
 */
const configureHelmet = () => {
  return helmet({
    contentSecurityPolicy: helmetConfig.contentSecurityPolicy,
    hsts: helmetConfig.hsts,
    noSniff: true,
    xssFilter: true,
    referrerPolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
    permittedCrossDomainPolicies: false
  });
};

/**
 * Configure CORS
 */
const configureCors = () => {
  return cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or Postman)
      if (!origin) return callback(null, true);
      
      // Check if origin is allowed
      const allowedOrigins = Array.isArray(corsConfig.origin) 
        ? corsConfig.origin 
        : [corsConfig.origin];
      
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: corsConfig.credentials,
    optionsSuccessStatus: corsConfig.optionsSuccessStatus,
    methods: corsConfig.methods,
    allowedHeaders: corsConfig.allowedHeaders
  });
};

/**
 * Add security headers middleware
 */
const addSecurityHeaders = (req, res, next) => {
  // Add custom security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  
  // Remove sensitive headers
  res.removeHeader('X-Powered-By');
  res.removeHeader('Server');
  
  next();
};

/**
 * Request ID middleware for tracking
 */
const requestId = (req, res, next) => {
  const id = req.headers['x-request-id'] || 
             `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  req.id = id;
  res.setHeader('X-Request-ID', id);
  
  next();
};

/**
 * IP filtering middleware
 */
const ipFilter = (allowedIPs = []) => {
  return (req, res, next) => {
    if (allowedIPs.length === 0) {
      return next();
    }
    
    const clientIP = req.ip || req.connection.remoteAddress;
    
    if (!allowedIPs.includes(clientIP)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied from this IP address'
      });
    }
    
    next();
  };
};

module.exports = {
  configureHelmet,
  configureCors,
  addSecurityHeaders,
  requestId,
  ipFilter
};
