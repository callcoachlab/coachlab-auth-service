import { Scorecard } from '../models/Scorecard.js';
import { logger } from '../config/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

/**
 * User-facing scorecard CRUD.
 *
 * All routes are JWT-authed and workspace-scoped via authMiddleware +
 * workspaceMiddleware. RBAC enforced at the route level: only ADMIN
 * and MANAGER can mutate; everyone can list.
 *
 * Names are case-insensitive unique within a workspace (enforced by a
 * collated partial-unique index on Scorecard). The frontend should
 * bind dropdowns to the `id`, not the `name` — names can be renamed.
 */

/**
 * POST /workspaces/me/scorecards
 * Body: { name, callType?, isPublished? }
 */
export const createScorecard = asyncHandler(async (req, res) => {
  const workspaceId = req.workspaceId;
  const { name, callType, isPublished } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PAYLOAD', message: 'name is required' },
    });
  }
  if (name.trim().length > 128) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PAYLOAD', message: 'name must be 128 characters or fewer' },
    });
  }

  try {
    const scorecard = await Scorecard.create({
      workspaceId,
      name: name.trim(),
      callType: callType?.trim() || null,
      isPublished: !!isPublished,
    });

    logger.info({
      action: 'SCORECARD_CREATED',
      workspaceId,
      scorecardId: scorecard._id,
      name: scorecard.name,
    });

    res.status(201).json({
      success: true,
      data: scorecardToJson(scorecard),
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'SCORECARD_NAME_TAKEN',
          message: `A scorecard named "${name.trim()}" already exists in this workspace`,
        },
      });
    }
    throw err;
  }
});

/**
 * GET /workspaces/me/scorecards?callType=&publishedOnly=
 * Lists active (non-deleted) scorecards in the workspace.
 */
export const listScorecards = asyncHandler(async (req, res) => {
  const workspaceId = req.workspaceId;
  const { callType, publishedOnly } = req.query;

  const query = { workspaceId, deletedAt: null };
  if (callType) query.callType = callType;
  if (publishedOnly === 'true') query.isPublished = true;

  const scorecards = await Scorecard.find(query)
    .select('_id name callType isPublished updatedAt createdAt')
    .sort({ updatedAt: -1 });

  res.json({
    success: true,
    data: {
      scorecards: scorecards.map(scorecardToJson),
    },
  });
});

/**
 * GET /workspaces/me/scorecards/:scorecardId
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
      error: { code: 'SCORECARD_NOT_FOUND', message: 'Scorecard not found' },
    });
  }

  res.json({ success: true, data: scorecardToJson(scorecard, true) });
});

/**
 * PATCH /workspaces/me/scorecards/:scorecardId
 * Body: { name?, callType?, isPublished?, settings? }
 */
export const updateScorecard = asyncHandler(async (req, res) => {
  const workspaceId = req.workspaceId;
  const { scorecardId } = req.params;
  const { name, callType, isPublished, settings } = req.body;

  const scorecard = await Scorecard.findOne({
    _id: scorecardId,
    workspaceId,
    deletedAt: null,
  });
  if (!scorecard) {
    return res.status(404).json({
      success: false,
      error: { code: 'SCORECARD_NOT_FOUND', message: 'Scorecard not found' },
    });
  }

  if (name !== undefined) scorecard.name = String(name).trim();
  if (callType !== undefined) scorecard.callType = callType?.trim() || null;
  if (isPublished !== undefined) scorecard.isPublished = !!isPublished;
  if (settings !== undefined) scorecard.settings = settings;

  try {
    await scorecard.save();
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'SCORECARD_NAME_TAKEN',
          message: `A scorecard named "${scorecard.name}" already exists in this workspace`,
        },
      });
    }
    throw err;
  }

  logger.info({
    action: 'SCORECARD_UPDATED',
    workspaceId,
    scorecardId: scorecard._id,
  });

  res.json({ success: true, data: scorecardToJson(scorecard, true) });
});

/**
 * DELETE /workspaces/me/scorecards/:scorecardId
 * Soft-delete. Frees the name for reuse.
 */
export const deleteScorecard = asyncHandler(async (req, res) => {
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
      error: { code: 'SCORECARD_NOT_FOUND', message: 'Scorecard not found' },
    });
  }

  scorecard.deletedAt = new Date();
  await scorecard.save();

  logger.info({
    action: 'SCORECARD_DELETED',
    workspaceId,
    scorecardId: scorecard._id,
  });

  res.json({ success: true, data: { id: scorecard._id.toString(), deletedAt: scorecard.deletedAt } });
});

function scorecardToJson(s, includeSettings = false) {
  const out = {
    id: s._id.toString(),
    name: s.name,
    callType: s.callType,
    isPublished: s.isPublished,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  if (includeSettings) out.settings = s.settings;
  return out;
}
