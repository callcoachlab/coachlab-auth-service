import { verifyAccessToken } from '../utils/token.js';
import { User } from '../models/User.js';
import { Workspace } from '../models/Workspace.js';
import { createAppError, isAppError, ErrorCodes } from '../utils/errors.js';
import { logger } from '../config/logger.js';

export async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw createAppError('Missing or invalid authorization header', 401, ErrorCodes.UNAUTHORIZED);
    }

    const token = authHeader.substring(7); // Remove "Bearer " prefix
  
    const decoded = verifyAccessToken(token);

    if (!decoded) {
      throw createAppError('Invalid or expired token', 401, ErrorCodes.TOKEN_INVALID);
    }
   

    // Fetch user to verify status and token validity
    const user = await User.findById(decoded.userId).active();
    if (!user) {
      throw createAppError('User not found or disabled', 401, ErrorCodes.USER_NOT_FOUND);
    }

    if (user.status === 'DISABLED') {
      throw createAppError('Account has been disabled', 403, ErrorCodes.USER_DISABLED);
    }

    if (user.status !== 'ACTIVE' || !user.workspaceId) {
      throw createAppError('Account onboarding incomplete', 403, ErrorCodes.UNAUTHORIZED);
    }

    // Verify token hasn't been revoked (e.g., after password reset)
    if (!user.isTokenValid(decoded.iat)) {
      throw createAppError('Token has been revoked', 401, ErrorCodes.TOKEN_INVALID);
    }

    req.user = user;
    req.workspaceId = decoded.workspaceId;

    next();
  } catch (error) {
    if (isAppError(error)) {
      return res.status(error.statusCode).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    logger.error(error);
    res.status(500).json({
      success: false,
      error: {
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      },
    });
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: {
          code: ErrorCodes.UNAUTHORIZED,
          message: 'Authentication required',
        },
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: {
          code: ErrorCodes.FORBIDDEN,
          message: 'Insufficient permissions',
        },
      });
    }

    next();
  };
}

export async function workspaceMiddleware(req, res, next) {
  try {
    console.log("req.workspaceId-");
    console.log(req.workspaceId);
    if (!req.workspaceId) {
      throw createAppError('Workspace ID not found', 400, ErrorCodes.WORKSPACE_NOT_FOUND);
    }

    const workspace = await Workspace.findById(req.workspaceId).active();
    if (!workspace) {
      throw createAppError('Workspace not found', 404, ErrorCodes.WORKSPACE_NOT_FOUND);
    }

    req.workspace = workspace;
    console.log("req.workspace-");
    console.log(req.workspace);
    next();
  } catch (error) {
    if (isAppError(error)) {
      return res.status(error.statusCode).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    logger.error(error);
    res.status(500).json({
      success: false,
      error: {
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      },
    });
  }
}
