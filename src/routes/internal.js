import express from 'express';
import { upsertCall } from '../controllers/internalCallController.js';
import { verifyInternalSecret } from '../middleware/internalAuth.js';

const router = express.Router();

/**
 * Internal API routes (for M1 and M2 services)
 * All routes require INTERNAL_SECRET Bearer token
 */

/**
 * POST /internal/calls/upsert
 * Upsert a call from M1 ingestion service
 */
router.post('/calls/upsert', verifyInternalSecret, upsertCall);

export default router;
