const Redis = require('ioredis');
const { EventEmitter } = require('events');
const logger = require('../utils/logger');

/**
 * Gestor de colas para limitar sesiones concurrentes de WhatsApp
 * Implementa límite de 20 usuarios con sistema de colas
 */
class QueueManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.maxConcurrentSessions = options.maxConcurrentSessions || 20;
    this.sessionTimeout = options.sessionTimeout || 30 * 60 * 1000; // 30 minutos
    
    // Conexión Redis para gestión de colas
    this.redis = new Redis({
      host: options.redis?.host || 'redis',
      port: options.redis?.port || 6379,
      password: options.redis?.password,
      retryStrategy: (times) => Math.min(times * 50, 2000)
    });
    
    // Estructuras en memoria para acceso rápido
    this.activeSessions = new Map();
    this.waitingQueue = [];
    this.userSessions = new Map();
    
    // Bind methods
    this.joinQueue = this.joinQueue.bind(this);
    this.leaveQueue = this.leaveQueue.bind(this);
    this.processQueue = this.processQueue.bind(this);
  }
  
  /**
   * Inicializar gestor de colas
   */
  async initialize() {
    try {
      // Cargar estado desde Redis
      await this.loadState();
      
      // Configurar limpieza periódica
      this.startCleanupInterval();
      
      logger.info(`📊 QueueManager inicializado - Max sesiones: ${this.maxConcurrentSessions}`);
    } catch (error) {
      logger.error('❌ Error inicializando QueueManager:', error);
      throw error;
    }
  }
  
  /**
   * Cargar estado desde Redis
   */
  async loadState() {
    try {
      // Cargar sesiones activas
      const activeKeys = await this.redis.keys('active:*');
      for (const key of activeKeys) {
        const data = await this.redis.get(key);
        if (data) {
          const session = JSON.parse(data);
          this.activeSessions.set(session.userId, session);
        }
      }
      
      // Cargar cola de espera
      const queueData = await this.redis.lrange('waiting_queue', 0, -1);
      this.waitingQueue = queueData.map(item => JSON.parse(item));
      
      logger.info(`📋 Estado cargado: ${this.activeSessions.size} activas, ${this.waitingQueue.length} en cola`);
    } catch (error) {
      logger.error('❌ Error cargando estado:', error);
    }
  }
  
  /**
   * Verificar si usuario puede unirse a la cola
   */
  async canJoinQueue(userId) {
    // Verificar si ya tiene sesión activa
    if (this.activeSessions.has(userId)) {
      logger.warn(`⚠️ Usuario ${userId} ya tiene sesión activa`);
      return false;
    }
    
    // Verificar si ya está en cola
    const inQueue = this.waitingQueue.some(item => item.userId === userId);
    if (inQueue) {
      logger.warn(`⚠️ Usuario ${userId} ya está en cola`);
      return false;
    }
    
    // Verificar límite de cola (máximo 100 en espera)
    if (this.waitingQueue.length >= 100) {
      logger.warn(`⚠️ Cola llena (100 usuarios)`);
      return false;
    }
    
    return true;
  }
  
  /**
   * Unirse a la cola o crear sesión si hay espacio
   */
  async joinQueue(userId, sessionId) {
    try {
      // Verificar si puede unirse
      const canJoin = await this.canJoinQueue(userId);
      if (!canJoin) {
        throw new Error('No puede unirse a la cola');
      }
      
      // Si hay espacio disponible, activar inmediatamente
      if (this.activeSessions.size < this.maxConcurrentSessions) {
        await this.activateSession(userId, sessionId);
        return 1; // Posición 1 = activo inmediatamente
      }
      
      // Agregar a cola de espera
      const queueItem = {
        userId,
        sessionId,
        joinedAt: Date.now()
      };
      
      this.waitingQueue.push(queueItem);
      await this.redis.rpush('waiting_queue', JSON.stringify(queueItem));
      
      const position = this.waitingQueue.length;
      logger.info(`👥 Usuario ${userId} agregado a cola - Posición: ${position}`);
      
      // Emitir evento
      this.emit('user-queued', { userId, sessionId, position });
      
      return position + 1; // +1 porque posición 1 = activo
      
    } catch (error) {
      logger.error(`❌ Error al unirse a cola:`, error);
      throw error;
    }
  }
  
  /**
   * Activar sesión de usuario
   */
  async activateSession(userId, sessionId) {
    const session = {
      userId,
      sessionId,
      startedAt: Date.now(),
      lastActivity: Date.now()
    };
    
    this.activeSessions.set(userId, session);
    await this.redis.setex(
      `active:${userId}`,
      this.sessionTimeout / 1000,
      JSON.stringify(session)
    );
    
    logger.info(`✅ Sesión activada para ${userId} (${this.activeSessions.size}/${this.maxConcurrentSessions})`);
    
    // Emitir evento
    this.emit('session-activated', { userId, sessionId });
  }
  
  /**
   * Salir de la cola o terminar sesión
   */
  async leaveQueue(userId) {
    try {
      // Remover de sesiones activas
      if (this.activeSessions.has(userId)) {
        this.activeSessions.delete(userId);
        await this.redis.del(`active:${userId}`);
        
        logger.info(`🔚 Sesión terminada para ${userId} (${this.activeSessions.size}/${this.maxConcurrentSessions})`);
        
        // Procesar siguiente en cola
        await this.processQueue();
        return;
      }
      
      // Remover de cola de espera
      const index = this.waitingQueue.findIndex(item => item.userId === userId);
      if (index !== -1) {
        this.waitingQueue.splice(index, 1);
        await this.updateQueueInRedis();
        
        logger.info(`🔚 Usuario ${userId} removido de cola`);
        
        // Notificar a usuarios en cola sobre nueva posición
        this.notifyQueuePositions();
      }
      
    } catch (error) {
      logger.error(`❌ Error al salir de cola:`, error);
      throw error;
    }
  }
  
  /**
   * Procesar siguiente en cola
   */
  async processQueue() {
    try {
      // Si no hay espacio o no hay usuarios esperando
      if (this.activeSessions.size >= this.maxConcurrentSessions || this.waitingQueue.length === 0) {
        return null;
      }
      
      // Obtener siguiente en cola
      const next = this.waitingQueue.shift();
      if (!next) return null;
      
      // Actualizar Redis
      await this.updateQueueInRedis();
      
      // Activar sesión
      await this.activateSession(next.userId, next.sessionId);
      
      logger.info(`⏭️ Procesando siguiente en cola: ${next.userId}`);
      
      // Notificar nuevas posiciones
      this.notifyQueuePositions();
      
      return next;
      
    } catch (error) {
      logger.error(`❌ Error procesando cola:`, error);
      return null;
    }
  }
  
  /**
   * Obtener siguiente en cola sin removerlo
   */
  async getNextInQueue() {
    if (this.waitingQueue.length === 0) return null;
    return this.waitingQueue[0];
  }
  
  /**
   * Actualizar cola en Redis
   */
  async updateQueueInRedis() {
    await this.redis.del('waiting_queue');
    if (this.waitingQueue.length > 0) {
      const queueData = this.waitingQueue.map(item => JSON.stringify(item));
      await this.redis.rpush('waiting_queue', ...queueData);
    }
  }
  
  /**
   * Notificar posiciones actualizadas en cola
   */
  notifyQueuePositions() {
    this.waitingQueue.forEach((item, index) => {
      this.emit('queue-position-updated', {
        userId: item.userId,
        sessionId: item.sessionId,
        position: index + 2 // +2 porque index 0 = posición 2 en cola
      });
    });
  }
  
  /**
   * Obtener estado de la cola
   */
  async getQueueStatus() {
    return {
      activeSessions: this.activeSessions.size,
      maxSessions: this.maxConcurrentSessions,
      availableSlots: this.maxConcurrentSessions - this.activeSessions.size,
      queueLength: this.waitingQueue.length,
      queue: this.waitingQueue.map((item, index) => ({
        ...item,
        position: index + 1,
        estimatedWait: this.estimateWaitTime(index + 1)
      }))
    };
  }
  
  /**
   * Estimar tiempo de espera
   */
  estimateWaitTime(position) {
    // Estimación simple: 5 minutos por posición
    return position * 5 * 60 * 1000;
  }
  
  /**
   * Actualizar actividad de sesión
   */
  async updateActivity(userId) {
    const session = this.activeSessions.get(userId);
    if (session) {
      session.lastActivity = Date.now();
      await this.redis.setex(
        `active:${userId}`,
        this.sessionTimeout / 1000,
        JSON.stringify(session)
      );
    }
  }
  
  /**
   * Limpiar sesiones inactivas
   */
  async cleanupInactiveSessions() {
    const now = Date.now();
    const toRemove = [];
    
    for (const [userId, session] of this.activeSessions) {
      if (now - session.lastActivity > this.sessionTimeout) {
        toRemove.push(userId);
      }
    }
    
    for (const userId of toRemove) {
      logger.info(`🧹 Limpiando sesión inactiva: ${userId}`);
      await this.leaveQueue(userId);
    }
    
    if (toRemove.length > 0) {
      logger.info(`🧹 ${toRemove.length} sesiones inactivas limpiadas`);
    }
  }
  
  /**
   * Iniciar intervalo de limpieza
   */
  startCleanupInterval() {
    // Limpiar cada 5 minutos
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveSessions();
    }, 5 * 60 * 1000);
  }
  
  /**
   * Cerrar gestor de colas
   */
  async shutdown() {
    logger.info('🛑 Cerrando QueueManager...');
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Guardar estado en Redis
    await this.updateQueueInRedis();
    
    // Cerrar conexión Redis
    await this.redis.quit();
    
    logger.info('✅ QueueManager cerrado');
  }
}

module.exports = QueueManager;
