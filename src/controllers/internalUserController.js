import { User } from '../models/User.js';
import { logger } from '../config/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

/**
 * GET /internal/users/:userId/profile?workspaceId=...
 *
 * Returns the canonical role + team membership for a user.
 * Called by M1 when it needs to verify "can this user upload for that agent?"
 *
 * Why M1 doesn't trust the JWT alone: roles can change (demote a manager to
 * agent, remove from team) and the JWT might still claim stale data until it
 * expires. M1 calls this on sensitive operations — not every request.
 *
 * Returns:
 *   { id, email, name, role, teamIds, workspaceId, status }
 *   404 if user not found / not in this workspace / soft-deleted
 */
export const getUserProfile = asyncHandler(async (req, res) => {
  const workspaceId = req.workspaceId;
  const { userId } = req.params;

  const user = await User.findOne({
    _id: userId,
    workspaceId,
    deletedAt: null,
  }).select('_id email name role teamIds workspaceId status phone externalAgentId');

  if (!user) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'USER_NOT_FOUND',
        message: 'User does not exist in this workspace',
      },
    });
  }

  logger.info({
    action: 'INTERNAL_USER_PROFILE',
    workspaceId,
    userId: user._id,
    role: user.role,
  });

  res.json({
    success: true,
    data: {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
      teamIds: (user.teamIds || []).map((t) => t.toString()),
      workspaceId: user.workspaceId.toString(),
      status: user.status,
      phone: user.phone || null,
      externalAgentId: user.externalAgentId || null,
    },
  });
});

/**
 * POST /internal/users/can-upload-for
 *
 * Body: { uploaderId, targetAgentId, workspaceId }
 *
 * Single-purpose authorization check the upload service can call before
 * accepting an upload on behalf of an agent. Encapsulates the RBAC matrix:
 *   ADMIN   → always yes
 *   MANAGER → yes if targetAgent is on a team the manager belongs to
 *   AGENT   → yes only if targetAgentId === uploaderId
 *
 * Keeps the rules in M0 (system of record) so M1 doesn't drift.
 */
export const canUploadFor = asyncHandler(async (req, res) => {
  const workspaceId = req.workspaceId;
  const { uploaderId, targetAgentId } = req.body;

  if (!uploaderId || !targetAgentId) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_PAYLOAD',
        message: 'uploaderId and targetAgentId are required',
      },
    });
  }

  const [uploader, target] = await Promise.all([
    User.findOne({ _id: uploaderId, workspaceId, deletedAt: null })
      .select('_id role teamIds'),
    User.findOne({ _id: targetAgentId, workspaceId, deletedAt: null })
      .select('_id teamIds'),
  ]);

  if (!uploader) {
    return res.status(404).json({
      success: false,
      error: { code: 'UPLOADER_NOT_FOUND', message: 'Uploader not in workspace' },
    });
  }
  if (!target) {
    return res.status(404).json({
      success: false,
      error: { code: 'TARGET_AGENT_NOT_FOUND', message: 'Target agent not in workspace' },
    });
  }

  let allowed = false;
  let reason = '';

  if (uploader.role === 'ADMIN') {
    allowed = true;
    reason = 'ADMIN can upload for any agent';
  } else if (uploader.role === 'MANAGER') {
    const managerTeams = new Set((uploader.teamIds || []).map((t) => t.toString()));
    const targetTeams = (target.teamIds || []).map((t) => t.toString());
    const overlap = targetTeams.some((t) => managerTeams.has(t));
    allowed = overlap;
    reason = overlap
      ? 'MANAGER shares a team with target agent'
      : 'MANAGER does not share a team with target agent';
  } else {
    // AGENT
    allowed = uploader._id.toString() === target._id.toString();
    reason = allowed
      ? 'AGENT uploading for self'
      : 'AGENT cannot upload for another agent';
  }

  logger.info({
    action: 'INTERNAL_CAN_UPLOAD_FOR',
    workspaceId,
    uploaderId,
    targetAgentId,
    role: uploader.role,
    allowed,
  });

  res.json({
    success: true,
    data: {
      allowed,
      reason,
      uploaderRole: uploader.role,
    },
  });
});
