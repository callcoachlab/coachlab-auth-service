import express from 'express';
import {
  createInvites,
  getInvites,
  revokeInvite,
  resendInvite,
  previewInvite,
} from '../controllers/inviteController.js';
import { validateRequest, validateQuery } from '../middleware/validation.js';
import { authMiddleware, requireRole, workspaceMiddleware } from '../middleware/auth.js';
import { inviteLimiter, verifyEmailLimiter } from '../middleware/rateLimiter.js';
import { createInviteSchema, inviteFiltersSchema } from '../validators/schemas.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

// Public: GET /invites/preview?token=... — used by the frontend to render
// "You've been invited to {workspace}" before the user submits their password.
// Rate-limited to deter token enumeration.
router.get('/preview', verifyEmailLimiter, asyncHandler(previewInvite));

// All other invite routes are workspace-admin/manager only.
// CSRF not applied: bearer-token auth only. See routes/teams.js for rationale.
router.use(authMiddleware, workspaceMiddleware, requireRole('ADMIN', 'MANAGER'));

router.post(
  '/',
  inviteLimiter,
  validateRequest(createInviteSchema),
  asyncHandler(createInvites)
);

router.get('/', validateQuery(inviteFiltersSchema), asyncHandler(getInvites));

router.post('/:inviteId/revoke', asyncHandler(revokeInvite));

router.post('/:inviteId/resend', asyncHandler(resendInvite));

export default router;
