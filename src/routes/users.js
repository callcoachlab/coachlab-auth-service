import express from 'express';
import {
  getUsers,
  updateUser,
  disableUser,
  enableUser,
} from '../controllers/userController.js';
import { validateRequest, validateQuery } from '../middleware/validation.js';
import { authMiddleware, requireRole, workspaceMiddleware } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import { updateUserSchema, userFiltersSchema } from '../validators/schemas.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

router.use(authMiddleware, workspaceMiddleware);

// GET /users — Both ADMIN and MANAGER can list members
router.get(
  '/',
  requireRole('ADMIN', 'MANAGER'),
  validateQuery(userFiltersSchema),
  asyncHandler(getUsers)
);

// PATCH /users/:userId — change role/teamIds/status
// MANAGER can edit AGENTs (controller enforces); ADMIN can edit anyone.
router.patch(
  '/:userId',
  requireRole('ADMIN', 'MANAGER'),
  csrfProtection,
  validateRequest(updateUserSchema),
  asyncHandler(updateUser)
);

// POST /users/:userId/disable — ADMIN/MANAGER (controller checks last-admin + role hierarchy)
router.post(
  '/:userId/disable',
  requireRole('ADMIN', 'MANAGER'),
  csrfProtection,
  asyncHandler(disableUser)
);

// POST /users/:userId/enable — re-enable a disabled user
router.post(
  '/:userId/enable',
  requireRole('ADMIN', 'MANAGER'),
  csrfProtection,
  asyncHandler(enableUser)
);

export default router;
