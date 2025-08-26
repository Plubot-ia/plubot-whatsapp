/**
 * Request Validation Middleware
 * Enterprise-grade input validation
 */

import Joi from 'joi';

import logger from '../utils/logger.js';

// Validation schemas
const schemas = {
  createSession: Joi.object({
    userId: Joi.string().alphanum().min(3).max(50).required().messages({
      'string.base': 'userId must be a string',
      'string.alphanum': 'userId must contain only alphanumeric characters',
      'string.min': 'userId must be at least 3 characters long',
      'string.max': 'userId must not exceed 50 characters',
      'any.required': 'userId is required',
    }),
    plubotId: Joi.string().alphanum().min(3).max(50).required().messages({
      'string.base': 'plubotId must be a string',
      'string.alphanum': 'plubotId must contain only alphanumeric characters',
      'string.min': 'plubotId must be at least 3 characters long',
      'string.max': 'plubotId must not exceed 50 characters',
      'any.required': 'plubotId is required',
    }),
  }),

  sendMessage: Joi.object({
    to: Joi.string()
      .pattern(/^\d+@(c\.us|g\.us)$/)
      .required()
      .messages({
        'string.pattern.base': 'to must be a valid WhatsApp ID (e.g., 1234567890@c.us)',
        'any.required': 'to is required',
      }),
    message: Joi.string().min(1).max(4096).required().messages({
      'string.min': 'message cannot be empty',
      'string.max': 'message must not exceed 4096 characters',
      'any.required': 'message is required',
    }),
    options: Joi.object({
      media: Joi.string().uri().optional(),
      caption: Joi.string().max(1024).optional(),
      mentions: Joi.array().items(Joi.string()).optional(),
      quotedMessageId: Joi.string().optional(),
    }).optional(),
  }),

  updateSession: Joi.object({
    status: Joi.string()
      .valid('initializing', 'waiting_qr', 'authenticated', 'ready', 'disconnected', 'error')
      .optional(),
    isReady: Joi.boolean().optional(),
    isAuthenticated: Joi.boolean().optional(),
    error: Joi.string().max(500).optional(),
  }),

  queryParams: Joi.object({
    status: Joi.string()
      .valid('initializing', 'waiting_qr', 'authenticated', 'ready', 'disconnected', 'error')
      .optional(),
    userId: Joi.string().alphanum().optional(),
    plubotId: Joi.string().alphanum().optional(),
    limit: Joi.number().integer().min(1).max(100).default(50),
    offset: Joi.number().integer().min(0).default(0),
  }),
};

/**
 * Validate request middleware factory
 */
export function validateRequest(schemaName) {
  return async (req, res, next) => {
    const schema = schemas[schemaName];

    if (!schema) {
      logger.error(`Validation schema '${schemaName}' not found`);
      return res.status(500).json({
        success: false,
        error: 'Internal validation error',
      });
    }

    try {
      // Determine what to validate
      const dataToValidate = req.method === 'GET' ? req.query : req.body;

      // Validate
      const { error, value } = schema.validate(dataToValidate, {
        abortEarly: false,
        stripUnknown: true,
        convert: true,
      });

      if (error) {
        const errors = error.details.map((detail) => ({
          field: detail.path.join('.'),
          message: detail.message,
        }));

        logger.warn('Validation failed:', errors);

        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          errors,
        });
      }

      // Replace with validated data
      if (req.method === 'GET') {
        req.query = value;
      } else {
        req.body = value;
      }

      next();
    } catch (error) {
      logger.error('Validation error:', error);

      return res.status(500).json({
        success: false,
        error: 'Internal validation error',
      });
    }
  };
}

/**
 * Sanitize input to prevent XSS and injection attacks
 */
export function sanitizeInput(input) {
  if (typeof input !== 'string') return input;

  // Remove HTML tags
  let sanitized = input.replaceAll(/<[^>]*>/g, '');

  // Remove script tags and content
  sanitized = sanitized.replaceAll(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // Escape special characters
  sanitized = sanitized
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')
    .replaceAll('/', '&#x2F;');

  return sanitized;
}

/**
 * Validate WhatsApp phone number
 */
export function validatePhoneNumber(phoneNumber) {
  // Remove all non-numeric characters
  const cleaned = phoneNumber.replaceAll(/\D/g, '');

  // Check if it's a valid length (typically 10-15 digits)
  if (cleaned.length < 10 || cleaned.length > 15) {
    return false;
  }

  // Check if it starts with a valid country code
  // This is a simplified check - you might want to use a library like libphonenumber
  const validCountryCodes = ['1', '44', '91', '86', '81', '49', '33', '39', '34', '55', '52'];
  const hasValidCountryCode = validCountryCodes.some((code) => cleaned.startsWith(code));

  return hasValidCountryCode || cleaned.length === 10; // Allow local numbers
}

/**
 * Validate session ID format
 */
export function validateSessionId(sessionId) {
  // Session ID should be in format: userId-plubotId
  const pattern = /^[\dA-Za-z]{3,50}-[\dA-Za-z]{3,50}$/;
  return pattern.test(sessionId);
}

export default {
  validateRequest,
  sanitizeInput,
  validatePhoneNumber,
  validateSessionId,
};
