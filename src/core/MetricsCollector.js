import os from 'node:os';

import { Registry, Counter, Gauge, Histogram, Summary } from 'prom-client';

import logger from '../utils/logger.js';

/**
 * Enterprise Metrics Collector
 * Collects and exposes metrics for monitoring
 */
export class MetricsCollector {
  constructor(config = {}) {
    this.config = {
      prefix: config.prefix || 'plubot_whatsapp',
      collectDefaultMetrics: config.collectDefaultMetrics !== false,
      defaultLabels: config.defaultLabels || {},
      ...config,
    };

    // Create registry
    this.registry = new Registry();

    // Set default labels
    this.registry.setDefaultLabels({
      ...this.config.defaultLabels,
      hostname: os.hostname(),
      pid: process.pid,
    });

    // Initialize metrics
    this._initializeMetrics();
  }

  /**
   * Start collecting metrics
   */
  async startCollection() {
    if (this.config.collectDefaultMetrics) {
      const promClient = await import('prom-client');
      promClient.collectDefaultMetrics({ register: this.registry });
    }
  }

  /**
   * Initialize custom metrics
   */
  _initializeMetrics() {
    // Session metrics
    this.sessionsTotal = new Counter({
      name: `${this.config.prefix}_sessions_total`,
      help: 'Total number of WhatsApp sessions created',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.sessionsActive = new Gauge({
      name: `${this.config.prefix}_sessions_active`,
      help: 'Number of active WhatsApp sessions',
      registers: [this.registry],
    });

    this.sessionDuration = new Histogram({
      name: `${this.config.prefix}_session_duration_seconds`,
      help: 'Duration of WhatsApp sessions',
      buckets: [60, 300, 900, 1800, 3600, 7200, 14_400],
      registers: [this.registry],
    });

    // Message metrics
    this.messagesTotal = new Counter({
      name: `${this.config.prefix}_messages_total`,
      help: 'Total number of messages processed',
      labelNames: ['type', 'status'],
      registers: [this.registry],
    });

    this.messageProcessingDuration = new Histogram({
      name: `${this.config.prefix}_message_processing_duration_milliseconds`,
      help: 'Message processing duration',
      labelNames: ['type'],
      buckets: [10, 50, 100, 500, 1000, 5000, 10_000],
      registers: [this.registry],
    });

    this.messageQueueSize = new Gauge({
      name: `${this.config.prefix}_message_queue_size`,
      help: 'Current message queue size',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    // Connection metrics
    this.connectionAttempts = new Counter({
      name: `${this.config.prefix}_connection_attempts_total`,
      help: 'Total connection attempts',
      labelNames: ['result'],
      registers: [this.registry],
    });

    this.reconnectionAttempts = new Counter({
      name: `${this.config.prefix}_reconnection_attempts_total`,
      help: 'Total reconnection attempts',
      labelNames: ['result'],
      registers: [this.registry],
    });

    this.connectionLatency = new Histogram({
      name: `${this.config.prefix}_connection_latency_milliseconds`,
      help: 'Connection establishment latency',
      buckets: [100, 500, 1000, 2000, 5000, 10_000, 30_000],
      registers: [this.registry],
    });

    // QR Code metrics
    this.qrCodesGenerated = new Counter({
      name: `${this.config.prefix}_qr_codes_generated_total`,
      help: 'Total QR codes generated',
      registers: [this.registry],
    });

    this.qrScanDuration = new Histogram({
      name: `${this.config.prefix}_qr_scan_duration_seconds`,
      help: 'Time taken to scan QR code',
      buckets: [5, 10, 30, 60, 120, 300],
      registers: [this.registry],
    });

    // Error metrics
    this.errorsTotal = new Counter({
      name: `${this.config.prefix}_errors_total`,
      help: 'Total number of errors',
      labelNames: ['type', 'severity'],
      registers: [this.registry],
    });

    // Performance metrics
    this.cpuUsage = new Gauge({
      name: `${this.config.prefix}_cpu_usage_percent`,
      help: 'CPU usage percentage',
      labelNames: ['core'],
      registers: [this.registry],
    });

    this.memoryUsage = new Gauge({
      name: `${this.config.prefix}_memory_usage_bytes`,
      help: 'Memory usage in bytes',
      labelNames: ['type'],
      registers: [this.registry],
    });

    // Rate limiting metrics
    this.rateLimitHits = new Counter({
      name: `${this.config.prefix}_rate_limit_hits_total`,
      help: 'Number of rate limit hits',
      labelNames: ['endpoint', 'user'],
      registers: [this.registry],
    });

    // Circuit breaker metrics
    this.circuitBreakerState = new Gauge({
      name: `${this.config.prefix}_circuit_breaker_state`,
      help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
      labelNames: ['service'],
      registers: [this.registry],
    });

    this.circuitBreakerTrips = new Counter({
      name: `${this.config.prefix}_circuit_breaker_trips_total`,
      help: 'Number of circuit breaker trips',
      labelNames: ['service'],
      registers: [this.registry],
    });

    // Worker metrics (for clustering)
    this.workerCount = new Gauge({
      name: `${this.config.prefix}_worker_count`,
      help: 'Number of worker processes',
      registers: [this.registry],
    });

    this.workerRestarts = new Counter({
      name: `${this.config.prefix}_worker_restarts_total`,
      help: 'Number of worker restarts',
      registers: [this.registry],
    });

    // Custom business metrics
    this.apiResponseTime = new Summary({
      name: `${this.config.prefix}_api_response_time_milliseconds`,
      help: 'API response time summary',
      labelNames: ['method', 'endpoint', 'status'],
      percentiles: [0.5, 0.9, 0.95, 0.99],
      registers: [this.registry],
    });
  }

  /**
   * Record session created
   */
  recordSessionCreated(status = 'success') {
    this.sessionsTotal.inc({ status });
    if (status === 'success') {
      this.sessionsActive.inc();
    }
  }

  /**
   * Record session destroyed
   */
  recordSessionDestroyed() {
    this.sessionsActive.dec();
  }

  /**
   * Record session duration
   */
  recordSessionDuration(durationSeconds) {
    this.sessionDuration.observe(durationSeconds);
  }

  /**
   * Record message
   */
  recordMessage(type, status = 'success') {
    this.messagesTotal.inc({ type, status });
  }

  /**
   * Record message processing time
   */
  recordMessageProcessingTime(type, durationMs) {
    this.messageProcessingDuration.observe({ type }, durationMs);
  }

  /**
   * Update queue size
   */
  updateQueueSize(queue, size) {
    this.messageQueueSize.set({ queue }, size);
  }

  /**
   * Record connection attempt
   */
  recordConnectionAttempt(result) {
    this.connectionAttempts.inc({ result });
  }

  /**
   * Record reconnection attempt
   */
  recordReconnectionAttempt(result) {
    this.reconnectionAttempts.inc({ result });
  }

  /**
   * Record connection latency
   */
  recordConnectionLatency(latencyMs) {
    this.connectionLatency.observe(latencyMs);
  }

  /**
   * Record QR code generated
   */
  recordQRGenerated() {
    this.qrCodesGenerated.inc();
  }

  /**
   * Record QR scan duration
   */
  recordQRScanDuration(durationSeconds) {
    this.qrScanDuration.observe(durationSeconds);
  }

  /**
   * Record error
   */
  recordError(type, severity = 'error') {
    this.errorsTotal.inc({ type, severity });
  }

  /**
   * Update CPU usage
   */
  updateCPUUsage() {
    const cpus = os.cpus();
    for (const [index, cpu] of cpus.entries()) {
      const total = Object.values(cpu.times).reduce((accumulator, tv) => accumulator + tv, 0);
      const usage = 100 - Math.trunc((100 * cpu.times.idle) / total);
      this.cpuUsage.set({ core: `${index}` }, usage);
    }
  }

  /**
   * Update memory usage
   */
  updateMemoryUsage() {
    const memUsage = process.memoryUsage();
    this.memoryUsage.set({ type: 'rss' }, memUsage.rss);
    this.memoryUsage.set({ type: 'heapTotal' }, memUsage.heapTotal);
    this.memoryUsage.set({ type: 'heapUsed' }, memUsage.heapUsed);
    this.memoryUsage.set({ type: 'external' }, memUsage.external);
  }

  /**
   * Record rate limit hit
   */
  recordRateLimitHit(endpoint, user = 'anonymous') {
    this.rateLimitHits.inc({ endpoint, user });
  }

  /**
   * Update circuit breaker state
   */
  updateCircuitBreakerState(service, state) {
    const stateValue = state === 'closed' ? 0 : state === 'open' ? 1 : 2;
    this.circuitBreakerState.set({ service }, stateValue);
  }

  /**
   * Record circuit breaker trip
   */
  recordCircuitBreakerTrip(service) {
    this.circuitBreakerTrips.inc({ service });
  }

  /**
   * Update worker count
   */
  updateWorkerCount(count) {
    this.workerCount.set(count);
  }

  /**
   * Record worker restart
   */
  recordWorkerRestart() {
    this.workerRestarts.inc();
  }

  /**
   * Record API response time
   */
  recordAPIResponseTime(method, endpoint, status, durationMs) {
    this.apiResponseTime.observe({ method, endpoint, status }, durationMs);
  }

  /**
   * Start automatic metrics collection
   */
  startCollection(interval = 10_000) {
    this.collectionInterval = setInterval(() => {
      this.updateCPUUsage();
      this.updateMemoryUsage();
    }, interval);

    logger.info(`Metrics collection started with interval ${interval}ms`);
  }

  /**
   * Stop automatic metrics collection
   */
  stopCollection() {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
      logger.info('Metrics collection stopped');
    }
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics() {
    return this.registry.metrics();
  }

  /**
   * Get metrics as JSON
   */
  async getMetricsJSON() {
    return this.registry.getMetricsAsJSON();
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.registry.resetMetrics();
    logger.info('All metrics reset');
  }

  /**
   * Create middleware for Express
   */
  middleware() {
    return async (req, res, next) => {
      const start = Date.now();

      // Record response
      res.on('finish', () => {
        const duration = Date.now() - start;
        const { method } = req;
        const endpoint = req.route?.path || req.path;
        const status = res.statusCode;

        this.recordAPIResponseTime(method, endpoint, status, duration);
      });

      next();
    };
  }

  /**
   * Get health status based on metrics
   */
  getHealthStatus() {
    const memUsage = process.memoryUsage();
    const maxMemory = 512 * 1024 * 1024; // 512MB default

    const health = {
      status: 'healthy',
      checks: {
        memory: memUsage.heapUsed < maxMemory * 0.8 ? 'healthy' : 'warning',
        sessions: this.sessionsActive._value < 1000 ? 'healthy' : 'warning',
        errors: this.errorsTotal._value < 100 ? 'healthy' : 'warning',
      },
      metrics: {
        activeSessions: this.sessionsActive._value,
        totalMessages: this.messagesTotal._value,
        totalErrors: this.errorsTotal._value,
        memoryUsage: memUsage.heapUsed,
        uptime: process.uptime(),
      },
    };

    // Determine overall status
    const warnings = Object.values(health.checks).filter((s) => s === 'warning').length;
    if (warnings > 0) {
      health.status = warnings > 1 ? 'degraded' : 'warning';
    }

    return health;
  }
}

export default MetricsCollector;
