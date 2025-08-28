/**
 * Queue Manager for WhatsApp Demo Sessions
 * Limits concurrent connections to ensure stability
 */

class QueueManager {
  constructor(maxConcurrent = 20, maxQueueSize = 10) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueueSize = maxQueueSize;
    this.activeSessions = new Map();
    this.waitingQueue = [];
    this.sessionTimeouts = new Map();
  }

  /**
   * Initialize the queue manager
   */
  async initialize() {
    console.log(`QueueManager initialized with max ${this.maxConcurrent} concurrent sessions`);
    // Start cleanup interval
    setInterval(() => this.cleanupInactiveSessions(), 60000);
    return true;
  }

  /**
   * Request a session slot
   * @returns {Object} { allowed: boolean, position?: number, estimatedWait?: number }
   */
  async requestSlot(userId, plubotId) {
    const sessionId = `${userId}-${plubotId}`;
    
    // Check if user already has an active session
    if (this.activeSessions.has(sessionId)) {
      this.refreshTimeout(sessionId);
      return { 
        allowed: true, 
        status: 'active',
        message: 'Sesión activa existente' 
      };
    }

    // Check if we have available slots
    if (this.activeSessions.size < this.maxConcurrent) {
      this.activeSessions.set(sessionId, {
        userId,
        plubotId,
        startTime: Date.now(),
        lastActivity: Date.now()
      });
      this.setSessionTimeout(sessionId);
      
      return { 
        allowed: true, 
        status: 'granted',
        message: 'Slot disponible asignado',
        activeSessions: this.activeSessions.size,
        maxSessions: this.maxConcurrent
      };
    }

    // Check queue
    const queuePosition = this.waitingQueue.findIndex(
      item => item.sessionId === sessionId
    );
    
    if (queuePosition !== -1) {
      return {
        allowed: false,
        status: 'queued',
        position: queuePosition + 1,
        estimatedWait: this.estimateWaitTime(queuePosition),
        message: `Estás en posición ${queuePosition + 1} de la cola`
      };
    }

    // Add to queue if space available
    if (this.waitingQueue.length < this.maxQueueSize) {
      this.waitingQueue.push({
        sessionId,
        userId,
        plubotId,
        requestTime: Date.now()
      });
      
      return {
        allowed: false,
        status: 'queued',
        position: this.waitingQueue.length,
        estimatedWait: this.estimateWaitTime(this.waitingQueue.length - 1),
        message: `Añadido a la cola. Posición: ${this.waitingQueue.length}`
      };
    }

    // Queue is full
    return {
      allowed: false,
      status: 'rejected',
      message: 'Sistema al máximo de capacidad. Por favor, intenta más tarde o usa WhatsApp Business API',
      suggestAPI: true
    };
  }

  /**
   * Release a session slot
   */
  releaseSlot(sessionId) {
    if (this.activeSessions.delete(sessionId)) {
      this.clearSessionTimeout(sessionId);
      
      // Process next in queue
      if (this.waitingQueue.length > 0) {
        const next = this.waitingQueue.shift();
        this.activeSessions.set(next.sessionId, {
          userId: next.userId,
          plubotId: next.plubotId,
          startTime: Date.now(),
          lastActivity: Date.now()
        });
        this.setSessionTimeout(next.sessionId);
        
        // Emit event to notify the user
        return {
          promoted: true,
          sessionId: next.sessionId,
          userId: next.userId
        };
      }
    }
    return { promoted: false };
  }

  /**
   * Set automatic timeout for inactive sessions
   */
  setSessionTimeout(sessionId, duration = 30 * 60 * 1000) {
    this.clearSessionTimeout(sessionId);
    
    this.sessionTimeouts.set(sessionId, setTimeout(() => {
      console.log(`Session ${sessionId} timed out - releasing slot`);
      this.releaseSlot(sessionId);
    }, duration));
  }

  /**
   * Clear session timeout
   */
  clearSessionTimeout(sessionId) {
    const timeout = this.sessionTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.sessionTimeouts.delete(sessionId);
    }
  }

  /**
   * Refresh timeout on activity
   */
  refreshTimeout(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
      this.setSessionTimeout(sessionId);
    }
  }

  /**
   * Estimate wait time based on queue position
   */
  estimateWaitTime(position) {
    // Average session duration: 15 minutes
    const avgSessionMinutes = 15;
    const estimatedMinutes = (position + 1) * avgSessionMinutes / this.maxConcurrent;
    return Math.ceil(estimatedMinutes);
  }

  /**
   * Get current system status
   */
  getStatus() {
    return {
      activeSessions: this.activeSessions.size,
      maxConcurrent: this.maxConcurrent,
      queueLength: this.waitingQueue.length,
      maxQueueSize: this.maxQueueSize,
      availableSlots: Math.max(0, this.maxConcurrent - this.activeSessions.size),
      sessions: Array.from(this.activeSessions.entries()).map(([id, data]) => ({
        sessionId: id,
        duration: Math.floor((Date.now() - data.startTime) / 1000 / 60), // minutes
        lastActivity: Math.floor((Date.now() - data.lastActivity) / 1000) // seconds
      }))
    };
  }

  /**
   * Clean up inactive sessions
   */
  cleanupInactive(maxInactiveMinutes = 10) {
    const now = Date.now();
    const maxInactive = maxInactiveMinutes * 60 * 1000;
    
    for (const [sessionId, data] of this.activeSessions.entries()) {
      if (now - data.lastActivity > maxInactive) {
        console.log(`Cleaning up inactive session: ${sessionId}`);
        this.releaseSlot(sessionId);
      }
    }
  }
}

export { QueueManager };
