import express from 'express';
import {
  login,
  logout,
  refresh,
  acceptInvite,
  register,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
} from '../controllers/authController.js';
import { validateRequest } from '../middleware/validation.js';
import { authMiddleware } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import {
  loginLimiter,
  refreshLimiter,
  registerLimiter,
  resendVerificationLimiter,
  forgotPasswordLimiter,
  verifyEmailLimiter,
  acceptInviteLimiter,
} from '../middleware/rateLimiter.js';
import {
  loginSchema,
  acceptInviteSchema,
  registerSchema,
  verifyEmailSchema,
  resendVerificationSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../validators/schemas.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

// Account creation
router.post(
  '/register',
  registerLimiter,
  validateRequest(registerSchema),
  asyncHandler(register)
);

router.post(
  '/verify-email',
  verifyEmailLimiter,
  validateRequest(verifyEmailSchema),
  asyncHandler(verifyEmail)
);

// Convenience: GET form so users can land directly from the email link.
router.get('/verify-email', verifyEmailLimiter, asyncHandler(verifyEmail));

router.post(
  '/resend-verification',
  resendVerificationLimiter,
  validateRequest(resendVerificationSchema),
  asyncHandler(resendVerification)
);

// Login / logout / refresh
router.post(
  '/login',
  loginLimiter,
  validateRequest(loginSchema),
  asyncHandler(login)
);

router.post('/logout', authMiddleware, asyncHandler(logout));

// /auth/refresh is the only route that authenticates via the refreshToken
// cookie. Because the browser auto-sends cookies on cross-origin requests
// (SameSite=None in production for cross-domain frontend/backend), CSRF
// protection is required here.
router.post('/refresh', refreshLimiter, csrfProtection, asyncHandler(refresh));

// Password reset
router.post(
  '/forgot-password',
  forgotPasswordLimiter,
  validateRequest(forgotPasswordSchema),
  asyncHandler(forgotPassword)
);

router.post(
  '/reset-password',
  validateRequest(resetPasswordSchema),
  asyncHandler(resetPassword)
);

// Invite acceptance — public, since the invitee has no session yet.
// The invite token in the body is the credential.
router.post(
  '/accept-invite',
  acceptInviteLimiter,
  validateRequest(acceptInviteSchema),
  asyncHandler(acceptInvite)
);

export default router;
