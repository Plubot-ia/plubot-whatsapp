/**
 * Metrics Routes
 * Prometheus metrics endpoint
 */

import { Router } from 'express';
import { register } from 'prom-client';

import logger from '../utils/logger.js';

const router = Router();

/**
 * GET /metrics
 * Prometheus metrics endpoint
 */
router.get('/', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    const metrics = await register.metrics();
    res.end(metrics);
  } catch (error) {
    logger.error('Error generating metrics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate metrics',
    });
  }
});

export default router;
