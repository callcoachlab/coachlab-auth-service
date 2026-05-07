import express from 'express';
import {
  setupWorkspace,
  getMyWorkspace,
  updateMyWorkspace,
} from '../controllers/workspaceController.js';
import { validateRequest } from '../middleware/validation.js';
import { authMiddleware, requireRole, workspaceMiddleware } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import { setupTokenMiddleware } from '../middleware/setupToken.js';
import { setupWorkspaceSchema, updateWorkspaceSchema } from '../validators/schemas.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

// POST /workspaces/setup — completes onboarding for a verified user.
// Authorization: Bearer <setupToken>
router.post(
  '/setup',
  setupTokenMiddleware,
  validateRequest(setupWorkspaceSchema),
  asyncHandler(setupWorkspace)
);

// GET /workspaces/me — current workspace for the authed user
router.get('/me', authMiddleware, workspaceMiddleware, asyncHandler(getMyWorkspace));

// PATCH /workspaces/me — admin only: rename workspace, change timezone / languages
router.patch(
  '/me',
  authMiddleware,
  workspaceMiddleware,
  requireRole('ADMIN'),
  csrfProtection,
  validateRequest(updateWorkspaceSchema),
  asyncHandler(updateMyWorkspace)
);

export default router;
