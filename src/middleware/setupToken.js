import { verifySetupToken } from '../utils/token.js';
import { User } from '../models/User.js';
import { createAppError, isAppError, ErrorCodes } from '../utils/errors.js';
import { logger } from '../config/logger.js';

// Middleware that authorizes the *one* endpoint a user can call between
// "email verified" and "workspace created": POST /workspaces/setup.
// It accepts the short-lived JWT issued by /auth/verify-email.
export async function setupTokenMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw createAppError(
        'Missing or invalid authorization header',
        401,
        ErrorCodes.UNAUTHORIZED
      );
    }

    const token = authHeader.substring(7);
    const decoded = verifySetupToken(token);
    if (!decoded) {
      throw createAppError(
        'Setup token is invalid or expired',
        401,
        ErrorCodes.SETUP_TOKEN_INVALID
      );
    }

    const user = await User.findById(decoded.userId).active();
    if (!user) {
      throw createAppError('User not found', 401, ErrorCodes.USER_NOT_FOUND);
    }

    if (user.status !== 'EMAIL_VERIFIED') {
      throw createAppError(
        'Account is not in workspace-setup state',
        403,
        ErrorCodes.SETUP_TOKEN_INVALID
      );
    }

    req.user = user;
    next();
  } catch (error) {
    if (isAppError(error)) {
      return res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
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
