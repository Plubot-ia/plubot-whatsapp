import Bull from 'bull';
import IORedis from 'ioredis';
import logger from '../utils/logger.js';

/**
 * Enterprise Message Queue System
 * Handles all WhatsApp messages with retry logic, dead letter queues, and monitoring
 */
export class MessageQueueSystem {
  constructor(config = {}) {
    this.config = {
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD,
        db: process.env.REDIS_QUEUE_DB || 2,
      },
      queues: {
        incoming: 'whatsapp:incoming',
        outgoing: 'whatsapp:outgoing',
        media: 'whatsapp:media',
        status: 'whatsapp:status',
        priority: 'whatsapp:priority',
        dlq: 'whatsapp:dlq', // Dead Letter Queue
      },
      ...config,
    };
    
    this.queues = {};
    this.processors = new Map();
    this.metrics = {
      processed: 0,
      failed: 0,
      retried: 0,
      dlq: 0,
    };
    
    this._initializeQueues();
  }
  
  /**
   * Initialize all message queues
   */
  _initializeQueues() {
    const redisOpts = {
      redis: this.config.redis,
    };
    
    // Create queues
    Object.entries(this.config.queues).forEach(([name, queueName]) => {
      this.queues[name] = new Bull(queueName, redisOpts);
      
      // Set up event listeners
      this.queues[name].on('completed', (job) => {
        this.metrics.processed++;
        logger.debug(`Job ${job.id} completed in queue ${name}`);
      });
      
      this.queues[name].on('failed', (job, error) => {
        this.metrics.failed++;
        logger.error(`Job ${job.id} failed in queue ${name}:`, error);
        
        // Move to DLQ after max retries
        if (job.attemptsMade >= (job.opts.attempts || 3)) {
          this._moveToDeadLetterQueue(job, error);
        }
      });
      
      this.queues[name].on('stalled', (job) => {
        logger.warn(`Job ${job.id} stalled in queue ${name}`);
      });
    });
    
    // Set up queue processors
    this._setupProcessors();
  }
  
  /**
   * Set up message processors
   */
  _setupProcessors() {
    // Incoming message processor
    this.queues.incoming.process(50, async (job) => {
      const { sessionId, message, timestamp } = job.data;
      
      try {
        // Add processing logic here
        const processor = this.processors.get('incoming');
        if (processor) {
          await processor(job.data);
        }
        
        // Track metrics
        await this._updateMetrics('incoming', {
          sessionId,
          timestamp,
          processingTime: Date.now() - timestamp,
        });
        
        return { success: true, processedAt: Date.now() };
        
      } catch (error) {
        logger.error(`Failed to process incoming message:`, error);
        throw error;
      }
    });
    
    // Outgoing message processor with rate limiting
    this.queues.outgoing.process(30, async (job) => {
      const { sessionId, recipient, message, options = {} } = job.data;
      
      try {
        // Apply rate limiting
        await this._checkRateLimit(sessionId, recipient);
        
        const processor = this.processors.get('outgoing');
        if (processor) {
          const result = await processor(job.data);
          
          // Update delivery status
          await this.queues.status.add({
            messageId: result.messageId,
            status: 'sent',
            timestamp: Date.now(),
          });
          
          return result;
        }
        
      } catch (error) {
        if (error.code === 'RATE_LIMIT') {
          // Retry with backoff
          throw new Error('Rate limit exceeded');
        }
        throw error;
      }
    });
    
    // Media processor with optimized handling
    this.queues.media.process(10, async (job) => {
      const { sessionId, media, recipient } = job.data;
      
      try {
        // Process media with size limits and optimization
        if (media.size > 16 * 1024 * 1024) { // 16MB limit
          throw new Error('Media file too large');
        }
        
        const processor = this.processors.get('media');
        if (processor) {
          return await processor(job.data);
        }
        
      } catch (error) {
        logger.error(`Failed to process media:`, error);
        throw error;
      }
    });
    
    // Priority queue for important messages
    this.queues.priority.process(100, async (job) => {
      const processor = this.processors.get('priority');
      if (processor) {
        return await processor(job.data);
      }
    });
  }
  
  /**
   * Add message to queue
   */
  async addMessage(queue, data, options = {}) {
    const defaultOptions = {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
    };
    
    const job = await this.queues[queue].add(data, {
      ...defaultOptions,
      ...options,
    });
    
    logger.debug(`Added job ${job.id} to queue ${queue}`);
    return job;
  }
  
  /**
   * Add bulk messages
   */
  async addBulkMessages(queue, messages, options = {}) {
    const jobs = messages.map(data => ({
      data,
      opts: options,
    }));
    
    const results = await this.queues[queue].addBulk(jobs);
    logger.info(`Added ${results.length} jobs to queue ${queue}`);
    return results;
  }
  
  /**
   * Register message processor
   */
  registerProcessor(type, processor) {
    this.processors.set(type, processor);
    logger.info(`Registered processor for ${type}`);
  }
  
  /**
   * Check rate limits
   */
  async _checkRateLimit(sessionId, recipient) {
    const key = `ratelimit:${sessionId}:${recipient}`;
    const redis = new IORedis(this.config.redis);
    
    try {
      const count = await redis.incr(key);
      
      if (count === 1) {
        await redis.expire(key, 60); // 1 minute window
      }
      
      const limit = 30; // 30 messages per minute per recipient
      if (count > limit) {
        throw { code: 'RATE_LIMIT', message: 'Rate limit exceeded' };
      }
      
    } finally {
      redis.disconnect();
    }
  }
  
  /**
   * Move failed job to Dead Letter Queue
   */
  async _moveToDeadLetterQueue(job, error) {
    await this.queues.dlq.add({
      originalQueue: job.queue.name,
      jobId: job.id,
      data: job.data,
      error: error.message,
      failedAt: Date.now(),
      attempts: job.attemptsMade,
    });
    
    this.metrics.dlq++;
    logger.warn(`Moved job ${job.id} to DLQ`);
  }
  
  /**
   * Update queue metrics
   */
  async _updateMetrics(queue, data) {
    const redis = new IORedis(this.config.redis);
    
    try {
      const key = `metrics:${queue}:${new Date().toISOString().split('T')[0]}`;
      await redis.hincrby(key, 'count', 1);
      await redis.hincrbyfloat(key, 'totalProcessingTime', data.processingTime || 0);
      await redis.expire(key, 7 * 24 * 3600); // Keep for 7 days
    } finally {
      redis.disconnect();
    }
  }
  
  /**
   * Get queue statistics
   */
  async getQueueStats() {
    const stats = {};
    
    for (const [name, queue] of Object.entries(this.queues)) {
      const counts = await queue.getJobCounts();
      stats[name] = {
        ...counts,
        completed: await queue.getCompletedCount(),
        failed: await queue.getFailedCount(),
      };
    }
    
    return {
      queues: stats,
      metrics: this.metrics,
    };
  }
  
  /**
   * Clean old jobs
   */
  async cleanQueues(grace = 3600000) {
    const cleaned = {};
    
    for (const [name, queue] of Object.entries(this.queues)) {
      const completedJobs = await queue.clean(grace, 'completed');
      const failedJobs = await queue.clean(grace, 'failed');
      
      cleaned[name] = {
        completed: completedJobs.length,
        failed: failedJobs.length,
      };
    }
    
    logger.info('Cleaned old jobs:', cleaned);
    return cleaned;
  }
  
  /**
   * Get queue statistics
   */
  async getStats() {
    const stats = {
      queues: {},
      metrics: this.metrics,
    };
    
    for (const [name, queue] of Object.entries(this.queues)) {
      const counts = await queue.getJobCounts();
      stats.queues[name] = counts;
    }
    
    return stats;
  }
  
  /**
   * Pause queue processing
   */
  async pauseQueue(queueName) {
    if (this.queues[queueName]) {
      await this.queues[queueName].pause();
      logger.info(`Queue ${queueName} paused`);
    }
  }
  
  /**
   * Resume queue processing
   */
  async resumeQueue(queueName) {
    if (this.queues[queueName]) {
      await this.queues[queueName].resume();
      logger.info(`Queue ${queueName} resumed`);
    }
  }
  
  /**
   * Shutdown all queues
   */
  async shutdown() {
    logger.info('Shutting down MessageQueueSystem...');
    
    const closePromises = Object.values(this.queues).map(queue => queue.close());
    await Promise.all(closePromises);
    
    logger.info('MessageQueueSystem shutdown complete');
  }
}

export default MessageQueueSystem;
