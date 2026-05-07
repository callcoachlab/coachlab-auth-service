import express from 'express';
import { getMe, updateMe, changePassword } from '../controllers/meController.js';
import { authMiddleware, workspaceMiddleware } from '../middleware/auth.js';
import { csrfProtection } from '../middleware/csrf.js';
import { validateRequest } from '../middleware/validation.js';
import { updateMeSchema, changePasswordSchema } from '../validators/schemas.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

router.use(authMiddleware, workspaceMiddleware);

// GET /me — current user + workspace + permissions + teams
router.get('/', asyncHandler(getMe));

// PATCH /me — update own profile (name)
router.patch(
  '/',
  csrfProtection,
  validateRequest(updateMeSchema),
  asyncHandler(updateMe)
);

// POST /me/change-password — change own password (invalidates all sessions)
router.post(
  '/change-password',
  csrfProtection,
  validateRequest(changePasswordSchema),
  asyncHandler(changePassword)
);

export default router;
