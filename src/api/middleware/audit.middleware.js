import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto';
import logger from '../../core/utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Audit Logging Middleware
 * Tracks all critical operations for compliance and security
 */

// Audit event types
const AUDIT_EVENTS = {
  // Authentication events
  AUTH_LOGIN_SUCCESS: 'AUTH_LOGIN_SUCCESS',
  AUTH_LOGIN_FAILED: 'AUTH_LOGIN_FAILED',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
  AUTH_TOKEN_REFRESH: 'AUTH_TOKEN_REFRESH',
  AUTH_TOKEN_REVOKED: 'AUTH_TOKEN_REVOKED',
  
  // Session events
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_UPDATED: 'SESSION_UPDATED',
  SESSION_DELETED: 'SESSION_DELETED',
  SESSION_CONNECTED: 'SESSION_CONNECTED',
  SESSION_DISCONNECTED: 'SESSION_DISCONNECTED',
  SESSION_QR_GENERATED: 'SESSION_QR_GENERATED',
  SESSION_QR_SCANNED: 'SESSION_QR_SCANNED',
  
  // Message events
  MESSAGE_SENT: 'MESSAGE_SENT',
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  MESSAGE_DELETED: 'MESSAGE_DELETED',
  MESSAGE_BULK_SENT: 'MESSAGE_BULK_SENT',
  
  // User management events
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_DELETED: 'USER_DELETED',
  USER_ROLE_CHANGED: 'USER_ROLE_CHANGED',
  USER_PERMISSIONS_CHANGED: 'USER_PERMISSIONS_CHANGED',
  
  // Security events
  SECURITY_BREACH_ATTEMPT: 'SECURITY_BREACH_ATTEMPT',
  SECURITY_RATE_LIMIT_EXCEEDED: 'SECURITY_RATE_LIMIT_EXCEEDED',
  SECURITY_INVALID_TOKEN: 'SECURITY_INVALID_TOKEN',
  SECURITY_PERMISSION_DENIED: 'SECURITY_PERMISSION_DENIED',
  SECURITY_IP_BLOCKED: 'SECURITY_IP_BLOCKED',
  
  // System events
  SYSTEM_CONFIG_CHANGED: 'SYSTEM_CONFIG_CHANGED',
  SYSTEM_BACKUP_CREATED: 'SYSTEM_BACKUP_CREATED',
  SYSTEM_RESTORE_PERFORMED: 'SYSTEM_RESTORE_PERFORMED',
  SYSTEM_MAINTENANCE_MODE: 'SYSTEM_MAINTENANCE_MODE',
  
  // Data events
  DATA_EXPORTED: 'DATA_EXPORTED',
  DATA_IMPORTED: 'DATA_IMPORTED',
  DATA_DELETED: 'DATA_DELETED',
  DATA_ACCESSED: 'DATA_ACCESSED'
};

// Audit severity levels
const AUDIT_SEVERITY = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL'
};

// Audit log storage
class AuditLogger {
  constructor() {
    this.auditDir = path.join(process.cwd(), 'logs', 'audit');
    this.ensureAuditDirectory();
    this.currentLogFile = this.getLogFileName();
    this.rotateInterval = null;
    this.initializeRotation();
  }
  
  ensureAuditDirectory() {
    if (!fs.existsSync(this.auditDir)) {
      fs.mkdirSync(this.auditDir, { recursive: true });
    }
  }
  
  getLogFileName() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return path.join(this.auditDir, `audit-${year}-${month}-${day}.log`);
  }
  
  initializeRotation() {
    // Check for rotation every hour
    this.rotateInterval = setInterval(() => {
      const newLogFile = this.getLogFileName();
      if (newLogFile !== this.currentLogFile) {
        this.currentLogFile = newLogFile;
        logger.info('Audit log rotated to:', this.currentLogFile);
      }
    }, 3600000); // 1 hour
  }
  
  generateAuditId() {
    return crypto.randomBytes(16).toString('hex');
  }
  
  async log(auditEntry) {
    try {
      const logLine = JSON.stringify(auditEntry) + '\n';
      
      // Write to file
      await fs.promises.appendFile(this.currentLogFile, logLine);
      
      // Also log to main logger for real-time monitoring
      if (auditEntry.severity === AUDIT_SEVERITY.CRITICAL) {
        logger.error('CRITICAL AUDIT EVENT:', auditEntry);
      } else if (auditEntry.severity === AUDIT_SEVERITY.ERROR) {
        logger.error('Audit event:', auditEntry);
      } else if (auditEntry.severity === AUDIT_SEVERITY.WARNING) {
        logger.warn('Audit event:', auditEntry);
      } else {
        logger.info('Audit event:', auditEntry);
      }
      
      // Send to external audit service if configured
      if (process.env.AUDIT_WEBHOOK_URL) {
        this.sendToExternalAudit(auditEntry);
      }
      
      return true;
    } catch (error) {
      logger.error('Failed to write audit log:', error);
      return false;
    }
  }
  
  async sendToExternalAudit(auditEntry) {
    try {
      // Implement webhook sending logic here
      // This is a placeholder for external audit service integration
      if (process.env.NODE_ENV === 'production') {
        // Send to external service
      }
    } catch (error) {
      logger.error('Failed to send audit to external service:', error);
    }
  }
  
  async query(filters = {}) {
    try {
      const logs = [];
      const files = await fs.promises.readdir(this.auditDir);
      
      for (const file of files) {
        if (!file.startsWith('audit-')) continue;
        
        const filePath = path.join(this.auditDir, file);
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const lines = content.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            
            // Apply filters
            if (filters.startDate && new Date(entry.timestamp) < new Date(filters.startDate)) continue;
            if (filters.endDate && new Date(entry.timestamp) > new Date(filters.endDate)) continue;
            if (filters.event && entry.event !== filters.event) continue;
            if (filters.userId && entry.userId !== filters.userId) continue;
            if (filters.severity && entry.severity !== filters.severity) continue;
            
            logs.push(entry);
          } catch (e) {
            // Skip invalid JSON lines
          }
        }
      }
      
      // Sort by timestamp descending
      logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      return logs;
    } catch (error) {
      logger.error('Failed to query audit logs:', error);
      return [];
    }
  }
  
  destroy() {
    if (this.rotateInterval) {
      clearInterval(this.rotateInterval);
    }
  }
}

// Create singleton instance
const auditLogger = new AuditLogger();

/**
 * Create audit entry
 */
const createAuditEntry = (event, req, additionalData = {}) => {
  const entry = {
    id: auditLogger.generateAuditId(),
    timestamp: new Date().toISOString(),
    event: event,
    severity: additionalData.severity || AUDIT_SEVERITY.INFO,
    userId: req.user?.id || 'anonymous',
    userRole: req.user?.role || 'none',
    sessionId: req.sessionID || null,
    ipAddress: req.ip || req.connection?.remoteAddress,
    userAgent: req.headers['user-agent'],
    method: req.method,
    path: req.path,
    query: req.query,
    requestId: req.id || null,
    ...additionalData
  };
  
  // Remove sensitive data
  if (entry.body?.password) {
    entry.body.password = '[REDACTED]';
  }
  if (entry.body?.token) {
    entry.body.token = '[REDACTED]';
  }
  
  return entry;
};

/**
 * Audit middleware for automatic request logging
 */
const auditMiddleware = (options = {}) => {
  const {
    excludePaths = ['/health', '/metrics', '/favicon.ico'],
    includeBody = false,
    includeResponse = false
  } = options;
  
  return async (req, res, next) => {
    // Skip excluded paths
    if (excludePaths.some(path => req.path.startsWith(path))) {
      return next();
    }
    
    // Capture response data if needed
    if (includeResponse) {
      const originalSend = res.send;
      res.send = function(data) {
        res.responseBody = data;
        originalSend.call(this, data);
      };
    }
    
    // Log request
    const startTime = Date.now();
    
    res.on('finish', async () => {
      const duration = Date.now() - startTime;
      
      // Determine event type based on path and method
      let event = AUDIT_EVENTS.DATA_ACCESSED;
      let severity = AUDIT_SEVERITY.INFO;
      
      // Map specific routes to audit events
      if (req.path.includes('/sessions') && req.method === 'POST') {
        event = AUDIT_EVENTS.SESSION_CREATED;
      } else if (req.path.includes('/sessions') && req.method === 'DELETE') {
        event = AUDIT_EVENTS.SESSION_DELETED;
      } else if (req.path.includes('/messages') && req.method === 'POST') {
        event = AUDIT_EVENTS.MESSAGE_SENT;
      } else if (req.path.includes('/login')) {
        event = res.statusCode === 200 ? AUDIT_EVENTS.AUTH_LOGIN_SUCCESS : AUDIT_EVENTS.AUTH_LOGIN_FAILED;
        severity = res.statusCode === 200 ? AUDIT_SEVERITY.INFO : AUDIT_SEVERITY.WARNING;
      }
      
      // Set severity based on status code
      if (res.statusCode >= 500) {
        severity = AUDIT_SEVERITY.ERROR;
      } else if (res.statusCode >= 400) {
        severity = AUDIT_SEVERITY.WARNING;
      }
      
      const auditData = {
        severity,
        statusCode: res.statusCode,
        duration,
        body: includeBody ? req.body : undefined,
        response: includeResponse ? res.responseBody : undefined
      };
      
      const entry = createAuditEntry(event, req, auditData);
      await auditLogger.log(entry);
    });
    
    next();
  };
};

/**
 * Log specific audit event
 */
const logAuditEvent = async (event, req, additionalData = {}) => {
  const entry = createAuditEntry(event, req, additionalData);
  return await auditLogger.log(entry);
};

/**
 * Log security event
 */
const logSecurityEvent = async (event, req, details) => {
  const entry = createAuditEntry(event, req, {
    severity: AUDIT_SEVERITY.WARNING,
    securityDetails: details
  });
  return await auditLogger.log(entry);
};

/**
 * Log critical event
 */
const logCriticalEvent = async (event, req, details) => {
  const entry = createAuditEntry(event, req, {
    severity: AUDIT_SEVERITY.CRITICAL,
    criticalDetails: details
  });
  return await auditLogger.log(entry);
};

/**
 * Query audit logs
 */
const queryAuditLogs = async (filters) => {
  return await auditLogger.query(filters);
};

/**
 * Get audit statistics
 */
const getAuditStats = async (startDate, endDate) => {
  const logs = await queryAuditLogs({ startDate, endDate });
  
  const stats = {
    total: logs.length,
    byEvent: {},
    bySeverity: {},
    byUser: {},
    byHour: {},
    topPaths: {},
    errors: 0,
    warnings: 0
  };
  
  logs.forEach(log => {
    // Count by event
    stats.byEvent[log.event] = (stats.byEvent[log.event] || 0) + 1;
    
    // Count by severity
    stats.bySeverity[log.severity] = (stats.bySeverity[log.severity] || 0) + 1;
    
    // Count by user
    stats.byUser[log.userId] = (stats.byUser[log.userId] || 0) + 1;
    
    // Count by hour
    const hour = new Date(log.timestamp).getHours();
    stats.byHour[hour] = (stats.byHour[hour] || 0) + 1;
    
    // Count paths
    stats.topPaths[log.path] = (stats.topPaths[log.path] || 0) + 1;
    
    // Count errors and warnings
    if (log.severity === AUDIT_SEVERITY.ERROR) stats.errors++;
    if (log.severity === AUDIT_SEVERITY.WARNING) stats.warnings++;
  });
  
  // Sort top paths
  stats.topPaths = Object.entries(stats.topPaths)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .reduce((obj, [key, val]) => ({ ...obj, [key]: val }), {});
  
  return stats;
};

export {
  AUDIT_EVENTS,
  AUDIT_SEVERITY,
  auditMiddleware,
  logAuditEvent,
  logSecurityEvent,
  logCriticalEvent,
  queryAuditLogs,
  getAuditStats,
  auditLogger
};
