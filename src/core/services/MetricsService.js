import promClient from 'prom-client';
import logger from '../utils/logger.js';

class MetricsService {
  constructor() {
    // Crear registro de métricas
    this.register = new promClient.Registry();
    
    // Agregar métricas por defecto
    promClient.collectDefaultMetrics({ 
      register: this.register,
      prefix: 'whatsapp_service_'
    });

    // Inicializar métricas personalizadas
    this.initializeMetrics();
    
    logger.info('📊 Metrics service initialized');
  }

  initializeMetrics() {
    // ===== Métricas de Sesiones =====
    this.sessionsTotal = new promClient.Counter({
      name: 'whatsapp_sessions_created_total',
      help: 'Total number of WhatsApp sessions created',
      labelNames: ['status', 'user_tier'],
      registers: [this.register]
    });

    this.sessionsActive = new promClient.Gauge({
      name: 'whatsapp_sessions_active',
      help: 'Number of active WhatsApp sessions',
      labelNames: ['state'],
      registers: [this.register]
    });

    this.sessionDuration = new promClient.Histogram({
      name: 'whatsapp_session_duration_seconds',
      help: 'Duration of WhatsApp sessions in seconds',
      buckets: [60, 300, 600, 1800, 3600, 7200, 14400],
      labelNames: ['status'],
      registers: [this.register]
    });

    this.qrGenerationTime = new promClient.Histogram({
      name: 'whatsapp_qr_generation_duration_seconds',
      help: 'Time taken to generate QR code in seconds',
      buckets: [0.5, 1, 2, 5, 10, 20, 30],
      registers: [this.register]
    });

    // ===== Métricas de Mensajes =====
    this.messagesTotal = new promClient.Counter({
      name: 'whatsapp_messages_total',
      help: 'Total number of messages processed',
      labelNames: ['direction', 'type', 'status'],
      registers: [this.register]
    });

    this.messageProcessingTime = new promClient.Histogram({
      name: 'whatsapp_message_processing_duration_seconds',
      help: 'Time taken to process messages in seconds',
      buckets: [0.1, 0.25, 0.5, 1, 2, 5],
      labelNames: ['type', 'direction'],
      registers: [this.register]
    });

    this.messageQueueSize = new promClient.Gauge({
      name: 'whatsapp_message_queue_size',
      help: 'Current size of message queue',
      labelNames: ['queue', 'status'],
      registers: [this.register]
    });

    this.messageQueueProcessingTime = new promClient.Histogram({
      name: 'whatsapp_message_queue_processing_seconds',
      help: 'Time taken to process messages from queue',
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      labelNames: ['queue', 'priority'],
      registers: [this.register]
    });

    // ===== Métricas de API =====
    this.httpRequestDuration = new promClient.Histogram({
      name: 'whatsapp_http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.register]
    });

    this.httpRequestsTotal = new promClient.Counter({
      name: 'whatsapp_http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status_code'],
      registers: [this.register]
    });

    this.httpRequestSize = new promClient.Histogram({
      name: 'whatsapp_http_request_size_bytes',
      help: 'Size of HTTP requests in bytes',
      buckets: [100, 1000, 10000, 100000, 1000000],
      labelNames: ['method', 'route'],
      registers: [this.register]
    });

    this.httpResponseSize = new promClient.Histogram({
      name: 'whatsapp_http_response_size_bytes',
      help: 'Size of HTTP responses in bytes',
      buckets: [100, 1000, 10000, 100000, 1000000],
      labelNames: ['method', 'route'],
      registers: [this.register]
    });

    // ===== Métricas de WebSocket =====
    this.wsConnectionsTotal = new promClient.Counter({
      name: 'whatsapp_ws_connections_total',
      help: 'Total number of WebSocket connections',
      labelNames: ['event'],
      registers: [this.register]
    });

    this.wsConnectionsActive = new promClient.Gauge({
      name: 'whatsapp_ws_connections_active',
      help: 'Number of active WebSocket connections',
      registers: [this.register]
    });

    this.wsMessagesTotal = new promClient.Counter({
      name: 'whatsapp_ws_messages_total',
      help: 'Total number of WebSocket messages',
      labelNames: ['event', 'direction'],
      registers: [this.register]
    });

    // ===== Métricas de Connection Pool =====
    this.connectionPoolSize = new promClient.Gauge({
      name: 'whatsapp_connection_pool_size',
      help: 'Current size of connection pool',
      labelNames: ['state'],
      registers: [this.register]
    });

    this.connectionPoolUtilization = new promClient.Gauge({
      name: 'whatsapp_connection_pool_utilization_percent',
      help: 'Connection pool utilization percentage',
      registers: [this.register]
    });

    this.connectionAcquisitionTime = new promClient.Histogram({
      name: 'whatsapp_connection_acquisition_duration_seconds',
      help: 'Time taken to acquire connection from pool',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.register]
    });

    // ===== Métricas de Seguridad =====
    this.authAttemptsTotal = new promClient.Counter({
      name: 'whatsapp_auth_attempts_total',
      help: 'Total number of authentication attempts',
      labelNames: ['result', 'method'],
      registers: [this.register]
    });

    this.rateLimitHits = new promClient.Counter({
      name: 'whatsapp_rate_limit_hits_total',
      help: 'Total number of rate limit hits',
      labelNames: ['endpoint', 'tier'],
      registers: [this.register]
    });

    this.securityViolations = new promClient.Counter({
      name: 'whatsapp_security_violations_total',
      help: 'Total number of security violations',
      labelNames: ['type', 'severity'],
      registers: [this.register]
    });

    this.blacklistedIPs = new promClient.Gauge({
      name: 'whatsapp_blacklisted_ips_count',
      help: 'Number of blacklisted IP addresses',
      registers: [this.register]
    });

    // ===== Métricas de Circuit Breaker =====
    this.circuitBreakerState = new promClient.Gauge({
      name: 'whatsapp_circuit_breaker_state',
      help: 'Circuit breaker state (0=closed, 1=open, 2=half-open)',
      labelNames: ['service'],
      registers: [this.register]
    });

    this.circuitBreakerFailures = new promClient.Counter({
      name: 'whatsapp_circuit_breaker_failures_total',
      help: 'Total number of circuit breaker failures',
      labelNames: ['service'],
      registers: [this.register]
    });

    // ===== Métricas de Redis =====
    this.redisOperations = new promClient.Counter({
      name: 'whatsapp_redis_operations_total',
      help: 'Total number of Redis operations',
      labelNames: ['operation', 'status'],
      registers: [this.register]
    });

    this.redisOperationDuration = new promClient.Histogram({
      name: 'whatsapp_redis_operation_duration_seconds',
      help: 'Duration of Redis operations in seconds',
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
      labelNames: ['operation'],
      registers: [this.register]
    });

    this.redisConnectionState = new promClient.Gauge({
      name: 'whatsapp_redis_connection_state',
      help: 'Redis connection state (0=disconnected, 1=connected)',
      registers: [this.register]
    });

    // ===== Métricas de Errores =====
    this.errorsTotal = new promClient.Counter({
      name: 'whatsapp_errors_total',
      help: 'Total number of errors',
      labelNames: ['type', 'severity', 'component'],
      registers: [this.register]
    });

    this.unhandledExceptions = new promClient.Counter({
      name: 'whatsapp_unhandled_exceptions_total',
      help: 'Total number of unhandled exceptions',
      registers: [this.register]
    });

    // ===== Métricas de Cluster =====
    this.workerRestarts = new promClient.Counter({
      name: 'whatsapp_worker_restarts_total',
      help: 'Total number of worker restarts',
      labelNames: ['reason'],
      registers: [this.register]
    });

    this.workersActive = new promClient.Gauge({
      name: 'whatsapp_workers_active',
      help: 'Number of active workers',
      registers: [this.register]
    });

    this.workerMemoryUsage = new promClient.Gauge({
      name: 'whatsapp_worker_memory_usage_bytes',
      help: 'Memory usage per worker in bytes',
      labelNames: ['worker_id', 'type'],
      registers: [this.register]
    });
  }

  // ===== Métodos de registro de métricas =====

  recordSessionCreated(status, userTier = 'free') {
    this.sessionsTotal.inc({ status, user_tier: userTier });
  }

  setActiveSessions(count, state = 'connected') {
    this.sessionsActive.set({ state }, count);
  }

  recordSessionDuration(durationSeconds, status = 'completed') {
    this.sessionDuration.observe({ status }, durationSeconds);
  }

  recordQRGenerationTime(durationSeconds) {
    this.qrGenerationTime.observe(durationSeconds);
  }

  recordMessage(direction, type, status) {
    this.messagesTotal.inc({ direction, type, status });
  }

  recordMessageProcessingTime(durationSeconds, type, direction) {
    this.messageProcessingTime.observe({ type, direction }, durationSeconds);
  }

  setMessageQueueSize(queue, status, size) {
    this.messageQueueSize.set({ queue, status }, size);
  }

  recordQueueProcessingTime(durationSeconds, queue, priority) {
    this.messageQueueProcessingTime.observe({ queue, priority }, durationSeconds);
  }

  recordHTTPRequest(method, route, statusCode, duration) {
    this.httpRequestsTotal.inc({ method, route, status_code: statusCode });
    this.httpRequestDuration.observe({ method, route, status_code: statusCode }, duration);
  }

  recordHTTPRequestSize(method, route, sizeBytes) {
    this.httpRequestSize.observe({ method, route }, sizeBytes);
  }

  recordHTTPResponseSize(method, route, sizeBytes) {
    this.httpResponseSize.observe({ method, route }, sizeBytes);
  }

  recordWSConnection(event) {
    this.wsConnectionsTotal.inc({ event });
  }

  setActiveWSConnections(count) {
    this.wsConnectionsActive.set(count);
  }

  recordWSMessage(event, direction) {
    this.wsMessagesTotal.inc({ event, direction });
  }

  setConnectionPoolSize(state, size) {
    this.connectionPoolSize.set({ state }, size);
  }

  setConnectionPoolUtilization(percentage) {
    this.connectionPoolUtilization.set(percentage);
  }

  recordConnectionAcquisition(durationSeconds) {
    this.connectionAcquisitionTime.observe(durationSeconds);
  }

  recordAuthAttempt(result, method = 'jwt') {
    this.authAttemptsTotal.inc({ result, method });
  }

  recordRateLimitHit(endpoint, tier = 'free') {
    this.rateLimitHits.inc({ endpoint, tier });
  }

  recordSecurityViolation(type, severity = 'medium') {
    this.securityViolations.inc({ type, severity });
  }

  setBlacklistedIPs(count) {
    this.blacklistedIPs.set(count);
  }

  setCircuitBreakerState(service, state) {
    const stateValue = state === 'closed' ? 0 : state === 'open' ? 1 : 2;
    this.circuitBreakerState.set({ service }, stateValue);
  }

  recordCircuitBreakerFailure(service) {
    this.circuitBreakerFailures.inc({ service });
  }

  recordRedisOperation(operation, status) {
    this.redisOperations.inc({ operation, status });
  }

  recordRedisOperationDuration(operation, durationSeconds) {
    this.redisOperationDuration.observe({ operation }, durationSeconds);
  }

  setRedisConnectionState(connected) {
    this.redisConnectionState.set(connected ? 1 : 0);
  }

  recordError(type, severity = 'error', component = 'unknown') {
    this.errorsTotal.inc({ type, severity, component });
  }

  recordUnhandledException() {
    this.unhandledExceptions.inc();
  }

  recordWorkerRestart(reason = 'unknown') {
    this.workerRestarts.inc({ reason });
  }

  setActiveWorkers(count) {
    this.workersActive.set(count);
  }

  setWorkerMemoryUsage(workerId, type, bytes) {
    this.workerMemoryUsage.set({ worker_id: workerId, type }, bytes);
  }

  // ===== Middleware para Express =====
  
  httpMiddleware() {
    return (req, res, next) => {
      const start = Date.now();
      
      // Registrar tamaño del request
      if (req.headers['content-length']) {
        const route = req.route?.path || req.path;
        this.recordHTTPRequestSize(req.method, route, parseInt(req.headers['content-length']));
      }

      // Interceptar response
      const originalSend = res.send;
      res.send = function(data) {
        res.send = originalSend;
        
        // Registrar métricas
        const duration = (Date.now() - start) / 1000;
        const route = req.route?.path || req.path;
        
        this.recordHTTPRequest(req.method, route, res.statusCode, duration);
        
        // Registrar tamaño del response
        if (data) {
          const size = Buffer.byteLength(data);
          this.recordHTTPResponseSize(req.method, route, size);
        }
        
        return res.send(data);
      }.bind(this);

      next();
    };
  }

  // ===== Socket.IO metrics =====
  
  attachSocketMetrics(io) {
    io.on('connection', (socket) => {
      this.recordWSConnection('connect');
      this.setActiveWSConnections(io.engine.clientsCount);

      socket.on('disconnect', () => {
        this.recordWSConnection('disconnect');
        this.setActiveWSConnections(io.engine.clientsCount);
      });

      // Interceptar mensajes
      const originalEmit = socket.emit;
      socket.emit = function(event, ...args) {
        this.recordWSMessage(event, 'outbound');
        return originalEmit.call(socket, event, ...args);
      }.bind(this);

      socket.onAny((event) => {
        this.recordWSMessage(event, 'inbound');
      });
    });
  }

  // ===== Obtener métricas en formato Prometheus =====
  
  async getMetrics() {
    return await this.register.metrics();
  }

  getContentType() {
    return this.register.contentType;
  }

  // ===== Resetear métricas =====
  
  reset() {
    this.register.clear();
    this.initializeMetrics();
    logger.info('📊 Metrics reset');
  }
}

// Singleton
let metricsInstance = null;

export function getMetrics() {
  if (!metricsInstance) {
    metricsInstance = new MetricsService();
  }
  return metricsInstance;
}

export default MetricsService;
