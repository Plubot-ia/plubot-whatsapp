import promClient from 'prom-client';

import logger from '../utils/EnhancedLogger.js';

class MetricsService {
  constructor() {
    // Create a Registry
    this.register = new promClient.Registry();

    // Add default metrics
    promClient.collectDefaultMetrics({
      register: this.register,
      prefix: 'plubot_whatsapp_',
    });

    // Custom metrics
    this.initializeMetrics();

    // Start metrics collection
    this.startCollection();
  }

  initializeMetrics() {
    // Session metrics
    this.sessionGauge = new promClient.Gauge({
      name: 'plubot_whatsapp_active_sessions',
      help: 'Number of active WhatsApp sessions',
      labelNames: ['status'],
      registers: [this.register],
    });

    this.sessionCreationCounter = new promClient.Counter({
      name: 'plubot_whatsapp_sessions_created_total',
      help: 'Total number of sessions created',
      labelNames: ['userId', 'plubotId'],
      registers: [this.register],
    });

    this.sessionErrorCounter = new promClient.Counter({
      name: 'plubot_whatsapp_session_errors_total',
      help: 'Total number of session errors',
      labelNames: ['type', 'sessionId'],
      registers: [this.register],
    });

    // QR Code metrics
    this.qrGenerationHistogram = new promClient.Histogram({
      name: 'plubot_whatsapp_qr_generation_duration_seconds',
      help: 'QR code generation duration in seconds',
      buckets: [0.1, 0.5, 1, 2, 5],
      registers: [this.register],
    });

    this.qrScansCounter = new promClient.Counter({
      name: 'plubot_whatsapp_qr_scans_total',
      help: 'Total number of QR code scans',
      labelNames: ['result'],
      registers: [this.register],
    });

    // Message metrics
    this.messageCounter = new promClient.Counter({
      name: 'plubot_whatsapp_messages_total',
      help: 'Total number of messages processed',
      labelNames: ['type', 'direction'],
      registers: [this.register],
    });

    this.messageProcessingHistogram = new promClient.Histogram({
      name: 'plubot_whatsapp_message_processing_duration_seconds',
      help: 'Message processing duration in seconds',
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
      registers: [this.register],
    });

    // API metrics
    this.apiRequestsCounter = new promClient.Counter({
      name: 'plubot_whatsapp_api_requests_total',
      help: 'Total number of API requests',
      labelNames: ['method', 'endpoint', 'status'],
      registers: [this.register],
    });

    this.apiLatencyHistogram = new promClient.Histogram({
      name: 'plubot_whatsapp_api_latency_seconds',
      help: 'API request latency in seconds',
      labelNames: ['method', 'endpoint'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.register],
    });

    // WebSocket metrics
    this.wsConnectionsGauge = new promClient.Gauge({
      name: 'plubot_whatsapp_websocket_connections',
      help: 'Number of active WebSocket connections',
      registers: [this.register],
    });

    this.wsEventsCounter = new promClient.Counter({
      name: 'plubot_whatsapp_websocket_events_total',
      help: 'Total number of WebSocket events',
      labelNames: ['event', 'room'],
      registers: [this.register],
    });

    // Resource metrics
    this.memoryUsageGauge = new promClient.Gauge({
      name: 'plubot_whatsapp_memory_usage_bytes',
      help: 'Memory usage in bytes',
      labelNames: ['type'],
      registers: [this.register],
    });

    this.cpuUsageGauge = new promClient.Gauge({
      name: 'plubot_whatsapp_cpu_usage_percent',
      help: 'CPU usage percentage',
      registers: [this.register],
    });

    // Circuit breaker metrics
    this.circuitBreakerStateGauge = new promClient.Gauge({
      name: 'plubot_whatsapp_circuit_breaker_state',
      help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
      labelNames: ['service'],
      registers: [this.register],
    });

    this.circuitBreakerTripsCounter = new promClient.Counter({
      name: 'plubot_whatsapp_circuit_breaker_trips_total',
      help: 'Total number of circuit breaker trips',
      labelNames: ['service'],
      registers: [this.register],
    });

    // Rate limiting metrics
    this.rateLimitHitsCounter = new promClient.Counter({
      name: 'plubot_whatsapp_rate_limit_hits_total',
      help: 'Total number of rate limit hits',
      labelNames: ['userId', 'endpoint'],
      registers: [this.register],
    });

    // Health check metrics
    this.healthCheckGauge = new promClient.Gauge({
      name: 'plubot_whatsapp_health_check_status',
      help: 'Health check status (1=healthy, 0=unhealthy)',
      labelNames: ['component'],
      registers: [this.register],
    });
  }

  startCollection() {
    // Collect memory and CPU metrics every 10 seconds
    setInterval(() => {
      const memUsage = process.memoryUsage();
      this.memoryUsageGauge.set({ type: 'rss' }, memUsage.rss);
      this.memoryUsageGauge.set({ type: 'heapTotal' }, memUsage.heapTotal);
      this.memoryUsageGauge.set({ type: 'heapUsed' }, memUsage.heapUsed);
      this.memoryUsageGauge.set({ type: 'external' }, memUsage.external);

      // CPU usage
      const cpuUsage = process.cpuUsage();
      const totalCpu = (cpuUsage.user + cpuUsage.system) / 1_000_000; // Convert to seconds
      this.cpuUsageGauge.set(totalCpu);
    }, 10_000);
  }

  // Session metrics methods
  incrementActiveSessions(status = 'connected') {
    this.sessionGauge.inc({ status });
  }

  decrementActiveSessions(status = 'connected') {
    this.sessionGauge.dec({ status });
  }

  recordSessionCreation(userId, plubotId) {
    this.sessionCreationCounter.inc({ userId, plubotId });
  }

  recordSessionError(type, sessionId) {
    this.sessionErrorCounter.inc({ type, sessionId });
  }

  // QR metrics methods
  recordQRGeneration(duration) {
    this.qrGenerationHistogram.observe(duration);
  }

  recordQRScan(result) {
    this.qrScansCounter.inc({ result });
  }

  // Message metrics methods
  recordMessage(type, direction) {
    this.messageCounter.inc({ type, direction });
  }

  recordMessageProcessing(duration) {
    this.messageProcessingHistogram.observe(duration);
  }

  // API metrics methods
  recordAPIRequest(method, endpoint, status) {
    this.apiRequestsCounter.inc({ method, endpoint, status });
  }

  recordAPILatency(method, endpoint, duration) {
    this.apiLatencyHistogram.observe({ method, endpoint }, duration);
  }

  // WebSocket metrics methods
  setActiveWSConnections(count) {
    this.wsConnectionsGauge.set(count);
  }

  recordWSEvent(event, room = 'global') {
    this.wsEventsCounter.inc({ event, room });
  }

  // Circuit breaker metrics
  setCircuitBreakerState(service, state) {
    const stateValue = state === 'closed' ? 0 : state === 'open' ? 1 : 2;
    this.circuitBreakerStateGauge.set({ service }, stateValue);
  }

  recordCircuitBreakerTrip(service) {
    this.circuitBreakerTripsCounter.inc({ service });
  }

  // Rate limiting metrics
  recordRateLimitHit(userId, endpoint) {
    this.rateLimitHitsCounter.inc({ userId, endpoint });
  }

  // Health check metrics
  setHealthStatus(component, isHealthy) {
    this.healthCheckGauge.set({ component }, isHealthy ? 1 : 0);
  }

  // Express middleware for API metrics
  apiMetricsMiddleware() {
    return (req, res, next) => {
      const start = Date.now();

      res.on('finish', () => {
        const duration = (Date.now() - start) / 1000;
        const endpoint = req.route ? req.route.path : req.path;

        this.recordAPIRequest(req.method, endpoint, res.statusCode);
        this.recordAPILatency(req.method, endpoint, duration);

        // Log slow requests
        if (duration > 1) {
          logger.performance(`Slow API request: ${req.method} ${endpoint}`, duration * 1000, {
            method: req.method,
            endpoint,
            statusCode: res.statusCode,
            threshold: 1000,
          });
        }
      });

      next();
    };
  }

  // WebSocket metrics helper
  trackWebSocketConnection(io) {
    io.on('connection', (socket) => {
      const connectedSockets = io.sockets.sockets.size;
      this.setActiveWSConnections(connectedSockets);

      socket.on('disconnect', () => {
        const remainingSockets = io.sockets.sockets.size;
        this.setActiveWSConnections(remainingSockets);
      });

      // Track all events
      const originalEmit = socket.emit;
      socket.emit = (event, ...arguments_) => {
        this.recordWSEvent(event, socket.rooms.values().next().value);
        return originalEmit.call(socket, event, ...arguments_);
      };
    });
  }

  // Get metrics for Prometheus endpoint
  async getMetrics() {
    return this.register.metrics();
  }

  // Get metrics in JSON format
  async getMetricsJSON() {
    return this.register.getMetricsAsJSON();
  }

  // Custom dashboard data
  async getDashboardMetrics() {
    const metrics = await this.getMetricsJSON();

    // Extract key metrics for dashboard
    return {
      sessions: {
        active: this.extractMetricValue(metrics, 'plubot_whatsapp_active_sessions'),
        total: this.extractMetricValue(metrics, 'plubot_whatsapp_sessions_created_total'),
        errors: this.extractMetricValue(metrics, 'plubot_whatsapp_session_errors_total'),
      },
      messages: {
        total: this.extractMetricValue(metrics, 'plubot_whatsapp_messages_total'),
        avgProcessingTime: this.extractHistogramAvg(
          metrics,
          'plubot_whatsapp_message_processing_duration_seconds',
        ),
      },
      api: {
        requests: this.extractMetricValue(metrics, 'plubot_whatsapp_api_requests_total'),
        avgLatency: this.extractHistogramAvg(metrics, 'plubot_whatsapp_api_latency_seconds'),
      },
      websocket: {
        connections: this.extractMetricValue(metrics, 'plubot_whatsapp_websocket_connections'),
        events: this.extractMetricValue(metrics, 'plubot_whatsapp_websocket_events_total'),
      },
      resources: {
        memory: {
          rss: this.extractMetricValue(metrics, 'plubot_whatsapp_memory_usage_bytes', {
            type: 'rss',
          }),
          heapUsed: this.extractMetricValue(metrics, 'plubot_whatsapp_memory_usage_bytes', {
            type: 'heapUsed',
          }),
        },
        cpu: this.extractMetricValue(metrics, 'plubot_whatsapp_cpu_usage_percent'),
      },
      health: {
        overall: this.calculateOverallHealth(metrics),
        components: this.extractHealthComponents(metrics),
      },
    };
  }

  // Helper methods for extracting metrics
  extractMetricValue(metrics, name, labels = {}) {
    const metric = metrics.find((m) => m.name === name);
    if (!metric) return 0;

    if (metric.values && metric.values.length > 0) {
      if (Object.keys(labels).length > 0) {
        const value = metric.values.find((v) =>
          Object.entries(labels).every(([key, value_]) => v.labels[key] === value_),
        );
        return value ? value.value : 0;
      }
      return metric.values.reduce((sum, v) => sum + v.value, 0);
    }

    return metric.value || 0;
  }

  extractHistogramAvg(metrics, name) {
    const metric = metrics.find((m) => m.name === name);
    if (!metric || !metric.values) return 0;

    const sumMetric = metrics.find((m) => m.name === `${name}_sum`);
    const countMetric = metrics.find((m) => m.name === `${name}_count`);

    if (sumMetric && countMetric) {
      const sum = this.extractMetricValue(metrics, `${name}_sum`);
      const count = this.extractMetricValue(metrics, `${name}_count`);
      return count > 0 ? sum / count : 0;
    }

    return 0;
  }

  calculateOverallHealth(metrics) {
    const healthMetrics = metrics.filter((m) => m.name === 'plubot_whatsapp_health_check_status');
    if (healthMetrics.length === 0) return 100;

    let healthy = 0;
    let total = 0;

    for (const metric of healthMetrics) {
      if (metric.values) {
        for (const v of metric.values) {
          total++;
          if (v.value === 1) healthy++;
        }
      }
    }

    return total > 0 ? Math.round((healthy / total) * 100) : 100;
  }

  extractHealthComponents(metrics) {
    const healthMetrics = metrics.filter((m) => m.name === 'plubot_whatsapp_health_check_status');
    const components = {};

    for (const metric of healthMetrics) {
      if (metric.values) {
        for (const v of metric.values) {
          components[v.labels.component] = v.value === 1 ? 'healthy' : 'unhealthy';
        }
      }
    }

    return components;
  }
}

// Export singleton instance
export default new MetricsService();
