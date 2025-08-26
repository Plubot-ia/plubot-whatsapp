import Redis from 'ioredis';

import logger from './logger.js';

/**
 *
 */
class RedisClient {
  /**
   *
   */
  constructor() {
    this.client = null;
  }

  /**
   *
   */
  async connect() {
    try {
      const redisHost = process.env.REDIS_HOST || 'localhost';
      const redisPort = process.env.REDIS_PORT || 6379;
      const redisPassword = process.env.REDIS_PASSWORD || undefined;

      this.client = new Redis({
        host: redisHost,
        port: redisPort,
        password: redisPassword,
        retryStrategy: (times) => {
          if (times > 10) {
            logger.error('Max Redis reconnection attempts reached');
            return null;
          }
          return Math.min(times * 100, 3000);
        },
      });

      this.client.on('error', (err) => {
        logger.error('Redis Client Error:', err);
      });

      this.client.on('connect', () => {
        logger.info('Redis Client Connected');
      });

      return this.client;
    } catch (error) {
      logger.error('Failed to connect to Redis:', error);
      throw error;
    }
  }

  /**
   * Get a value from the cache.
   * @param {string} key - The cache key
   * @returns {Promise<string|null>} The cached value or null
   */
  async get(key) {
    try {
      return await this.client.get(key);
    } catch (error) {
      logger.error(`Redis GET error for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Set a value in the cache.
   * @param {string} key - The cache key
   * @param {any} value - The value to cache
   * @param {Object} options - Optional settings
   * @param {number} options.ttl - Time to live in seconds
   * @returns {Promise<string>} 'OK' if successful
   */
  async set(key, value, options = {}) {
    try {
      if (options.ttl) {
        return await this.client.set(key, value, 'EX', options.ttl);
      }
      return await this.client.set(key, value);
    } catch (error) {
      logger.error(`Redis SET error for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Set a value with expiration.
   * @param {string} key - The cache key
   * @param {number} seconds - Time to live in seconds
   * @param {any} value - The value to cache
   * @returns {Promise<string>} 'OK' if successful
   */
  async setex(key, seconds, value) {
    try {
      return await this.client.setex(key, seconds, value);
    } catch (error) {
      logger.error(`Redis SETEX error for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Get all keys matching a pattern.
   * @param {string} pattern - The pattern to match
   * @returns {Promise<string[]>} Array of matching keys
   */
  async keys(pattern) {
    try {
      return await this.client.keys(pattern);
    } catch (error) {
      logger.error(`Redis KEYS error for pattern ${pattern}:`, error);
      throw error;
    }
  }

  /**
   * Add a value to a list.
   * @param {string} key - The list key
   * @param {any} value - The value to add
   * @returns {Promise<number>} The new list length
   */
  async lpush(key, value) {
    try {
      return await this.client.lpush(key, value);
    } catch (error) {
      logger.error(`Redis LPUSH error for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Get a range from a list.
   * @param {string} key - The list key
   * @param {number} start - Start index
   * @param {number} stop - Stop index
   * @returns {Promise<string[]>} Array of values
   */
  async ltrim(key, start, stop) {
    try {
      return await this.client.ltrim(key, start, stop);
    } catch (error) {
      logger.error(`Redis LTRIM error for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Delete a key from the cache.
   * @param {string} key - The cache key
   * @returns {Promise<number>} Number of keys deleted
   */
  async del(key) {
    try {
      return await this.client.del(key);
    } catch (error) {
      logger.error(`Redis DEL error for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Disconnect from Redis.
   * @returns {Promise<void>} Promise that resolves when disconnected
   */
  async disconnect() {
    if (this.client) {
      await this.client.quit();
      logger.info('Redis Client Disconnected');
    }
  }
}

export default RedisClient;
