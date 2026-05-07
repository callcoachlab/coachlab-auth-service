import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { Workspace } from '../models/Workspace.js';

/**
 * Middleware: Verify INTERNAL_SECRET for service-to-service communication
 * Expected header: Authorization: Bearer {INTERNAL_SECRET}
 * Also extracts and validates workspaceId from request
 */
export const verifyInternalSecret = async (req, res, next) => {
  try {
    // Get Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      logger.warn({ ip: req.ip }, 'Missing Authorization header for internal request');
      return res.status(401).json({
        success: false,
        error: {
          code: 'MISSING_AUTHORIZATION',
          message: 'Missing Authorization header',
        },
      });
    }

    // Extract Bearer token
    const [scheme, token] = authHeader.split(' ');

    if (scheme !== 'Bearer' || !token) {
      logger.warn({ ip: req.ip }, 'Invalid Authorization scheme or missing token');
      return res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_AUTHORIZATION_SCHEME',
          message: 'Authorization header must be: Bearer {INTERNAL_SECRET}',
        },
      });
    }

    // Verify token matches INTERNAL_SECRET
    if (token !== config.internalSecret) {
      logger.warn({ ip: req.ip }, 'Invalid INTERNAL_SECRET provided');
      return res.status(403).json({
        success: false,
        error: {
          code: 'INVALID_INTERNAL_SECRET',
          message: 'Invalid service authentication token',
        },
      });
    }

    // Extract workspaceId from request body
    const workspaceId = req.body.workspaceId || req.query.workspaceId;

    if (!workspaceId) {
      logger.warn({ ip: req.ip }, 'Missing workspaceId in internal request');
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_WORKSPACE_ID',
          message: 'workspaceId is required in request body or query',
        },
      });
    }

    // Find workspace
    const workspace = await Workspace.findById(workspaceId);

    if (!workspace) {
      logger.warn({ workspaceId, ip: req.ip }, 'Workspace not found in internal request');
      return res.status(404).json({
        success: false,
        error: {
          code: 'WORKSPACE_NOT_FOUND',
          message: 'Workspace does not exist',
        },
      });
    }

    // Attach workspace and workspaceId to request for downstream handlers
    req.workspace = workspace;
    req.workspaceId = workspace._id;
    req.isInternal = true;

    next();
  } catch (error) {
    logger.error({
      error: error.message,
      ip: req.ip,
      stack: error.stack,
    }, 'Error in verifyInternalSecret middleware');

    res.status(500).json({
      success: false,
      error: {
        code: 'AUTH_ERROR',
        message: 'An error occurred during authentication',
      },
    });
  }
};
