import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

class EnhancedLogger {
  constructor() {
    this.logDir = process.env.LOG_DIR || 'logs';
    this.ensureLogDirectory();

    // Create custom log levels
    this.levels = {
      critical: 0,
      error: 1,
      warn: 2,
      info: 3,
      http: 4,
      debug: 5,
      trace: 6,
    };

    this.colors = {
      critical: 'red bold',
      error: 'red',
      warn: 'yellow',
      info: 'green',
      http: 'magenta',
      debug: 'cyan',
      trace: 'gray',
    };

    winston.addColors(this.colors);

    this.logger = this.createLogger();
    this.setupMetrics();
  }

  ensureLogDirectory() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  createLogger() {
    // Custom format for structured logs
    const structuredFormat = winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      winston.format.errors({ stack: true }),
      winston.format.metadata({ fillExcept: ['message', 'level', 'timestamp', 'label'] }),
      winston.format.json(),
    );

    // Console format for development
    const consoleFormat = winston.format.combine(
      winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message, metadata, stack }) => {
        let log = `${timestamp} [${level}]: ${message}`;

        if (metadata && Object.keys(metadata).length > 0) {
          log += ` ${JSON.stringify(metadata)}`;
        }

        if (stack) {
          log += `\n${stack}`;
        }

        return log;
      }),
    );

    // Create transports
    const transports = [];

    // Console transport
    transports.push(
      new winston.transports.Console({
        format: consoleFormat,
        level: process.env.LOG_LEVEL || 'debug',
      }),
    );

    // File transports with rotation
    if (process.env.NODE_ENV === 'production' || process.env.ENABLE_FILE_LOGS === 'true') {
      // Error logs
      transports.push(
        new DailyRotateFile({
          filename: path.join(this.logDir, 'error-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          level: 'error',
          maxSize: '20m',
          maxFiles: '14d',
          format: structuredFormat,
        }),
      );

      // Combined logs
      transports.push(
        new DailyRotateFile({
          filename: path.join(this.logDir, 'combined-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '50m',
          maxFiles: '7d',
          format: structuredFormat,
        }),
      );

      // Security logs
      transports.push(
        new DailyRotateFile({
          filename: path.join(this.logDir, 'security-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          level: 'warn',
          maxSize: '10m',
          maxFiles: '30d',
          format: structuredFormat,
          filter: (info) => info.metadata?.category === 'security',
        }),
      );

      // Performance logs
      transports.push(
        new DailyRotateFile({
          filename: path.join(this.logDir, 'performance-%DATE%.log'),
          datePattern: 'YYYY-MM-DD',
          maxSize: '20m',
          maxFiles: '7d',
          format: structuredFormat,
          filter: (info) => info.metadata?.category === 'performance',
        }),
      );
    }

    return winston.createLogger({
      levels: this.levels,
      level: process.env.LOG_LEVEL || 'info',
      defaultMeta: {
        service: 'plubot-whatsapp',
        environment: process.env.NODE_ENV || 'development',
        hostname: os.hostname(),
      },
      transports,
      exitOnError: false,
    });
  }

  setupMetrics() {
    this.metrics = {
      logs: {
        critical: 0,
        error: 0,
        warn: 0,
        info: 0,
        http: 0,
        debug: 0,
        trace: 0,
      },
      performance: {
        slowQueries: [],
        apiLatency: [],
      },
    };

    // Hook into log events to collect metrics
    this.logger.on('data', (info) => {
      if (this.metrics.logs[info.level]) {
        this.metrics.logs[info.level]++;
      }
    });
  }

  // Enhanced logging methods
  critical(message, meta = {}) {
    this.logger.log('critical', message, meta);
    this.alertIfNeeded('critical', message, meta);
  }

  error(message, error = null, meta = {}) {
    const metadata = { ...meta };

    if (error instanceof Error) {
      metadata.errorName = error.name;
      metadata.errorMessage = error.message;
      metadata.stack = error.stack;
    }

    this.logger.error(message, metadata);
    this.alertIfNeeded('error', message, metadata);
  }

  warn(message, meta = {}) {
    this.logger.warn(message, meta);
  }

  info(message, meta = {}) {
    this.logger.info(message, meta);
  }

  http(message, meta = {}) {
    this.logger.http(message, meta);
  }

  debug(message, meta = {}) {
    this.logger.debug(message, meta);
  }

  trace(message, meta = {}) {
    this.logger.log('trace', message, meta);
  }

  // Security logging
  security(event, meta = {}) {
    this.logger.warn(`Security Event: ${event}`, {
      ...meta,
      category: 'security',
      timestamp: new Date().toISOString(),
    });
  }

  // Performance logging
  performance(operation, duration, meta = {}) {
    const metadata = {
      ...meta,
      category: 'performance',
      operation,
      duration,
      timestamp: new Date().toISOString(),
    };

    // Log slow operations
    if (duration > (meta.threshold || 1000)) {
      this.logger.warn(`Slow operation: ${operation} took ${duration}ms`, metadata);
      this.metrics.performance.slowQueries.push({ operation, duration, timestamp: Date.now() });
    } else {
      this.logger.debug(`Performance: ${operation} completed in ${duration}ms`, metadata);
    }

    this.metrics.performance.apiLatency.push(duration);
  }

  // Audit logging
  audit(action, userId, meta = {}) {
    this.logger.info(`Audit: ${action}`, {
      ...meta,
      category: 'audit',
      userId,
      action,
      timestamp: new Date().toISOString(),
      ip: meta.ip || 'unknown',
    });
  }

  // Request logging middleware
  requestLogger() {
    return (req, res, next) => {
      const start = Date.now();

      // Log request
      this.http(`${req.method} ${req.originalUrl}`, {
        method: req.method,
        url: req.originalUrl,
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });

      // Log response
      const originalSend = res.send;
      res.send = (data) => {
        const duration = Date.now() - start;

        this.http(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`, {
          method: req.method,
          url: req.originalUrl,
          statusCode: res.statusCode,
          duration,
          ip: req.ip,
        });

        // Track performance
        if (duration > 1000) {
          this.performance(`${req.method} ${req.originalUrl}`, duration, {
            statusCode: res.statusCode,
          });
        }

        originalSend.call(res, data);
      };

      next();
    };
  }

  // WebSocket logging
  websocketLogger(io) {
    io.on('connection', (socket) => {
      this.debug('WebSocket connection established', {
        socketId: socket.id,
        ip: socket.handshake.address,
      });

      socket.on('disconnect', (reason) => {
        this.debug('WebSocket disconnected', {
          socketId: socket.id,
          reason,
        });
      });

      socket.on('error', (error) => {
        this.error('WebSocket error', error, {
          socketId: socket.id,
        });
      });
    });
  }

  // Alert mechanism for critical logs
  alertIfNeeded(level, message, meta) {
    if (level === 'critical' || (level === 'error' && meta.alert)) {
      // Here you would integrate with alerting services
      // For now, just log to console with emphasis
      console.error('🚨 ALERT 🚨', { level, message, meta });

      // Could integrate with:
      // - Slack/Discord webhooks
      // - PagerDuty
      // - Email alerts
      // - SMS alerts
    }
  }

  // Get metrics
  getMetrics() {
    const avgLatency =
      this.metrics.performance.apiLatency.length > 0
        ? this.metrics.performance.apiLatency.reduce((a, b) => a + b, 0) /
          this.metrics.performance.apiLatency.length
        : 0;

    return {
      logs: this.metrics.logs,
      performance: {
        averageLatency: Math.round(avgLatency),
        slowQueries: this.metrics.performance.slowQueries.length,
        totalRequests: this.metrics.performance.apiLatency.length,
      },
    };
  }

  // Clear old metrics
  clearMetrics() {
    // Keep only last hour of performance data
    const oneHourAgo = Date.now() - 3_600_000;

    this.metrics.performance.slowQueries = this.metrics.performance.slowQueries.filter(
      (q) => q.timestamp > oneHourAgo,
    );

    // Keep only last 1000 latency measurements
    if (this.metrics.performance.apiLatency.length > 1000) {
      this.metrics.performance.apiLatency = this.metrics.performance.apiLatency.slice(-1000);
    }
  }

  // Graceful shutdown
  async close() {
    return new Promise((resolve) => {
      this.logger.info('Logger shutting down...');
      this.logger.end(() => resolve());
    });
  }
}

// Export singleton instance
export default new EnhancedLogger();
