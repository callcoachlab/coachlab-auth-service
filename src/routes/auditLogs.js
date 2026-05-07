import express from 'express';
import { getAuditLogs } from '../controllers/auditController.js';
import { validateQuery } from '../middleware/validation.js';
import { authMiddleware, requireRole, workspaceMiddleware } from '../middleware/auth.js';
import { auditLogsFiltersSchema } from '../validators/schemas.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

// All audit routes require auth, workspace, and ADMIN/MANAGER role
router.use(authMiddleware, workspaceMiddleware, requireRole('ADMIN', 'MANAGER'));

// GET /audit-logs — Get audit logs
router.get('/', validateQuery(auditLogsFiltersSchema), asyncHandler(getAuditLogs));

export default router;
