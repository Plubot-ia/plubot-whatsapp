import jwt from 'jsonwebtoken';
import logger from '../../core/utils/logger.js';

/**
 * Role-Based Access Control (RBAC) Middleware
 * Defines roles and their permissions
 */

// Define roles hierarchy
const ROLES = {
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  MANAGER: 'manager',
  USER: 'user',
  SERVICE: 'service',
  GUEST: 'guest'
};

// Define permissions for each role
const PERMISSIONS = {
  [ROLES.SUPER_ADMIN]: [
    'sessions:*',
    'messages:*',
    'users:*',
    'system:*',
    'analytics:*',
    'audit:*'
  ],
  [ROLES.ADMIN]: [
    'sessions:create',
    'sessions:read',
    'sessions:update',
    'sessions:delete',
    'messages:*',
    'users:read',
    'users:update',
    'analytics:read',
    'audit:read'
  ],
  [ROLES.MANAGER]: [
    'sessions:create',
    'sessions:read',
    'sessions:update',
    'messages:*',
    'users:read',
    'analytics:read'
  ],
  [ROLES.USER]: [
    'sessions:create:own',
    'sessions:read:own',
    'sessions:update:own',
    'sessions:delete:own',
    'messages:send:own',
    'messages:read:own'
  ],
  [ROLES.SERVICE]: [
    'sessions:read',
    'messages:send',
    'messages:read',
    'webhooks:send'
  ],
  [ROLES.GUEST]: [
    'sessions:read:limited',
    'health:read'
  ]
};

// Resource ownership check
const isResourceOwner = (user, resource) => {
  return resource.userId === user.id || resource.ownerId === user.id;
};

// Permission check function
const hasPermission = (userRole, requiredPermission, user, resource) => {
  const rolePermissions = PERMISSIONS[userRole] || [];
  
  // Check for wildcard permissions
  const [resourceType, action, scope] = requiredPermission.split(':');
  
  // Check exact permission
  if (rolePermissions.includes(requiredPermission)) {
    // If scope is 'own', verify ownership
    if (scope === 'own' && resource) {
      return isResourceOwner(user, resource);
    }
    return true;
  }
  
  // Check wildcard permissions
  const wildcardPermission = `${resourceType}:*`;
  if (rolePermissions.includes(wildcardPermission)) {
    return true;
  }
  
  // Check if user has permission without scope restriction
  const permissionWithoutScope = `${resourceType}:${action}`;
  if (rolePermissions.includes(permissionWithoutScope)) {
    return true;
  }
  
  // Check for own resource permissions
  const ownPermission = `${resourceType}:${action}:own`;
  if (rolePermissions.includes(ownPermission) && resource) {
    return isResourceOwner(user, resource);
  }
  
  return false;
};

/**
 * Middleware to check if user has required role
 */
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    try {
      const user = req.user;
      
      if (!user) {
        logger.warn('Access denied: No user information');
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }
      
      if (!user.role) {
        logger.warn(`Access denied: User ${user.id} has no role assigned`);
        return res.status(403).json({
          success: false,
          error: 'No role assigned to user'
        });
      }
      
      if (!allowedRoles.includes(user.role)) {
        logger.warn(`Access denied: User ${user.id} with role ${user.role} tried to access resource requiring roles: ${allowedRoles.join(', ')}`);
        return res.status(403).json({
          success: false,
          error: 'Insufficient privileges'
        });
      }
      
      logger.info(`Access granted: User ${user.id} with role ${user.role} accessing ${req.method} ${req.path}`);
      next();
    } catch (error) {
      logger.error('Error in role check middleware:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  };
};

/**
 * Middleware to check if user has required permission
 */
const requirePermission = (requiredPermission) => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      
      if (!user) {
        logger.warn('Access denied: No user information');
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }
      
      // Super admin bypass
      if (user.role === ROLES.SUPER_ADMIN) {
        next();
        return;
      }
      
      // Get resource if needed for ownership check
      let resource = null;
      if (requiredPermission.includes(':own')) {
        // Extract resource from request (customize based on your needs)
        resource = {
          userId: req.params.userId || req.body.userId,
          ownerId: req.params.ownerId || req.body.ownerId
        };
      }
      
      if (!hasPermission(user.role, requiredPermission, user, resource)) {
        logger.warn(`Permission denied: User ${user.id} with role ${user.role} lacks permission: ${requiredPermission}`);
        return res.status(403).json({
          success: false,
          error: 'Insufficient permissions'
        });
      }
      
      logger.info(`Permission granted: User ${user.id} has permission: ${requiredPermission}`);
      next();
    } catch (error) {
      logger.error('Error in permission check middleware:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  };
};

/**
 * Middleware to check multiple permissions (OR logic)
 */
const requireAnyPermission = (...permissions) => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }
      
      // Super admin bypass
      if (user.role === ROLES.SUPER_ADMIN) {
        next();
        return;
      }
      
      for (const permission of permissions) {
        let resource = null;
        if (permission.includes(':own')) {
          resource = {
            userId: req.params.userId || req.body.userId,
            ownerId: req.params.ownerId || req.body.ownerId
          };
        }
        
        if (hasPermission(user.role, permission, user, resource)) {
          logger.info(`Permission granted: User ${user.id} has permission: ${permission}`);
          next();
          return;
        }
      }
      
      logger.warn(`Permission denied: User ${user.id} lacks any of required permissions: ${permissions.join(', ')}`);
      return res.status(403).json({
        success: false,
        error: 'Insufficient permissions'
      });
    } catch (error) {
      logger.error('Error in permission check middleware:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  };
};

/**
 * Middleware to check all permissions (AND logic)
 */
const requireAllPermissions = (...permissions) => {
  return async (req, res, next) => {
    try {
      const user = req.user;
      
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required'
        });
      }
      
      // Super admin bypass
      if (user.role === ROLES.SUPER_ADMIN) {
        next();
        return;
      }
      
      for (const permission of permissions) {
        let resource = null;
        if (permission.includes(':own')) {
          resource = {
            userId: req.params.userId || req.body.userId,
            ownerId: req.params.ownerId || req.body.ownerId
          };
        }
        
        if (!hasPermission(user.role, permission, user, resource)) {
          logger.warn(`Permission denied: User ${user.id} lacks permission: ${permission}`);
          return res.status(403).json({
            success: false,
            error: 'Insufficient permissions'
          });
        }
      }
      
      logger.info(`All permissions granted: User ${user.id} has permissions: ${permissions.join(', ')}`);
      next();
    } catch (error) {
      logger.error('Error in permission check middleware:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal server error'
      });
    }
  };
};

export {
  ROLES,
  PERMISSIONS,
  requireRole,
  requirePermission,
  requireAnyPermission,
  requireAllPermissions,
  hasPermission,
  isResourceOwner
};
