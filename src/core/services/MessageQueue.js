import Bull from 'bull';
import logger from '../utils/logger.js';

class MessageQueueService {
  constructor() {
    this.queues = new Map();
    this.workers = new Map();
    this.metrics = {
      processed: 0,
      failed: 0,
      delayed: 0,
      active: 0,
      waiting: 0
    };
    
    this.redisConfig = {
      redis: {
        host: process.env.REDIS_HOST || 'redis',
        port: parseInt(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB) || 1,
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        }
      }
    };

    this.initializeQueues();
  }

  initializeQueues() {
    // Cola de alta prioridad para mensajes urgentes
    this.createQueue('high-priority', {
      defaultJobOptions: {
        priority: 1,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 2000
        },
        removeOnComplete: 100,
        removeOnFail: 500
      }
    });

    // Cola normal para mensajes regulares
    this.createQueue('normal', {
      defaultJobOptions: {
        priority: 2,
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000
        },
        removeOnComplete: 50,
        removeOnFail: 200
      }
    });

    // Cola de baja prioridad para mensajes masivos
    this.createQueue('bulk', {
      defaultJobOptions: {
        priority: 3,
        attempts: 2,
        backoff: {
          type: 'fixed',
          delay: 10000
        },
        removeOnComplete: 20,
        removeOnFail: 100
      },
      limiter: {
        max: 10,
        duration: 1000 // 10 mensajes por segundo máximo
      }
    });

    // Cola para reintentos y mensajes fallidos
    this.createQueue('retry', {
      defaultJobOptions: {
        attempts: 10,
        backoff: {
          type: 'exponential',
          delay: 30000 // 30 segundos inicial
        },
        removeOnComplete: 10,
        removeOnFail: false // Mantener para análisis
      }
    });

    // Dead Letter Queue para mensajes que fallan permanentemente
    this.createQueue('dead-letter', {
      defaultJobOptions: {
        removeOnComplete: false,
        removeOnFail: false
      }
    });

    this.setupQueueEventHandlers();
    this.startMetricsCollection();
  }

  createQueue(name, options = {}) {
    const queue = new Bull(`whatsapp-${name}`, this.redisConfig);
    
    queue.concurrency = options.concurrency || 5;
    
    if (options.defaultJobOptions) {
      queue.defaultJobOptions = options.defaultJobOptions;
    }

    if (options.limiter) {
      queue.limiter = options.limiter;
    }

    this.queues.set(name, queue);
    
    logger.info(`📬 Queue '${name}' initialized`, {
      concurrency: queue.concurrency,
      options
    });

    return queue;
  }

  async addMessage(queueName, data, options = {}) {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue '${queueName}' not found`);
    }

    // Validar datos del mensaje
    if (!data.to || !data.content) {
      throw new Error('Message must have "to" and "content" fields');
    }

    // Añadir metadata
    const jobData = {
      ...data,
      timestamp: Date.now(),
      queueName,
      retryCount: 0,
      id: data.id || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };

    // Opciones del job
    const jobOptions = {
      ...options,
      jobId: jobData.id,
      timestamp: Date.now()
    };

    // Si es un mensaje programado
    if (options.delay) {
      jobOptions.delay = options.delay;
      this.metrics.delayed++;
    }

    try {
      const job = await queue.add(jobData, jobOptions);
      
      logger.info(`📨 Message queued`, {
        queue: queueName,
        jobId: job.id,
        to: data.to,
        priority: jobOptions.priority
      });

      this.metrics.waiting++;
      
      return {
        jobId: job.id,
        queue: queueName,
        status: 'queued'
      };
    } catch (error) {
      logger.error('Failed to queue message:', error);
      throw error;
    }
  }

  async processQueue(queueName, processor) {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue '${queueName}' not found`);
    }

    const wrappedProcessor = async (job) => {
      this.metrics.active++;
      this.metrics.waiting--;
      
      try {
        // Usar circuit breaker si está disponible
        if (circuitBreakers && circuitBreakers.whatsapp) {
          return await circuitBreakers.whatsapp.fire(async () => {
            return await processor(job);
          });
        }
        
        return await processor(job);
      } catch (error) {
        // Si el mensaje falla múltiples veces, moverlo a retry queue
        if (job.attemptsMade >= job.opts.attempts - 1) {
          await this.moveToRetryQueue(job);
        }
        throw error;
      } finally {
        this.metrics.active--;
      }
    };

    queue.process(queue.concurrency, wrappedProcessor);
    this.workers.set(queueName, wrappedProcessor);
    
    logger.info(`🔄 Processing queue '${queueName}' with concurrency ${queue.concurrency}`);
  }

  async moveToRetryQueue(job) {
    try {
      await this.addMessage('retry', {
        ...job.data,
        originalQueue: job.queue.name,
        failedAttempts: job.attemptsMade,
        lastError: job.failedReason
      });
      
      logger.warn(`🔁 Message moved to retry queue`, {
        jobId: job.id,
        attempts: job.attemptsMade
      });
    } catch (error) {
      // Si falla el retry, mover a dead letter
      await this.moveToDeadLetter(job);
    }
  }

  async moveToDeadLetter(job) {
    try {
      await this.addMessage('dead-letter', {
        ...job.data,
        originalQueue: job.queue.name,
        failedAttempts: job.attemptsMade,
        lastError: job.failedReason,
        movedAt: new Date().toISOString()
      });
      
      logger.error(`💀 Message moved to dead letter queue`, {
        jobId: job.id,
        reason: job.failedReason
      });
    } catch (error) {
      logger.error('Failed to move message to dead letter:', error);
    }
  }

  setupQueueEventHandlers() {
    this.queues.forEach((queue, name) => {
      // Evento: Job completado
      queue.on('completed', (job, result) => {
        this.metrics.processed++;
        
        logger.info(`✅ Job completed`, {
          queue: name,
          jobId: job.id,
          duration: Date.now() - job.timestamp
        });
      });

      // Evento: Job fallido
      queue.on('failed', (job, err) => {
        this.metrics.failed++;
        
        logger.error(`❌ Job failed`, {
          queue: name,
          jobId: job.id,
          error: err.message,
          attempts: job.attemptsMade
        });
      });

      // Evento: Job estancado
      queue.on('stalled', (job) => {
        logger.warn(`⚠️ Job stalled`, {
          queue: name,
          jobId: job.id
        });
      });

      // Evento: Error en la cola
      queue.on('error', (error) => {
        logger.error(`🚨 Queue error`, {
          queue: name,
          error: error.message
        });
      });

      // Evento: Job activo
      queue.on('active', (job) => {
        logger.debug(`🏃 Job active`, {
          queue: name,
          jobId: job.id
        });
      });

      // Evento: Job en progreso
      queue.on('progress', (job, progress) => {
        logger.debug(`📊 Job progress`, {
          queue: name,
          jobId: job.id,
          progress
        });
      });
    });
  }

  async getQueueStatus(queueName) {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      return null;
    }

    const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
      queue.getPausedCount()
    ]);

    return {
      name: queueName,
      counts: {
        waiting,
        active,
        completed,
        failed,
        delayed,
        paused
      },
      isPaused: await queue.isPaused()
    };
  }

  async getAllQueuesStatus() {
    const statuses = {};
    
    for (const [name] of this.queues) {
      statuses[name] = await this.getQueueStatus(name);
    }
    
    return statuses;
  }

  async pauseQueue(queueName) {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue '${queueName}' not found`);
    }

    await queue.pause();
    logger.info(`⏸️ Queue '${queueName}' paused`);
  }

  async resumeQueue(queueName) {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue '${queueName}' not found`);
    }

    await queue.resume();
    logger.info(`▶️ Queue '${queueName}' resumed`);
  }

  async cleanQueue(queueName, grace = 5000, status = 'completed', limit = 100) {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue '${queueName}' not found`);
    }

    const removed = await queue.clean(grace, status, limit);
    
    logger.info(`🧹 Queue cleaned`, {
      queue: queueName,
      removed,
      status
    });
    
    return removed;
  }

  async drainQueue(queueName) {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue '${queueName}' not found`);
    }

    await queue.empty();
    logger.warn(`🚮 Queue '${queueName}' drained`);
  }

  startMetricsCollection() {
    setInterval(async () => {
      const allStatus = await this.getAllQueuesStatus();
      
      logger.info('📊 Queue Metrics', {
        global: this.metrics,
        queues: allStatus
      });
    }, 60000); // Cada minuto
  }

  async shutdown() {
    logger.info('🛑 Shutting down message queues...');
    
    // Pausar todas las colas
    for (const [name, queue] of this.queues) {
      await queue.pause();
      logger.info(`⏸️ Queue '${name}' paused for shutdown`);
    }

    // Esperar a que los jobs activos terminen
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Cerrar todas las colas
    for (const [name, queue] of this.queues) {
      await queue.close();
      logger.info(`🔒 Queue '${name}' closed`);
    }

    logger.info('✅ Message queues shutdown complete');
  }

  // Método para procesar mensajes en batch
  async processBatch(queueName, batchSize = 10) {
    const queue = this.queues.get(queueName);
    
    if (!queue) {
      throw new Error(`Queue '${queueName}' not found`);
    }

    const jobs = await queue.getWaiting(0, batchSize);
    const results = [];

    for (const job of jobs) {
      try {
        const result = await job.moveToCompleted('batch-processed', true);
        results.push({ jobId: job.id, success: true, result });
      } catch (error) {
        await job.moveToFailed({ message: error.message }, true);
        results.push({ jobId: job.id, success: false, error: error.message });
      }
    }

    logger.info(`📦 Batch processed`, {
      queue: queueName,
      size: batchSize,
      processed: results.length,
      successful: results.filter(r => r.success).length
    });

    return results;
  }

  getMetrics() {
    return {
      ...this.metrics,
      timestamp: Date.now()
    };
  }
}

// Singleton
let messageQueueInstance = null;

export function getMessageQueue() {
  if (!messageQueueInstance) {
    messageQueueInstance = new MessageQueueService();
  }
  return messageQueueInstance;
}

export default MessageQueueService;
