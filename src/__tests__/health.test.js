/* eslint-disable unicorn/no-abusive-eslint-disable, no-undef, unicorn/prevent-abbreviations */
import { describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Mock app for testing
const app = express();
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'plubot-whatsapp',
    timestamp: new Date().toISOString(),
  });
});

describe('Health Check Endpoint', () => {
  it('should return 200 status for health check', async () => {
    const response = await request(app).get('/health').expect('Content-Type', /json/).expect(200);

    expect(response.body).toHaveProperty('status', 'healthy');
    expect(response.body).toHaveProperty('service', 'plubot-whatsapp');
    expect(response.body).toHaveProperty('timestamp');
  });

  it('should return valid timestamp', async () => {
    const response = await request(app).get('/health').expect(200);

    const timestamp = new Date(response.body.timestamp);
    expect(timestamp).toBeInstanceOf(Date);
    expect(timestamp.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
