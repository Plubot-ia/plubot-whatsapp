import logger from '../utils/logger.js';

/**
 * Authenticate incoming requests with API key
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void|Object} - Calls next() or returns error response
 */
export function authenticateRequest(req, res, next) {
  logger.info('Auth middleware called');

  const apiKey = req.headers['x-api-key'];
  const validApiKey = process.env.API_KEY;
  const internalApiKey = process.env.PYTHON_API_KEY || 'internal-api-key';

  if (!apiKey) {
    logger.warn('No API key provided');
    return res.status(401).json({
      success: false,
      error: 'API key required',
    });
  }

  // Accept both environment API key and internal API key
  if (apiKey !== validApiKey && apiKey !== `Bearer ${validApiKey}` && apiKey !== internalApiKey) {
    logger.warn('Invalid API key provided');
    return res.status(403).json({
      success: false,
      error: 'Invalid API key',
    });
  }

  logger.info('Auth successful, calling next()');
  return next();
}
