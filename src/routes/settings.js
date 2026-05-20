import express from 'express';
import { getSettings, updatePermissions } from '../controllers/settingsController.js';
import { validateRequest } from '../middleware/validation.js';
import { authMiddleware, requireRole, workspaceMiddleware } from '../middleware/auth.js';
import { updatePermissionsSchema } from '../validators/schemas.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

// CSRF not applied: bearer-token auth only. See routes/teams.js for rationale.
router.use(authMiddleware, workspaceMiddleware);

// GET /settings — Get settings
router.get('/', asyncHandler(getSettings));

// PATCH /settings/permissions — Update permissions (ADMIN only)
router.patch(
  '/permissions',
  requireRole('ADMIN'),
  validateRequest(updatePermissionsSchema),
  asyncHandler(updatePermissions)
);

export default router;
