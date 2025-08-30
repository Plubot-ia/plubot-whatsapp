import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import logger from '../utils/logger.js';

class ErrorTrackingService {
  constructor() {
    this.initialized = false;
    this.environment = process.env.NODE_ENV || 'development';
    this.dsn = process.env.SENTRY_DSN;
    
    if (this.dsn) {
      this.initialize();
    } else {
      logger.warn('⚠️ Sentry DSN not configured, error tracking disabled');
    }
  }

  initialize() {
    try {
      Sentry.init({
        dsn: this.dsn,
        environment: this.environment,
        
        // Integrations
        integrations: [
          // HTTP integration
          new Sentry.Integrations.Http({ tracing: true }),
          
          // Express integration
          new Sentry.Integrations.Express({
            app: true,
            router: true
          }),
          
          // Profiling
          nodeProfilingIntegration(),
          
          // Console breadcrumbs
          new Sentry.Integrations.Console(),
          
          // Context lines
          new Sentry.Integrations.ContextLines(),
          
          // Linked errors
          new Sentry.Integrations.LinkedErrors(),
          
          // Modules
          new Sentry.Integrations.Modules(),
          
          // Request data
          new Sentry.Integrations.RequestData({
            include: {
              cookies: false,
              data: true,
              headers: true,
              ip: true,
              query_string: true,
              url: true,
              user: true
            }
          })
        ],
        
        // Performance Monitoring
        tracesSampleRate: this.environment === 'production' ? 0.1 : 1.0,
        profilesSampleRate: this.environment === 'production' ? 0.1 : 1.0,
        
        // Release tracking
        release: process.env.SENTRY_RELEASE || process.env.npm_package_version,
        
        // Server name
        serverName: process.env.SERVER_NAME || 'whatsapp-service',
        
        // Sample rate
        sampleRate: this.environment === 'production' ? 0.25 : 1.0,
        
        // Attach stack trace
        attachStacktrace: true,
        
        // Auto session tracking
        autoSessionTracking: true,
        
        // Max breadcrumbs
        maxBreadcrumbs: 50,
        
        // Debug
        debug: this.environment === 'development',
        
        // Before send hook
        beforeSend: (event, hint) => {
          // Filtrar información sensible
          if (event.request) {
            // Eliminar headers sensibles
            const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key'];
            sensitiveHeaders.forEach(header => {
              if (event.request.headers?.[header]) {
                event.request.headers[header] = '[REDACTED]';
              }
            });
            
            // Eliminar datos sensibles del body
            if (event.request.data) {
              this.sanitizeData(event.request.data);
            }
          }
          
          // Filtrar errores que no queremos reportar
          const error = hint.originalException;
          if (error && this.shouldIgnoreError(error)) {
            return null;
          }
          
          // Agregar contexto adicional
          event.tags = {
            ...event.tags,
            worker_id: process.env.WORKER_ID || 'master',
            cluster_mode: process.env.CLUSTER_MODE === 'true'
          };
          
          return event;
        },
        
        // Before breadcrumb hook
        beforeBreadcrumb: (breadcrumb, hint) => {
          // Filtrar breadcrumbs sensibles
          if (breadcrumb.category === 'console' && breadcrumb.level === 'debug') {
            return null;
          }
          
          // Sanitizar datos en breadcrumbs
          if (breadcrumb.data) {
            this.sanitizeData(breadcrumb.data);
          }
          
          return breadcrumb;
        },
        
        // Ignore errors
        ignoreErrors: [
          // Errores de red comunes
          'NetworkError',
          'Failed to fetch',
          'Load failed',
          
          // Errores de WebSocket
          'WebSocket is already in CLOSING or CLOSED state',
          
          // Errores de navegador
          'Non-Error promise rejection captured',
          
          // Errores de WhatsApp Web
          'Evaluation failed',
          'Protocol error',
          
          // Rate limiting
          'Too many requests'
        ],
        
        // Ignore transactions
        ignoreTransactions: [
          '/health',
          '/health/live',
          '/health/ready',
          '/metrics',
          '/favicon.ico'
        ]
      });
      
      this.initialized = true;
      logger.info('🎯 Sentry error tracking initialized', {
        environment: this.environment,
        release: process.env.SENTRY_RELEASE
      });
      
    } catch (error) {
      logger.error('Failed to initialize Sentry:', error);
    }
  }

  // Capturar excepción
  captureException(error, context = {}) {
    if (!this.initialized) {
      logger.error('Error (Sentry not initialized):', error);
      return null;
    }
    
    // Agregar contexto
    if (context.user) {
      Sentry.setUser(context.user);
    }
    
    if (context.tags) {
      Sentry.setTags(context.tags);
    }
    
    if (context.extra) {
      Sentry.setExtras(context.extra);
    }
    
    if (context.level) {
      Sentry.setLevel(context.level);
    }
    
    // Capturar la excepción
    const eventId = Sentry.captureException(error, {
      contexts: context.contexts,
      fingerprint: context.fingerprint
    });
    
    logger.error('Exception captured in Sentry', {
      eventId,
      error: error.message
    });
    
    return eventId;
  }

  // Capturar mensaje
  captureMessage(message, level = 'info', context = {}) {
    if (!this.initialized) {
      logger.log(level, `Message (Sentry not initialized): ${message}`);
      return null;
    }
    
    // Agregar contexto
    if (context.tags) {
      Sentry.setTags(context.tags);
    }
    
    if (context.extra) {
      Sentry.setExtras(context.extra);
    }
    
    const eventId = Sentry.captureMessage(message, level);
    
    logger.log(level, 'Message captured in Sentry', {
      eventId,
      message
    });
    
    return eventId;
  }

  // Agregar breadcrumb
  addBreadcrumb(breadcrumb) {
    if (!this.initialized) return;
    
    Sentry.addBreadcrumb({
      timestamp: Date.now() / 1000,
      ...breadcrumb
    });
  }

  // Crear transacción
  startTransaction(name, op = 'http.server') {
    if (!this.initialized) return null;
    
    return Sentry.startTransaction({
      name,
      op,
      tags: {
        worker_id: process.env.WORKER_ID || 'master'
      }
    });
  }

  // Configurar usuario
  setUser(user) {
    if (!this.initialized) return;
    
    Sentry.setUser({
      id: user.id,
      username: user.username,
      email: user.email,
      ip_address: user.ip,
      segment: user.tier || 'free'
    });
  }

  // Limpiar usuario
  clearUser() {
    if (!this.initialized) return;
    Sentry.setUser(null);
  }

  // Configurar contexto
  setContext(key, context) {
    if (!this.initialized) return;
    Sentry.setContext(key, context);
  }

  // Configurar tags
  setTags(tags) {
    if (!this.initialized) return;
    Sentry.setTags(tags);
  }

  // Configurar extras
  setExtras(extras) {
    if (!this.initialized) return;
    Sentry.setExtras(extras);
  }

  // Configurar nivel
  setLevel(level) {
    if (!this.initialized) return;
    Sentry.setLevel(level);
  }

  // Crear scope aislado
  withScope(callback) {
    if (!this.initialized) {
      callback({});
      return;
    }
    
    Sentry.withScope(callback);
  }

  // Flush - enviar todos los eventos pendientes
  async flush(timeout = 2000) {
    if (!this.initialized) return true;
    
    try {
      const result = await Sentry.flush(timeout);
      logger.info('Sentry events flushed', { result });
      return result;
    } catch (error) {
      logger.error('Failed to flush Sentry events:', error);
      return false;
    }
  }

  // Close - cerrar el cliente
  async close(timeout = 2000) {
    if (!this.initialized) return true;
    
    try {
      const result = await Sentry.close(timeout);
      logger.info('Sentry client closed', { result });
      this.initialized = false;
      return result;
    } catch (error) {
      logger.error('Failed to close Sentry client:', error);
      return false;
    }
  }

  // Middleware para Express
  requestHandler() {
    if (!this.initialized) {
      return (req, res, next) => next();
    }
    
    return Sentry.Handlers.requestHandler({
      serverName: false,
      user: ['id', 'username', 'email'],
      ip: true,
      request: ['headers', 'method', 'url', 'query_string'],
      transaction: 'methodPath'
    });
  }

  // Middleware para tracing
  tracingHandler() {
    if (!this.initialized) {
      return (req, res, next) => next();
    }
    
    return Sentry.Handlers.tracingHandler();
  }

  // Error handler para Express
  errorHandler() {
    if (!this.initialized) {
      return (err, req, res, next) => next(err);
    }
    
    return Sentry.Handlers.errorHandler({
      shouldHandleError: (error) => {
        // Capturar solo errores 500+
        return !error.statusCode || error.statusCode >= 500;
      }
    });
  }

  // Sanitizar datos sensibles
  sanitizeData(data) {
    if (!data || typeof data !== 'object') return;
    
    const sensitiveKeys = [
      'password',
      'token',
      'secret',
      'api_key',
      'apiKey',
      'auth',
      'authorization',
      'cookie',
      'session',
      'credit_card',
      'creditCard',
      'ssn',
      'pin'
    ];
    
    const sanitize = (obj) => {
      for (const key in obj) {
        const lowerKey = key.toLowerCase();
        
        if (sensitiveKeys.some(sensitive => lowerKey.includes(sensitive))) {
          obj[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          sanitize(obj[key]);
        }
      }
    };
    
    sanitize(data);
  }

  // Verificar si se debe ignorar el error
  shouldIgnoreError(error) {
    // Ignorar errores de validación
    if (error.name === 'ValidationError') return true;
    
    // Ignorar errores 4xx
    if (error.statusCode && error.statusCode < 500) return true;
    
    // Ignorar errores de rate limiting
    if (error.message?.includes('rate limit')) return true;
    
    // Ignorar errores de autenticación
    if (error.message?.includes('unauthorized')) return true;
    
    return false;
  }

  // Capturar errores no manejados
  setupGlobalHandlers() {
    if (!this.initialized) return;
    
    // Unhandled rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection:', reason);
      
      this.captureException(reason, {
        tags: {
          type: 'unhandledRejection'
        },
        extra: {
          promise: promise.toString()
        },
        level: 'error'
      });
    });
    
    // Uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      
      this.captureException(error, {
        tags: {
          type: 'uncaughtException'
        },
        level: 'fatal'
      });
      
      // Flush y salir
      this.flush(5000).then(() => {
        process.exit(1);
      });
    });
    
    // Warning events
    process.on('warning', (warning) => {
      logger.warn('Process Warning:', warning);
      
      this.captureMessage(warning.message, 'warning', {
        tags: {
          type: 'processWarning',
          name: warning.name
        },
        extra: {
          stack: warning.stack
        }
      });
    });
  }
}

// Singleton
let errorTrackingInstance = null;

export function getErrorTracking() {
  if (!errorTrackingInstance) {
    errorTrackingInstance = new ErrorTrackingService();
  }
  return errorTrackingInstance;
}

export default ErrorTrackingService;
