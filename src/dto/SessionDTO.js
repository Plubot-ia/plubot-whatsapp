/**
 * Session Data Transfer Object
 * Clean, serializable representation of WhatsApp sessions
 */

export class SessionDTO {
  constructor(session) {
    this.sessionId = session.sessionId;
    this.userId = session.userId;
    this.plubotId = session.plubotId;
    this.status = session.status;
    this.isReady = session.isReady || false;
    this.isAuthenticated = session.isAuthenticated || false;
    this.createdAt = session.createdAt;
    this.updatedAt = session.updatedAt || session.createdAt;
    this.lastActivity = session.lastActivity || null;
    this.qr = session.qr || null;
    this.qrDataUrl = session.qrDataUrl || null;
    this.connectionState = session.connectionState || 'disconnected';
    this.error = session.error || null;
    this.metrics = this.extractMetrics(session);
  }

  extractMetrics(session) {
    return {
      messagesReceived: session.messagesReceived || 0,
      messagesSent: session.messagesSent || 0,
      reconnections: session.reconnections || 0,
      uptime: session.uptime || 0,
      lastError: session.lastError || null,
    };
  }

  static fromSession(session) {
    if (!session) return null;
    return new SessionDTO(session);
  }

  static fromSessionList(sessions) {
    if (!Array.isArray(sessions)) return [];
    return sessions.map((session) => SessionDTO.fromSession(session));
  }

  toJSON() {
    return {
      sessionId: this.sessionId,
      userId: this.userId,
      plubotId: this.plubotId,
      status: this.status,
      isReady: this.isReady,
      isAuthenticated: this.isAuthenticated,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      lastActivity: this.lastActivity,
      qr: this.qr,
      qrDataUrl: this.qrDataUrl,
      connectionState: this.connectionState,
      error: this.error,
      metrics: this.metrics,
    };
  }
}

export class SessionCreateResponseDTO {
  constructor(success, session, error = null) {
    this.success = success;
    this.data = session ? SessionDTO.fromSession(session) : null;
    this.error = error;
    this.timestamp = new Date().toISOString();
  }

  static success(session) {
    return new SessionCreateResponseDTO(true, session, null);
  }

  static failure(error) {
    const errorMessage = error?.message || error || 'Unknown error occurred';
    return new SessionCreateResponseDTO(false, null, errorMessage);
  }

  toJSON() {
    return {
      success: this.success,
      data: this.data,
      error: this.error,
      timestamp: this.timestamp,
    };
  }
}

export class SessionListResponseDTO {
  constructor(sessions, pagination = null) {
    this.sessions = SessionDTO.fromSessionList(sessions);
    this.total = this.sessions.length;
    this.pagination = pagination;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      sessions: this.sessions,
      total: this.total,
      pagination: this.pagination,
      timestamp: this.timestamp,
    };
  }
}

export default {
  SessionDTO,
  SessionCreateResponseDTO,
  SessionListResponseDTO,
};
