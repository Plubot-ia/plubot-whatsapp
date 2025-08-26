import { jest } from '@jest/globals';
import { SessionPool } from '../../src/core/SessionPool.js';
import IORedis from 'ioredis';

// Mock Redis
jest.mock('ioredis');

describe('SessionPool', () => {
  let sessionPool;
  let redisMock;

  beforeEach(() => {
    redisMock = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      exists: jest.fn(),
      expire: jest.fn(),
      smembers: jest.fn().mockResolvedValue([]),
      sadd: jest.fn(),
      srem: jest.fn(),
      hget: jest.fn(),
      hset: jest.fn(),
      hdel: jest.fn(),
      quit: jest.fn(),
    };
    
    IORedis.mockImplementation(() => redisMock);
    
    sessionPool = new SessionPool({
      maxPoolSize: 10,
      minPoolSize: 2,
      acquireTimeout: 5000,
      idleTimeout: 10000,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Session Creation', () => {
    it('should create a new session', async () => {
      const sessionId = 'test-session-1';
      const session = await sessionPool.createSession(sessionId);
      
      expect(session).toBeDefined();
      expect(session.id).toBe(sessionId);
      expect(sessionPool.sessions.has(sessionId)).toBe(true);
    });

    it('should not exceed max pool size', async () => {
      const promises = [];
      
      for (let i = 0; i < 15; i++) {
        promises.push(sessionPool.createSession(`session-${i}`));
      }
      
      await expect(Promise.all(promises)).rejects.toThrow();
    });

    it('should persist session to Redis', async () => {
      const sessionId = 'test-session-2';
      await sessionPool.createSession(sessionId);
      
      expect(redisMock.hset).toHaveBeenCalled();
      expect(redisMock.sadd).toHaveBeenCalledWith('sessions:active', sessionId);
    });
  });

  describe('Session Acquisition', () => {
    beforeEach(async () => {
      await sessionPool.createSession('test-session');
    });

    it('should acquire an existing session', async () => {
      const session = await sessionPool.acquire('test-session');
      
      expect(session).toBeDefined();
      expect(session.id).toBe('test-session');
      expect(session.status).toBe('acquired');
    });

    it('should timeout if session not available', async () => {
      sessionPool.config.acquireTimeout = 100;
      
      // Acquire the session
      await sessionPool.acquire('test-session');
      
      // Try to acquire again (should timeout)
      await expect(sessionPool.acquire('test-session')).rejects.toThrow('Acquire timeout');
    });

    it('should create session if not exists and autoCreate is true', async () => {
      const session = await sessionPool.acquire('new-session', { autoCreate: true });
      
      expect(session).toBeDefined();
      expect(session.id).toBe('new-session');
    });
  });

  describe('Session Release', () => {
    beforeEach(async () => {
      await sessionPool.createSession('test-session');
    });

    it('should release an acquired session', async () => {
      const session = await sessionPool.acquire('test-session');
      await sessionPool.release('test-session');
      
      expect(session.status).toBe('idle');
    });

    it('should update last used timestamp', async () => {
      const session = await sessionPool.acquire('test-session');
      const initialTime = session.lastUsed;
      
      await new Promise(resolve => setTimeout(resolve, 10));
      await sessionPool.release('test-session');
      
      expect(session.lastUsed).toBeGreaterThan(initialTime);
    });
  });

  describe('Session Destruction', () => {
    beforeEach(async () => {
      await sessionPool.createSession('test-session');
    });

    it('should destroy a session', async () => {
      await sessionPool.destroy('test-session');
      
      expect(sessionPool.sessions.has('test-session')).toBe(false);
      expect(redisMock.hdel).toHaveBeenCalledWith('sessions:data', 'test-session');
      expect(redisMock.srem).toHaveBeenCalledWith('sessions:active', 'test-session');
    });

    it('should handle destroying non-existent session', async () => {
      await expect(sessionPool.destroy('non-existent')).resolves.not.toThrow();
    });
  });

  describe('Health Checks', () => {
    it('should mark unhealthy sessions', async () => {
      const session = await sessionPool.createSession('test-session');
      session.healthy = false;
      
      await sessionPool.runHealthChecks();
      
      expect(sessionPool.sessions.has('test-session')).toBe(false);
    });

    it('should evict idle sessions', async () => {
      const session = await sessionPool.createSession('test-session');
      session.lastUsed = Date.now() - 20000; // 20 seconds ago
      
      await sessionPool.runHealthChecks();
      
      expect(sessionPool.sessions.has('test-session')).toBe(false);
    });
  });

  describe('Metrics', () => {
    it('should return pool metrics', async () => {
      await sessionPool.createSession('session-1');
      await sessionPool.createSession('session-2');
      await sessionPool.acquire('session-1');
      
      const metrics = sessionPool.getMetrics();
      
      expect(metrics.currentSize).toBe(2);
      expect(metrics.activeSize).toBe(1);
      expect(metrics.idleSize).toBe(1);
      expect(metrics.poolUtilization).toBe(20); // 2/10 * 100
    });
  });

  describe('Session Restoration', () => {
    it('should restore sessions from Redis', async () => {
      redisMock.smembers.mockResolvedValue(['session-1', 'session-2']);
      redisMock.hget.mockResolvedValue(JSON.stringify({
        id: 'session-1',
        created: Date.now(),
        state: {},
      }));
      
      await sessionPool.restoreSessions();
      
      expect(redisMock.smembers).toHaveBeenCalledWith('sessions:active');
      expect(redisMock.hget).toHaveBeenCalled();
    });
  });

  describe('Shutdown', () => {
    it('should gracefully shutdown', async () => {
      await sessionPool.createSession('session-1');
      await sessionPool.createSession('session-2');
      
      await sessionPool.shutdown();
      
      expect(sessionPool.sessions.size).toBe(0);
      expect(redisMock.quit).toHaveBeenCalled();
    });
  });
});
