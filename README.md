# Enterprise WhatsApp Microservice

A production-ready, scalable WhatsApp microservice built with Node.js, featuring clustering, distributed session management, message queuing, and comprehensive monitoring.

## 🚀 Features

### Core Features
- **Multi-session Management**: Handle thousands of concurrent WhatsApp sessions
- **Horizontal Scaling**: Node.js cluster mode with worker processes
- **Message Queuing**: Bull-based message queue with retry logic and dead letter queues
- **Session Persistence**: Redis-backed session storage with automatic restoration
- **Auto-reconnection**: Exponential backoff with jitter for connection recovery
- **Health Monitoring**: Comprehensive health checks and readiness probes
- **Metrics Collection**: Prometheus metrics for monitoring and alerting
- **Rate Limiting**: Tiered rate limiting with Redis backend
- **Circuit Breakers**: Fault tolerance with automatic circuit breaking
- **WebSocket Support**: Real-time events via Socket.IO

### Enterprise Features
- **High Availability**: Session failover and worker restart policies
- **Load Balancing**: Multiple distribution strategies (least-connections, round-robin, etc.)
- **Security**: Helmet.js, CORS, rate limiting, input validation
- **Observability**: Structured logging, distributed tracing ready
- **Docker Support**: Multi-stage Dockerfile and Docker Compose
- **Kubernetes Ready**: Health checks, graceful shutdown, resource limits

## 📋 Prerequisites

- Node.js 20+ 
- Redis 7+
- Docker & Docker Compose (optional)
- Chromium/Chrome (for WhatsApp Web)

## 🛠️ Installation

### Local Development

```bash
# Clone the repository
git clone https://github.com/your-org/plubot-whatsapp.git
cd plubot-whatsapp

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Start Redis (if not using Docker)
redis-server

# Start the service
npm run dev
```

### Docker Deployment

```bash
# Build and start all services
docker-compose up -d

# View logs
docker-compose logs -f whatsapp-service

# Stop services
docker-compose down
```

### Production Deployment

```bash
# Build production image
docker build -t plubot-whatsapp:latest .

# Run with environment variables
docker run -d \
  --name plubot-whatsapp \
  -p 3001:3001 \
  -p 9090:9090 \
  -e REDIS_HOST=redis.example.com \
  -e NODE_ENV=production \
  plubot-whatsapp:latest
```

## 🔧 Configuration

### Environment Variables

```env
# Server Configuration
NODE_ENV=production
PORT=3001
METRICS_PORT=9090

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0
REDIS_QUEUE_DB=1
REDIS_RATELIMIT_DB=2

# Cluster Configuration
CLUSTER_WORKERS=4
WORKER_MAX_MEMORY=512
SESSION_DISTRIBUTION_STRATEGY=least-connections

# Session Pool
SESSION_POOL_MAX_SIZE=100
SESSION_POOL_MIN_SIZE=10
SESSION_IDLE_TIMEOUT=300000
SESSION_ACQUIRE_TIMEOUT=30000

# Message Queue
QUEUE_CONCURRENCY=5
QUEUE_MAX_RETRIES=3
QUEUE_RETRY_DELAY=5000

# Rate Limiting
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX_REQUESTS=100

# Circuit Breaker
CIRCUIT_BREAKER_THRESHOLD=50
CIRCUIT_BREAKER_TIMEOUT=30000
CIRCUIT_BREAKER_RESET_TIMEOUT=30000

# CORS
CORS_ORIGIN=http://localhost:3000

# Logging
LOG_LEVEL=info
LOG_FORMAT=json
```

## 📚 API Documentation

### Health Endpoints

#### GET /health
Main health check endpoint returning overall system status.

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "checks": {
    "system:memory": { "status": "healthy", "details": {...} },
    "dependency:redis": { "status": "healthy", "details": {...} },
    "whatsapp:sessions": { "status": "healthy", "details": {...} }
  }
}
```

#### GET /health/live
Kubernetes liveness probe endpoint.

#### GET /health/ready
Kubernetes readiness probe endpoint.

### Session Management

#### POST /api/v1/session/create
Create a new WhatsApp session.

**Request:**
```json
{
  "sessionId": "user-123"
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "user-123",
  "message": "Session created successfully"
}
```

#### DELETE /api/v1/session/:sessionId
Destroy a WhatsApp session.

#### GET /api/v1/session/:sessionId/status
Get session connection status.

### Message Operations

#### POST /api/v1/message/send
Send a WhatsApp message.

**Request:**
```json
{
  "sessionId": "user-123",
  "recipient": "1234567890@c.us",
  "message": "Hello, World!",
  "options": {
    "linkPreview": true
  }
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "job-456",
  "message": "Message queued for sending"
}
```

### Monitoring

#### GET /metrics
Prometheus metrics endpoint.

#### GET /api/v1/queue/stats
Get message queue statistics.

#### GET /api/v1/circuit-breakers
Get circuit breaker statuses.

## 🔌 WebSocket Events

Connect to WebSocket server for real-time events:

```javascript
const io = require('socket.io-client');
const socket = io('http://localhost:3001', {
  auth: { token: 'your-auth-token' }
});

// Subscribe to session events
socket.emit('subscribe:session', 'user-123');

// Listen for QR code
socket.on('qr', (data) => {
  console.log('QR Code:', data.qr);
});

// Listen for authentication
socket.on('authenticated', (data) => {
  console.log('Session authenticated');
});

// Listen for messages
socket.on('message', (data) => {
  console.log('New message:', data);
});
```

## 📊 Architecture

### System Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│                 │     │                 │     │                 │
│   Load Balancer │────▶│  Node Cluster   │────▶│     Redis       │
│     (Nginx)     │     │   (Workers)     │     │   (Sessions)    │
│                 │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │                         │
                               ▼                         ▼
                    ┌─────────────────┐     ┌─────────────────┐
                    │                 │     │                 │
                    │   Message Queue │     │   Rate Limiter  │
                    │     (Bull)      │     │                 │
                    │                 │     │                 │
                    └─────────────────┘     └─────────────────┘
                               │
                               ▼
                    ┌─────────────────┐
                    │                 │
                    │    WhatsApp     │
                    │    Sessions     │
                    │                 │
                    └─────────────────┘
```

### Component Overview

1. **ClusterManager**: Manages worker processes and load distribution
2. **SessionPool**: Handles WhatsApp client lifecycle with pooling
3. **MessageQueue**: Processes messages with retry and dead letter queues
4. **SessionReconnector**: Manages automatic reconnection with backoff
5. **MetricsCollector**: Collects Prometheus metrics for monitoring
6. **HealthChecker**: Provides health and readiness checks
7. **RateLimiter**: Implements tiered rate limiting
8. **CircuitBreaker**: Provides fault tolerance with circuit breaking

## 🧪 Testing

```bash
# Run unit tests
npm test

# Run integration tests
npm run test:integration

# Run with coverage
npm run test:coverage

# Run load tests
npm run test:load
```

## 📈 Monitoring

### Prometheus Metrics

- `plubot_whatsapp_sessions_total`: Total number of sessions
- `plubot_whatsapp_messages_sent_total`: Total messages sent
- `plubot_whatsapp_messages_received_total`: Total messages received
- `plubot_whatsapp_connection_duration_seconds`: Connection duration
- `plubot_whatsapp_queue_size`: Current queue size
- `plubot_whatsapp_worker_memory_bytes`: Worker memory usage
- `plubot_whatsapp_rate_limit_hits_total`: Rate limit hits
- `plubot_whatsapp_circuit_breaker_state`: Circuit breaker state

### Grafana Dashboards

Import the provided dashboards from `monitoring/grafana/dashboards/`:
- System Overview
- Session Metrics
- Message Queue
- Performance Metrics

## 🚨 Troubleshooting

### Common Issues

#### Session Not Connecting
- Check Redis connectivity
- Verify Chrome/Chromium is installed
- Check firewall rules for WhatsApp Web

#### High Memory Usage
- Adjust `WORKER_MAX_MEMORY`
- Reduce `SESSION_POOL_MAX_SIZE`
- Enable memory profiling

#### Message Queue Backed Up
- Increase `QUEUE_CONCURRENCY`
- Add more workers
- Check for slow message processors

### Debug Mode

Enable debug logging:
```bash
LOG_LEVEL=debug npm start
```

### Performance Tuning

1. **Optimize Worker Count**: Set `CLUSTER_WORKERS` to CPU cores
2. **Tune Session Pool**: Balance between memory and performance
3. **Redis Optimization**: Use Redis cluster for high load
4. **Message Batching**: Process messages in batches
5. **Connection Pooling**: Reuse database connections

## 🔒 Security

### Best Practices

1. **Authentication**: Implement JWT or API key authentication
2. **Input Validation**: Validate all API inputs
3. **Rate Limiting**: Configure appropriate rate limits
4. **HTTPS**: Use TLS in production
5. **Secrets Management**: Use environment variables or secret managers
6. **Network Isolation**: Use private networks for internal services
7. **Regular Updates**: Keep dependencies updated

### Security Headers

The service implements security headers via Helmet.js:
- Content Security Policy
- X-Frame-Options
- X-Content-Type-Options
- Strict-Transport-Security

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- WhatsApp Web.js community
- Node.js cluster documentation
- Redis for session persistence
- Bull for robust message queuing
- Prometheus for metrics collection

## 📞 Support

- Documentation: [docs.example.com](https://docs.example.com)
- Issues: [GitHub Issues](https://github.com/your-org/plubot-whatsapp/issues)
- Discord: [Join our Discord](https://discord.gg/example)

---

Built with ❤️ by the Plubot Team
