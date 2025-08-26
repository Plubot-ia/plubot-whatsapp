import { createClient } from 'redis';
import logger from '../utils/logger.js';

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        logger.error('Redis: Max reconnection attempts reached');
        return new Error('Max reconnection attempts reached');
      }
      const delay = Math.min(retries * 100, 3000);
      logger.info(`Redis: Reconnecting in ${delay}ms (attempt ${retries})`);
      return delay;
    },
  },
});

redisClient.on('error', (err) => {
  logger.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
  logger.info('Redis: Connected successfully');
});

redisClient.on('ready', () => {
  logger.info('Redis: Ready to accept commands');
});

redisClient.on('reconnecting', () => {
  logger.warn('Redis: Reconnecting...');
});

// Connect to Redis
await redisClient.connect();

// Add helper methods for the repository pattern
redisClient.keys = redisClient.keys.bind(redisClient);
redisClient.get = redisClient.get.bind(redisClient);
redisClient.set = redisClient.set.bind(redisClient);
redisClient.del = redisClient.del.bind(redisClient);
redisClient.expire = redisClient.expire.bind(redisClient);
redisClient.setEx = redisClient.setEx.bind(redisClient);

export default redisClient;
