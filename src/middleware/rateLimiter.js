import rateLimit from 'express-rate-limit';
import { config } from '../config/index.js';

function buildLimiter({ max, code, message, windowMs = config.rateLimit.windowMs }) {
  return rateLimit({
    windowMs,
    max,
    message: { success: false, error: { code, message } },
    standardHeaders: false,
    legacyHeaders: false,
  });
}

export const loginLimiter = buildLimiter({
  max: config.rateLimit.login,
  code: 'RATE_LIMIT_EXCEEDED',
  message: 'Too many login attempts, please try again later',
});

export const inviteLimiter = buildLimiter({
  max: config.rateLimit.invite,
  code: 'RATE_LIMIT_EXCEEDED',
  message: 'Too many invite requests, please try again later',
});

export const refreshLimiter = buildLimiter({
  max: config.rateLimit.refresh,
  code: 'RATE_LIMIT_EXCEEDED',
  message: 'Too many refresh requests, please try again later',
});

// Registration: aggressive — bots will hammer this if it's open.
export const registerLimiter = buildLimiter({
  max: config.rateLimit.register,
  windowMs: 60 * 60 * 1000, // 1 hour window
  code: 'RATE_LIMIT_EXCEEDED',
  message: 'Too many registration attempts. Please try again in an hour.',
});

// Resend verification email
export const resendVerificationLimiter = buildLimiter({
  max: config.rateLimit.resend,
  windowMs: 60 * 60 * 1000,
  code: 'RATE_LIMIT_EXCEEDED',
  message: 'Too many verification email requests. Please try again in an hour.',
});

// Forgot password
export const forgotPasswordLimiter = buildLimiter({
  max: config.rateLimit.forgotPassword,
  windowMs: 60 * 60 * 1000,
  code: 'RATE_LIMIT_EXCEEDED',
  message: 'Too many password reset requests. Please try again in an hour.',
});

// Verify-email link clicking (defends against token enumeration)
export const verifyEmailLimiter = buildLimiter({
  max: 30,
  code: 'RATE_LIMIT_EXCEEDED',
  message: 'Too many verification attempts, please try again later',
});

// Accept-invite — public endpoint that creates a user, so rate-limit hard.
export const acceptInviteLimiter = buildLimiter({
  max: 10,
  windowMs: 60 * 60 * 1000,
  code: 'RATE_LIMIT_EXCEEDED',
  message: 'Too many invite acceptance attempts, please try again later',
});
