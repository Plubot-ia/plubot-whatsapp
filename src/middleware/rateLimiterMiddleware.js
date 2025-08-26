import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';

import redisClient from '../config/redis.js';

/**
 * Rate limiter middleware for Express
 */
const rateLimiter = rateLimit({
  store: new RedisStore({
    client: redisClient,
    prefix: 'ratelimit:',
    sendCommand: (...arguments_) => redisClient.sendCommand(arguments_),
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

export default rateLimiter;
