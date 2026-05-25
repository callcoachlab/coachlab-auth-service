import { Scorecard } from '../models/Scorecard.js';
import { logger } from '../config/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

/**
 * GET /internal/scorecards?workspaceId=...&callType=...
 *
 * Returns all PUBLISHED scorecards for a workspace, optionally filtered by
 * call type (Inbound / Follow-up / Consult). Used by M1 to attach the
 * correct scorecardId + version to each Call record before handoff to the
 * AI scoring service.
 *
 * Per the v1 bible: M1 does NOT score. It only attaches the scorecard
 * reference. The AI service reads the scorecard separately when scoring.
 */
export const listScorecards = asyncHandler(async (req, res) => {
  const workspaceId = req.workspaceId;
  const { callType } = req.query;

  const query = {
    workspaceId,
    deletedAt: null,
    isPublished: true,
  };
  if (callType) query.callType = callType;

  const scorecards = await Scorecard.find(query)
    .select('_id name callType isPublished settings updatedAt')
    .sort({ updatedAt: -1 });

  logger.info({
    action: 'INTERNAL_SCORECARD_LIST',
    workspaceId,
    callType,
    count: scorecards.length,
  }, 'Internal scorecard list');

  res.json({
    success: true,
    data: {
      scorecards: scorecards.map((s) => ({
        id: s._id.toString(),
        name: s.name,
        callType: s.callType,
        isPublished: s.isPublished,
        updatedAt: s.updatedAt,
        // AI service can use updatedAt to decide whether to re-fetch full settings
      })),
    },
  });
});

/**
 * GET /internal/scorecards/:scorecardId?workspaceId=...
 *
 * Returns the full scorecard definition (sections, criteria, thresholds,
 * critical fails, etc.) — used by the AI scoring service when it dequeues
 * a scoring job. Workspace-scoped for safety.
 */
export const getScorecard = asyncHandler(async (req, res) => {
  const workspaceId = req.workspaceId;
  const { scorecardId } = req.params;

  const scorecard = await Scorecard.findOne({
    _id: scorecardId,
    workspaceId,
    deletedAt: null,
  });

  if (!scorecard) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'SCORECARD_NOT_FOUND',
        message: 'Scorecard does not exist in this workspace',
      },
    });
  }

  // `settings` carries the full scorecard definition: sections, criteria,
  // weights, thresholds, critical fail rules. Structure is owned by the
  // workspace admin who created the scorecard. AI service must treat it
  // as the authoritative contract for scoring this call type.
  res.json({
    success: true,
    data: {
      id: scorecard._id.toString(),
      name: scorecard.name,
      callType: scorecard.callType,
      isPublished: scorecard.isPublished,
      version: scorecard.updatedAt.getTime(), // epoch ms — AI can use for cache invalidation
      settings: scorecard.settings,
      updatedAt: scorecard.updatedAt,
    },
  });
});
