import express from 'express';
import { createTeam, getTeams, updateTeam, deleteTeam } from '../controllers/teamController.js';
import { validateRequest, validateQuery } from '../middleware/validation.js';
import { authMiddleware, requireRole, workspaceMiddleware } from '../middleware/auth.js';
import { createTeamSchema, updateTeamSchema, paginationSchema } from '../validators/schemas.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

// All team routes require auth and workspace.
// CSRF is not applied here: these routes authenticate via the Authorization
// header only and never read req.cookies. A cross-origin attacker cannot set
// custom headers without a CORS preflight, so CSRF is structurally impossible.
router.use(authMiddleware, workspaceMiddleware);

// POST /teams — Create team (ADMIN/MANAGER only)
router.post(
  '/',
  requireRole('ADMIN', 'MANAGER'),
  validateRequest(createTeamSchema),
  asyncHandler(createTeam)
);

// GET /teams — Get teams
router.get('/', validateQuery(paginationSchema), asyncHandler(getTeams));

// PATCH /teams/:teamId — Update team (ADMIN/MANAGER only)
router.patch(
  '/:teamId',
  requireRole('ADMIN', 'MANAGER'),
  validateRequest(updateTeamSchema),
  asyncHandler(updateTeam)
);

// DELETE /teams/:teamId — Delete team (ADMIN only)
router.delete('/:teamId', requireRole('ADMIN'), asyncHandler(deleteTeam));

export default router;
