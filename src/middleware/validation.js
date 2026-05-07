import { ErrorCodes } from '../utils/errors.js';
import { logger } from '../config/logger.js';

export function validateRequest(schema) {
  return (req, res, next) => {
    try {
      // Validate against the request body
      const validated = schema.parse(req.body);
      req.validatedData = validated;
      next();
    } catch (error) {
      // Zod errors
      if (error.errors) {
        const formattedErrors = error.errors.map(err => ({
          path: err.path.join('.'),
          message: err.message,
        }));

        return res.status(400).json({
          success: false,
          error: {
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Validation failed',
            details: formattedErrors,
          },
        });
      }

      logger.error(error);
      res.status(400).json({
        success: false,
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Validation failed',
        },
      });
    }
  };
}

export function validateQuery(schema) {
  return (req, res, next) => {
    try {
      const validated = schema.parse(req.query);
      req.validatedQuery = validated;
      next();
    } catch (error) {
      if (error.errors) {
        const formattedErrors = error.errors.map(err => ({
          path: err.path.join('.'),
          message: err.message,
        }));

        return res.status(400).json({
          success: false,
          error: {
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Query validation failed',
            details: formattedErrors,
          },
        });
      }

      logger.error(error);
      res.status(400).json({
        success: false,
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message: 'Query validation failed',
        },
      });
    }
  };
}
