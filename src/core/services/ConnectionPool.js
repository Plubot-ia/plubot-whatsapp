import { LRUCache } from 'lru-cache';
import logger from '../utils/logger.js';
import { EventEmitter } from 'events';

class ConnectionPool extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      maxSize: options.maxSize || 100,
      minSize: options.minSize || 10,
      ttl: options.ttl || 1000 * 60 * 30, // 30 minutos por defecto
      maxAge: options.maxAge || 1000 * 60 * 60, // 1 hora máximo
      updateAgeOnGet: options.updateAgeOnGet !== false,
      updateAgeOnHas: options.updateAgeOnHas !== false,
      allowStale: options.allowStale || false,
      noDisposeOnSet: options.noDisposeOnSet || false,
      ...options
    };

    // Pool de conexiones usando LRU Cache
    this.pool = new LRUCache({
      max: this.options.maxSize,
      ttl: this.options.ttl,
      maxAge: this.options.maxAge,
      updateAgeOnGet: this.options.updateAgeOnGet,
      updateAgeOnHas: this.options.updateAgeOnHas,
      allowStale: this.options.allowStale,
      noDisposeOnSet: this.options.noDisposeOnSet,
      
      // Callback cuando se elimina una conexión
      dispose: async (value, key, reason) => {
        logger.info(`🔌 Disposing connection`, { 
          sessionId: key, 
          reason,
          age: Date.now() - value.createdAt
        });
        
        await this.disposeConnection(value, key, reason);
      },
      
      // Callback para determinar el tamaño de cada item
      sizeCalculation: (value) => {
        // Estimar el tamaño basado en el uso de memoria
        return value.memoryUsage || 1;
      },
      
      // Callback cuando se alcanza el límite de tamaño
      maxSize: this.options.maxSize,
      
      // Fetch automático si no existe
      fetchMethod: this.options.fetchMethod
    });

    // Estadísticas del pool
    this.stats = {
      created: 0,
      destroyed: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      errors: 0,
      activeConnections: 0,
      idleConnections: 0,
      pendingConnections: 0
    };

    // Cola de espera para conexiones
    this.waitQueue = [];
    
    // Conexiones en proceso de creación
    this.pendingConnections = new Map();
    
    // Health checks
    this.healthCheckInterval = null;
    this.startHealthChecks();
    
    // Métricas
    this.metricsInterval = null;
    this.startMetricsCollection();
  }

  async acquire(sessionId, options = {}) {
    const startTime = Date.now();
    
    try {
      // Verificar si ya existe en el pool
      let connection = this.pool.get(sessionId);
      
      if (connection && await this.isHealthy(connection)) {
        this.stats.hits++;
        connection.lastUsed = Date.now();
        connection.useCount++;
        
        logger.debug(`✅ Connection acquired from pool`, {
          sessionId,
          poolSize: this.pool.size,
          duration: Date.now() - startTime
        });
        
        this.emit('connection:acquired', { sessionId, connection });
        return connection;
      }

      // Si no existe o no está saludable, crear nueva
      this.stats.misses++;
      
      // Verificar si ya hay una creación en proceso
      if (this.pendingConnections.has(sessionId)) {
        logger.debug(`⏳ Waiting for pending connection`, { sessionId });
        return await this.pendingConnections.get(sessionId);
      }

      // Verificar límite del pool
      if (this.pool.size >= this.options.maxSize && !options.force) {
        // Intentar evictar conexiones viejas
        const evicted = this.evictOldConnections();
        
        if (!evicted) {
          // Si no se puede evictar, agregar a cola de espera
          if (options.wait) {
            return await this.waitForConnection(sessionId, options.timeout);
          }
          
          throw new Error(`Connection pool is full (${this.pool.size}/${this.options.maxSize})`);
        }
      }

      // Crear nueva conexión
      const connectionPromise = this.createConnection(sessionId, options);
      this.pendingConnections.set(sessionId, connectionPromise);
      
      try {
        connection = await connectionPromise;
        
        // Agregar al pool
        this.pool.set(sessionId, connection);
        this.stats.created++;
        this.stats.activeConnections++;
        
        logger.info(`🔗 New connection created`, {
          sessionId,
          poolSize: this.pool.size,
          duration: Date.now() - startTime
        });
        
        this.emit('connection:created', { sessionId, connection });
        return connection;
        
      } finally {
        this.pendingConnections.delete(sessionId);
      }
      
    } catch (error) {
      this.stats.errors++;
      logger.error(`❌ Failed to acquire connection`, {
        sessionId,
        error: error.message,
        duration: Date.now() - startTime
      });
      
      this.emit('connection:error', { sessionId, error });
      throw error;
    }
  }

  async release(sessionId, connection) {
    try {
      if (!connection) {
        return;
      }

      connection.lastUsed = Date.now();
      connection.isActive = false;
      
      // Verificar salud antes de devolver al pool
      if (!await this.isHealthy(connection)) {
        logger.warn(`⚠️ Unhealthy connection released, disposing`, { sessionId });
        await this.destroy(sessionId);
        return;
      }

      // Actualizar en el pool
      this.pool.set(sessionId, connection);
      this.stats.activeConnections--;
      this.stats.idleConnections++;
      
      logger.debug(`🔓 Connection released`, {
        sessionId,
        useCount: connection.useCount,
        age: Date.now() - connection.createdAt
      });
      
      this.emit('connection:released', { sessionId, connection });
      
      // Procesar cola de espera si existe
      this.processWaitQueue();
      
    } catch (error) {
      logger.error(`❌ Failed to release connection`, {
        sessionId,
        error: error.message
      });
    }
  }

  async destroy(sessionId) {
    try {
      const connection = this.pool.get(sessionId);
      
      if (!connection) {
        return false;
      }

      // Eliminar del pool
      this.pool.delete(sessionId);
      
      // Disponer la conexión
      await this.disposeConnection(connection, sessionId, 'manual');
      
      this.stats.destroyed++;
      this.stats.activeConnections = Math.max(0, this.stats.activeConnections - 1);
      
      logger.info(`💥 Connection destroyed`, { sessionId });
      
      this.emit('connection:destroyed', { sessionId });
      
      // Procesar cola de espera
      this.processWaitQueue();
      
      return true;
      
    } catch (error) {
      logger.error(`❌ Failed to destroy connection`, {
        sessionId,
        error: error.message
      });
      return false;
    }
  }

  async createConnection(sessionId, options = {}) {
    const connection = {
      sessionId,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      useCount: 0,
      isActive: true,
      memoryUsage: 1,
      options,
      client: null, // Será establecido por el servicio que use el pool
      metadata: {}
    };

    // Si hay un método de creación personalizado
    if (this.options.createMethod) {
      connection.client = await this.options.createMethod(sessionId, options);
    }

    return connection;
  }

  async disposeConnection(connection, sessionId, reason) {
    try {
      // Si hay un método de disposición personalizado
      if (this.options.disposeMethod) {
        await this.options.disposeMethod(connection, sessionId, reason);
      }

      // Limpiar cliente si existe
      if (connection.client && typeof connection.client.destroy === 'function') {
        await connection.client.destroy();
      }

      // Limpiar referencias
      connection.client = null;
      connection.metadata = null;
      
    } catch (error) {
      logger.error(`❌ Error disposing connection`, {
        sessionId,
        reason,
        error: error.message
      });
    }
  }

  async isHealthy(connection) {
    try {
      // Verificar edad máxima
      if (Date.now() - connection.createdAt > this.options.maxAge) {
        return false;
      }

      // Si hay un método de health check personalizado
      if (this.options.healthCheckMethod) {
        return await this.options.healthCheckMethod(connection);
      }

      // Verificar si el cliente existe y está conectado
      if (connection.client) {
        if (typeof connection.client.isConnected === 'function') {
          return await connection.client.isConnected();
        }
        if (typeof connection.client.getState === 'function') {
          const state = await connection.client.getState();
          return state === 'CONNECTED' || state === 'ready';
        }
      }

      return true;
      
    } catch (error) {
      logger.error(`❌ Health check failed`, {
        sessionId: connection.sessionId,
        error: error.message
      });
      return false;
    }
  }

  evictOldConnections(count = 1) {
    let evicted = 0;
    const now = Date.now();
    
    // Obtener todas las conexiones ordenadas por último uso
    const entries = Array.from(this.pool.entries())
      .filter(([_, conn]) => !conn.isActive)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);

    for (const [sessionId, connection] of entries) {
      if (evicted >= count) break;
      
      // Evictar si es muy vieja o no está en uso
      if (now - connection.lastUsed > this.options.ttl / 2) {
        this.pool.delete(sessionId);
        this.stats.evictions++;
        evicted++;
        
        logger.info(`♻️ Connection evicted`, {
          sessionId,
          age: now - connection.createdAt,
          lastUsed: now - connection.lastUsed
        });
      }
    }

    return evicted > 0;
  }

  async waitForConnection(sessionId, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waitQueue.findIndex(w => w.sessionId === sessionId);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
        }
        reject(new Error('Connection wait timeout'));
      }, timeout);

      this.waitQueue.push({
        sessionId,
        resolve: (connection) => {
          clearTimeout(timer);
          resolve(connection);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });

      this.stats.pendingConnections = this.waitQueue.length;
    });
  }

  processWaitQueue() {
    if (this.waitQueue.length === 0) return;
    
    const available = this.options.maxSize - this.pool.size;
    
    if (available > 0) {
      const waiter = this.waitQueue.shift();
      if (waiter) {
        this.acquire(waiter.sessionId)
          .then(waiter.resolve)
          .catch(waiter.reject);
        
        this.stats.pendingConnections = this.waitQueue.length;
      }
    }
  }

  startHealthChecks() {
    this.healthCheckInterval = setInterval(async () => {
      const unhealthy = [];
      
      for (const [sessionId, connection] of this.pool.entries()) {
        if (!connection.isActive && !await this.isHealthy(connection)) {
          unhealthy.push(sessionId);
        }
      }

      // Eliminar conexiones no saludables
      for (const sessionId of unhealthy) {
        await this.destroy(sessionId);
      }

      if (unhealthy.length > 0) {
        logger.info(`🏥 Health check completed`, {
          unhealthy: unhealthy.length,
          poolSize: this.pool.size
        });
      }
      
    }, 60000); // Cada minuto
  }

  startMetricsCollection() {
    this.metricsInterval = setInterval(() => {
      const metrics = this.getMetrics();
      
      logger.info('📊 Connection Pool Metrics', metrics);
      
      this.emit('metrics', metrics);
      
    }, 30000); // Cada 30 segundos
  }

  getMetrics() {
    const poolInfo = {
      size: this.pool.size,
      maxSize: this.options.maxSize,
      utilization: (this.pool.size / this.options.maxSize) * 100
    };

    const connections = Array.from(this.pool.values());
    const now = Date.now();
    
    const connectionStats = {
      active: connections.filter(c => c.isActive).length,
      idle: connections.filter(c => !c.isActive).length,
      avgAge: connections.reduce((sum, c) => sum + (now - c.createdAt), 0) / connections.length || 0,
      avgUseCount: connections.reduce((sum, c) => sum + c.useCount, 0) / connections.length || 0
    };

    return {
      pool: poolInfo,
      connections: connectionStats,
      stats: this.stats,
      waitQueue: this.waitQueue.length,
      timestamp: now
    };
  }

  async clear() {
    logger.warn('🧹 Clearing connection pool...');
    
    // Destruir todas las conexiones
    for (const sessionId of this.pool.keys()) {
      await this.destroy(sessionId);
    }

    // Rechazar todas las esperas
    for (const waiter of this.waitQueue) {
      waiter.reject(new Error('Pool cleared'));
    }
    
    this.waitQueue = [];
    this.stats.pendingConnections = 0;
    
    logger.info('✅ Connection pool cleared');
  }

  async shutdown() {
    logger.info('🛑 Shutting down connection pool...');
    
    // Detener health checks y métricas
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }

    // Limpiar el pool
    await this.clear();
    
    logger.info('✅ Connection pool shutdown complete');
  }

  // Métodos de conveniencia
  has(sessionId) {
    return this.pool.has(sessionId);
  }

  get(sessionId) {
    return this.pool.get(sessionId);
  }

  getSize() {
    return this.pool.size;
  }

  getStats() {
    return { ...this.stats };
  }
}

// Singleton
let connectionPoolInstance = null;

export function getConnectionPool(options) {
  if (!connectionPoolInstance) {
    connectionPoolInstance = new ConnectionPool(options);
  }
  return connectionPoolInstance;
}

export default ConnectionPool;
