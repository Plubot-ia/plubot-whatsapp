import logger from '../utils/logger.js';

/**
 * Express error handler middleware
 * @param {Error} err - Error object
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  logger.error('Error handler middleware:', err);

  // Check if response was already sent
  if (res.headersSent) {
    return next(err);
  }

  let status;
  let message;

  if (err.isOperational) {
    ({ statusCode: status } = err);
    ({ message } = err);
  } else {
    // Programming or unknown errors: log and send generic message
    logger.error('ERROR ', err);
    status = 500;
    message = process.env.NODE_ENV === 'production' ? 'Something went wrong!' : err.message;
  }

  if (process.env.NODE_ENV === 'development') {
    logger.error('Error details:', {
      message,
      stack: err.stack,
      status,
    });
  }

  return res.status(status).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Something went wrong!' : err.message,
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
    ...(process.env.NODE_ENV === 'development' && err.details ? { details: err.details } : {}),
  });
}
