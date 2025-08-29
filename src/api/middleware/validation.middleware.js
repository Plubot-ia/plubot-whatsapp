const Joi = require('joi');
const xss = require('xss');
const logger = require('../../core/utils/logger');
const schemas = require('./validation.schemas');

/**
 * Validation schemas for different endpoints
 */
const validationSchemas = {
  createSession: Joi.object({
    userId: Joi.string().required().min(1).max(100).trim(),
    plubotId: Joi.string().required().min(1).max(100).trim(),
    forceNew: Joi.boolean().optional().default(false)
  }),
  
  sendMessage: Joi.object({
    sessionId: Joi.string().required().pattern(/^[\w-]+-[\w-]+$/),
    to: Joi.string().required().pattern(/^\d{10,15}$/),
    message: Joi.string().required().min(1).max(5000),
    type: Joi.string().valid('text', 'image', 'document', 'audio', 'video').default('text'),
    mediaUrl: Joi.string().uri().when('type', {
      is: Joi.not('text'),
      then: Joi.required(),
      otherwise: Joi.optional()
    })
  }),
  
  sessionId: Joi.object({
    sessionId: Joi.string().required().pattern(/^[\w-]+-[\w-]+$/)
  }),
  
  userIdPlubotId: Joi.object({
    userId: Joi.string().required().min(1).max(100),
    plubotId: Joi.string().required().min(1).max(100)
  }),
  
  refreshQR: Joi.object({
    sessionId: Joi.string().required().pattern(/^[\w-]+-[\w-]+$/),
    force: Joi.boolean().optional().default(false)
  }),
  
  webhook: Joi.object({
    url: Joi.string().required().uri(),
    events: Joi.array().items(
      Joi.string().valid('message', 'status', 'qr', 'connected', 'disconnected')
    ).min(1).required(),
    secret: Joi.string().optional().min(16)
  })
};

/**
 * Validate request body
 */
const validateBody = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });
    
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));
      
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        errors
      });
    }
    
    req.validatedBody = value;
    next();
  };
};

/**
 * Validate request params
 */
const validateParams = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.params, {
      abortEarly: false,
      stripUnknown: true
    });
    
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));
      
      return res.status(400).json({
        success: false,
        error: 'Invalid parameters',
        errors
      });
    }
    
    req.validatedParams = value;
    next();
  };
};

/**
 * Validate request query
 */
const validateQuery = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query, {
      abortEarly: false,
      stripUnknown: true
    });
    
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));
      
      return res.status(400).json({
        success: false,
        error: 'Invalid query parameters',
        errors
      });
    }
    
    req.validatedQuery = value;
    next();
  };
};

/**
 * Sanitize input to prevent XSS and injection attacks
 */
const sanitizeInput = (req, res, next) => {
  // Recursively sanitize object
  const sanitize = (obj) => {
    if (typeof obj === 'string') {
      // Remove potential script tags and dangerous characters
      return xss(obj)
        .replace(/javascript:/gi, '')
        .replace(/on\w+\s*=/gi, '')
        .trim();
    }
    
    if (Array.isArray(obj)) {
      return obj.map(sanitize);
    }
    
    if (obj && typeof obj === 'object') {
      const sanitized = {};
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          sanitized[key] = sanitize(obj[key]);
        }
      }
      return sanitized;
    }
    
    return obj;
  };
  
  if (req.body) {
    req.body = sanitize(req.body);
  }
  
  if (req.query) {
    req.query = sanitize(req.query);
  }
  
  if (req.params) {
    req.params = sanitize(req.params);
  }
  
  next();
};

/**
 * Validate session ownership
 */
const validateSessionOwnership = async (req, res, next) => {
  const sessionId = req.params.sessionId || req.body.sessionId;
  const userId = req.user?.id;
  
  if (!sessionId || !userId) {
    return res.status(400).json({
      success: false,
      error: 'Session ID and user ID required'
    });
  }
  
  // Check if session belongs to user
  const [sessionUserId] = sessionId.split('-');
  
  if (sessionUserId !== userId && req.user?.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Access denied to this session'
    });
  }
  
  next();
};

module.exports = {
  validateBody,
  validateParams,
  validateQuery,
  sanitizeInput,
  validateSessionOwnership,
  schemas: validationSchemas
};
