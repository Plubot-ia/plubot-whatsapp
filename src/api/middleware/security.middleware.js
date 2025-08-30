import helmet from 'helmet';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import securityConfig from '../../config/security.config.js';
import logger from '../../core/utils/logger.js';

/**
 * Configure Helmet for security headers
 */
const configureHelmet = () => {
  return helmet({
    contentSecurityPolicy: securityConfig.helmet.contentSecurityPolicy,
    hsts: securityConfig.helmet.hsts,
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
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);
      
      // Allow file:// protocol for local testing if configured
      if (securityConfig.cors.allowFileProtocol && origin.startsWith('file://')) {
        return callback(null, true);
      }
      
      // Check if origin is allowed
      const allowedOrigins = Array.isArray(securityConfig.cors.origin) 
        ? securityConfig.cors.origin 
        : [securityConfig.cors.origin];
      
      // Log for debugging
      logger.debug('CORS check', { 
        origin, 
        allowedOrigins,
        isAllowed: allowedOrigins.includes(origin)
      });
      
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn(`CORS blocked origin: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: securityConfig.cors.credentials,
    optionsSuccessStatus: securityConfig.cors.optionsSuccessStatus,
    methods: securityConfig.cors.methods,
    allowedHeaders: securityConfig.cors.allowedHeaders
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

export {
  configureHelmet,
  configureCors,
  addSecurityHeaders,
  requestId,
  ipFilter
};
