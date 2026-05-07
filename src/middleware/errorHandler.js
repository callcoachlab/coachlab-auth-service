import { isAppError, ErrorCodes } from '../utils/errors.js';
import { logger } from '../config/logger.js';

export function globalErrorHandler(err, req, res, next) {
  logger.error({ err }, 'Unhandled error');

  if (isAppError(err)) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
    });
  }

  // MongoDB validation errors
  if (err.name === 'ValidationError') {
    const errors = Object.entries(err.errors).map(([field, error]) => ({
      path: field,
      message: error.message,
    }));

    return res.status(400).json({
      success: false,
      error: {
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Database validation failed',
        details: errors,
      },
    });
  }

  // MongoDB duplicate key errors
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return res.status(400).json({
      success: false,
      error: {
        code: ErrorCodes.VALIDATION_ERROR,
        message: `${field} already exists`,
        details: [{ path: field, message: `${field} already exists` }],
      },
    });
  }

  // Default server error
  res.status(500).json({
    success: false,
    error: {
      code: ErrorCodes.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    },
  });
}

export function asyncHandler(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}
