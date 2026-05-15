import express from 'express';
import { upsertCall } from '../controllers/internalCallController.js';
import { lookupAgents } from '../controllers/internalAgentController.js';
import { listScorecards, getScorecard } from '../controllers/internalScorecardController.js';
import { submitCallResult } from '../controllers/internalCallResultController.js';
import { getUserProfile, canUploadFor } from '../controllers/internalUserController.js';
import { verifyInternalSecret } from '../middleware/internalAuth.js';

const router = express.Router();

/**
 * Internal API routes (for M1 ingestion service + AI scoring service).
 * All routes require INTERNAL_SECRET Bearer token + workspaceId in body/query.
 *
 * NOT EXPOSED TO FRONTEND. Service-to-service only.
 */

// ---- Calls ----
// POST /internal/calls/upsert        — M1 creates/updates Call after ingest
// POST /internal/calls/:callId/result — AI service posts back transcript+score
router.post('/calls/upsert', verifyInternalSecret, upsertCall);
router.post('/calls/:callId/result', verifyInternalSecret, submitCallResult);

// ---- Agent mapping ----
// GET /internal/agents — M1's lookup for Exotel/Twilio agent identifier resolution
router.get('/agents', verifyInternalSecret, lookupAgents);

// ---- Scorecards ----
// GET /internal/scorecards            — M1 picks scorecard to attach by callType
// GET /internal/scorecards/:id        — AI service fetches full definition
router.get('/scorecards', verifyInternalSecret, listScorecards);
router.get('/scorecards/:scorecardId', verifyInternalSecret, getScorecard);

// ---- Users (RBAC checks for M1 upload service) ----
// GET  /internal/users/:userId/profile     — fresh role + team membership
// POST /internal/users/can-upload-for      — "can uploader X act on behalf of agent Y?"
router.get('/users/:userId/profile', verifyInternalSecret, getUserProfile);
router.post('/users/can-upload-for', verifyInternalSecret, canUploadFor);

export default router;
