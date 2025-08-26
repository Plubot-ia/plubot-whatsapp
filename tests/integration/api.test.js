import request from 'supertest';
import { jest } from '@jest/globals';

// Mock environment
process.env.NODE_ENV = 'test';
process.env.PORT = 3002;
process.env.REDIS_HOST = 'localhost';

describe('API Integration Tests', () => {
  let app;
  let server;

  beforeAll(async () => {
    // Import server after setting env vars
    const { EnterpriseWhatsAppServer } = await import('../../src/server.js');
    const serverInstance = new EnterpriseWhatsAppServer();
    await serverInstance.initialize();
    app = serverInstance.app;
    server = serverInstance.server;
  });

  afterAll(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
    }
  });

  describe('Health Endpoints', () => {
    test('GET /health should return service health', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body).toHaveProperty('status');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('checks');
    });

    test('GET /health/live should return liveness status', async () => {
      const response = await request(app)
        .get('/health/live')
        .expect(200);

      expect(response.body.status).toBe('alive');
      expect(response.body).toHaveProperty('uptime');
      expect(response.body).toHaveProperty('pid');
    });

    test('GET /health/ready should return readiness status', async () => {
      const response = await request(app)
        .get('/health/ready')
        .expect('Content-Type', /json/);

      expect(response.body).toHaveProperty('ready');
      expect(response.body).toHaveProperty('status');
    });
  });

  describe('Session Management', () => {
    const testSessionId = 'test-session-' + Date.now();

    test('POST /api/v1/session/create should create a new session', async () => {
      const response = await request(app)
        .post('/api/v1/session/create')
        .send({ sessionId: testSessionId })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.sessionId).toBe(testSessionId);
    });

    test('POST /api/v1/session/create should require sessionId', async () => {
      const response = await request(app)
        .post('/api/v1/session/create')
        .send({})
        .expect(400);

      expect(response.body.error).toBe('Session ID required');
    });

    test('GET /api/v1/session/:sessionId/status should return session status', async () => {
      const response = await request(app)
        .get(`/api/v1/session/${testSessionId}/status`)
        .expect(200);

      expect(response.body).toHaveProperty('sessionId');
      expect(response.body).toHaveProperty('status');
    });

    test('DELETE /api/v1/session/:sessionId should destroy session', async () => {
      const response = await request(app)
        .delete(`/api/v1/session/${testSessionId}`)
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('Message Operations', () => {
    test('POST /api/v1/message/send should queue message', async () => {
      const response = await request(app)
        .post('/api/v1/message/send')
        .send({
          sessionId: 'test-session',
          recipient: '1234567890@c.us',
          message: 'Test message',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body).toHaveProperty('jobId');
    });

    test('POST /api/v1/message/send should validate required fields', async () => {
      const response = await request(app)
        .post('/api/v1/message/send')
        .send({ sessionId: 'test-session' })
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('Queue Statistics', () => {
    test('GET /api/v1/queue/stats should return queue statistics', async () => {
      const response = await request(app)
        .get('/api/v1/queue/stats')
        .expect(200);

      expect(response.body).toHaveProperty('queues');
      expect(response.body).toHaveProperty('metrics');
    });
  });

  describe('Circuit Breakers', () => {
    test('GET /api/v1/circuit-breakers should return circuit breaker status', async () => {
      const response = await request(app)
        .get('/api/v1/circuit-breakers')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  describe('Metrics', () => {
    test('GET /metrics should return Prometheus metrics', async () => {
      const response = await request(app)
        .get('/metrics')
        .expect(200)
        .expect('Content-Type', /text\/plain/);

      expect(response.text).toContain('# HELP');
      expect(response.text).toContain('# TYPE');
    });
  });

  describe('Rate Limiting', () => {
    test('Should enforce rate limits', async () => {
      const requests = [];
      
      // Make many requests quickly
      for (let i = 0; i < 150; i++) {
        requests.push(
          request(app).get('/api/v1/queue/stats')
        );
      }

      const responses = await Promise.all(requests);
      const rateLimited = responses.some(r => r.status === 429);
      
      expect(rateLimited).toBe(true);
    });
  });

  describe('Error Handling', () => {
    test('Should handle 404 errors', async () => {
      const response = await request(app)
        .get('/api/v1/non-existent')
        .expect(404);

      expect(response.body.error).toBe('Not Found');
    });

    test('Should handle malformed JSON', async () => {
      const response = await request(app)
        .post('/api/v1/session/create')
        .set('Content-Type', 'application/json')
        .send('{"invalid json}')
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('CORS', () => {
    test('Should include CORS headers', async () => {
      const response = await request(app)
        .get('/health')
        .set('Origin', 'http://localhost:3000')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBeTruthy();
    });

    test('Should handle preflight requests', async () => {
      const response = await request(app)
        .options('/api/v1/session/create')
        .set('Origin', 'http://localhost:3000')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);

      expect(response.headers['access-control-allow-methods']).toContain('POST');
    });
  });

  describe('Security Headers', () => {
    test('Should include security headers', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBeTruthy();
    });
  });
});
