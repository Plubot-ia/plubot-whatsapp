import jwt from 'jsonwebtoken';
import logger from '../../core/utils/logger.js';
import securityConfig from '../../config/security.config.js';

const { jwt: jwtConfig, apiKey: apiKeyConfig } = securityConfig;

/**
 * JWT Authentication Middleware
 */
const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({ 
      success: false, 
      error: 'No authorization header provided' 
    });
  }

  const token = authHeader.split(' ')[1]; // Bearer <token>
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      error: 'No token provided' 
    });
  }

  try {
    const decoded = jwt.verify(token, jwtConfig.secret);
    req.user = decoded;
    next();
  } catch (error) {
    return null;
  }
};

/**
 * API Key Authentication Middleware
 */
const authenticateAPIKey = (req, res, next) => {
  const apiKey = req.headers[apiKeyConfig.header];
  
  if (!apiKey) {
    return res.status(401).json({ 
      success: false, 
      error: 'API key required' 
    });
  }
  
  if (apiKey !== apiKeyConfig.secret) {
    return res.status(401).json({ 
      success: false, 
      error: 'Invalid API key' 
    });
  }
  
  next();
};

/**
 * Combined Authentication - JWT or API Key
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers[apiKeyConfig.header];
  
  // If API key is provided, use API key authentication
  if (apiKey) {
    return authenticateApiKey(req, res, next);
  }
  
  // Otherwise, use JWT authentication
  if (authHeader) {
    return authenticateJWT(req, res, next);
  }
  
  // No authentication provided
  return res.status(401).json({ 
    success: false, 
    error: 'Authentication required. Provide either JWT token or API key' 
  });
};

/**
 * Generate JWT Token
 */
const generateToken = (payload) => {
  return jwt.sign(payload, jwtConfig.secret, { 
    expiresIn: jwtConfig.expiresIn 
  });
};

/**
 * Verify Token (for manual verification)
 */
const verifyToken = (token) => {
  try {
    return jwt.verify(token, jwtConfig.secret);
  } catch (error) {
    return null;
  }
};

export {
  authenticate,
  authenticateJWT,
  authenticateAPIKey,
  generateToken,
  verifyToken
};
