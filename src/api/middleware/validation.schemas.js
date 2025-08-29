const Joi = require('joi');

// Common validation patterns
const patterns = {
  phoneNumber: /^\+?[1-9]\d{1,14}$/,
  sessionId: /^[a-zA-Z0-9_-]+$/,
  userId: /^[a-zA-Z0-9_-]+$/,
  plubotId: /^[0-9]+$/,
  messageId: /^[a-zA-Z0-9_-]+$/
};

// Validation schemas
const schemas = {
  // Authentication
  login: Joi.object({
    username: Joi.string().alphanum().min(3).max(30).required(),
    password: Joi.string().min(6).required()
  }),

  // Session management
  createSession: Joi.object({
    userId: Joi.string().pattern(patterns.userId).required(),
    plubotId: Joi.string().pattern(patterns.plubotId).required(),
    forceNew: Joi.boolean().default(false),
    metadata: Joi.object().optional()
  }),

  sessionId: Joi.object({
    sessionId: Joi.string().pattern(patterns.sessionId).required()
  }),

  userIdPlubotId: Joi.object({
    userId: Joi.string().pattern(patterns.userId).required(),
    plubotId: Joi.string().pattern(patterns.plubotId).required()
  }),

  // Message handling
  sendMessage: Joi.object({
    sessionId: Joi.string().pattern(patterns.sessionId).required(),
    to: Joi.string().pattern(patterns.phoneNumber).required(),
    message: Joi.alternatives().try(
      Joi.string().min(1).max(4096),
      Joi.object({
        text: Joi.string().min(1).max(4096),
        mediaUrl: Joi.string().uri(),
        caption: Joi.string().max(1024),
        fileName: Joi.string().max(255)
      })
    ).required(),
    type: Joi.string().valid('text', 'image', 'document', 'audio', 'video').default('text')
  }),

  sendBulkMessages: Joi.object({
    sessionId: Joi.string().pattern(patterns.sessionId).required(),
    messages: Joi.array().items(
      Joi.object({
        to: Joi.string().pattern(patterns.phoneNumber).required(),
        message: Joi.string().min(1).max(4096).required(),
        type: Joi.string().valid('text', 'image', 'document').default('text')
      })
    ).min(1).max(100).required()
  }),

  // Contact management
  getContacts: Joi.object({
    sessionId: Joi.string().pattern(patterns.sessionId).required(),
    limit: Joi.number().integer().min(1).max(1000).default(100),
    offset: Joi.number().integer().min(0).default(0)
  }),

  checkNumber: Joi.object({
    sessionId: Joi.string().pattern(patterns.sessionId).required(),
    phoneNumber: Joi.string().pattern(patterns.phoneNumber).required()
  }),

  // Group management
  createGroup: Joi.object({
    sessionId: Joi.string().pattern(patterns.sessionId).required(),
    name: Joi.string().min(1).max(100).required(),
    participants: Joi.array().items(
      Joi.string().pattern(patterns.phoneNumber)
    ).min(1).max(256).required()
  }),

  updateGroup: Joi.object({
    sessionId: Joi.string().pattern(patterns.sessionId).required(),
    groupId: Joi.string().required(),
    action: Joi.string().valid('add', 'remove', 'promote', 'demote').required(),
    participants: Joi.array().items(
      Joi.string().pattern(patterns.phoneNumber)
    ).min(1).max(256).required()
  }),

  // Media handling
  uploadMedia: Joi.object({
    sessionId: Joi.string().pattern(patterns.sessionId).required(),
    mediaType: Joi.string().valid('image', 'video', 'audio', 'document').required(),
    fileName: Joi.string().max(255).required(),
    mimeType: Joi.string().required(),
    size: Joi.number().integer().max(64 * 1024 * 1024) // 64MB max
  }),

  // Webhook configuration
  configureWebhook: Joi.object({
    sessionId: Joi.string().pattern(patterns.sessionId).required(),
    url: Joi.string().uri().required(),
    events: Joi.array().items(
      Joi.string().valid(
        'message.received',
        'message.sent',
        'message.delivered',
        'message.read',
        'session.connected',
        'session.disconnected',
        'presence.update'
      )
    ).min(1).required(),
    secret: Joi.string().min(16).optional()
  }),

  // Query parameters
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    sortBy: Joi.string().valid('createdAt', 'updatedAt', 'name').default('createdAt'),
    sortOrder: Joi.string().valid('asc', 'desc').default('desc')
  }),

  dateRange: Joi.object({
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso().greater(Joi.ref('startDate'))
  }),

  // Settings
  updateSettings: Joi.object({
    sessionId: Joi.string().pattern(patterns.sessionId).required(),
    settings: Joi.object({
      autoReconnect: Joi.boolean(),
      maxRetries: Joi.number().integer().min(0).max(10),
      retryDelay: Joi.number().integer().min(1000).max(60000),
      qrTimeout: Joi.number().integer().min(30000).max(180000),
      messageTimeout: Joi.number().integer().min(5000).max(60000)
    }).min(1).required()
  })
};

module.exports = schemas;
