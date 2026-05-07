import { User } from '../models/User.js';
import { Team } from '../models/Team.js';
import { createAppError, ErrorCodes } from '../utils/errors.js';
import { logAuditEvent } from '../utils/audit.js';
import { successResponse, paginatedResponse } from '../utils/response.js';

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

// Make sure removing/demoting this user wouldn't leave the workspace with zero ADMINs.
async function assertNotLastAdmin(workspaceId, targetUser) {
  if (targetUser.role !== 'ADMIN') return;

  const otherActiveAdmins = await User.countDocuments({
    workspaceId,
    role: 'ADMIN',
    status: 'ACTIVE',
    deletedAt: null,
    _id: { $ne: targetUser._id },
  });

  if (otherActiveAdmins === 0) {
    throw createAppError(
      'Cannot remove the last admin from the workspace. Promote another user first.',
      400,
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

// Role hierarchy: ADMIN can edit anyone; MANAGER can only edit AGENTs.
function assertCanEdit(actor, target) {
  if (actor._id.equals(target._id) === false && actor.role === 'MANAGER' && target.role !== 'AGENT') {
    throw createAppError(
      'Managers can only edit agents',
      403,
      ErrorCodes.FORBIDDEN
    );
  }
  if (actor.role === 'MANAGER' && target.role === 'ADMIN') {
    throw createAppError(
      'Managers cannot edit admins',
      403,
      ErrorCodes.FORBIDDEN
    );
  }
}

async function validateTeamIds(workspaceId, teamIds) {
  if (!teamIds || teamIds.length === 0) return;

  const validIds = teamIds.filter((id) => OBJECT_ID_RE.test(id));
  if (validIds.length !== teamIds.length) {
    throw createAppError(
      'One or more team IDs are malformed',
      400,
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const found = await Team.find({
    _id: { $in: validIds },
    workspaceId,
    deletedAt: null,
  }).select('_id');

  if (found.length !== validIds.length) {
    throw createAppError(
      'One or more teams not found in this workspace',
      400,
      ErrorCodes.TEAM_NOT_FOUND
    );
  }
}

export async function getUsers(req, res, next) {
  try {
    const { role, status, teamId, page, limit } = req.validatedQuery;

    const query = {
      workspaceId: req.workspaceId,
      deletedAt: null,
    };

    if (role) query.role = role;
    if (status) query.status = status;
    if (teamId) query.teamIds = teamId;

    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('-passwordHash -emailVerificationTokenHash -passwordResetTokenHash -twoFactorSecret');

    const data = users.map((user) => ({
      id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      teamIds: user.teamIds,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    }));

    res.json(paginatedResponse(data, page, limit, total));
  } catch (error) {
    next(error);
  }
}

export async function updateUser(req, res, next) {
  try {
    const { userId } = req.params;
    const { role, teamIds, status } = req.validatedData;

    if (!OBJECT_ID_RE.test(userId)) {
      throw createAppError('Invalid user ID format', 400, ErrorCodes.VALIDATION_ERROR);
    }

    const user = await User.findOne({
      _id: userId,
      workspaceId: req.workspaceId,
      deletedAt: null,
    });

    if (!user) {
      throw createAppError('User not found', 404, ErrorCodes.USER_NOT_FOUND);
    }

    assertCanEdit(req.user, user);

    // Self-protection: a user cannot demote themselves out of ADMIN, nor disable themselves.
    if (req.user._id.equals(user._id)) {
      if (role && role !== 'ADMIN') {
        throw createAppError(
          'You cannot change your own role. Ask another admin to do it.',
          400,
          ErrorCodes.FORBIDDEN
        );
      }
      if (status && status === 'DISABLED') {
        throw createAppError(
          'You cannot disable your own account.',
          400,
          ErrorCodes.FORBIDDEN
        );
      }
    }

    const changes = {};
    const finalRole = role || user.role;
    const finalTeamIds = teamIds !== undefined ? teamIds : user.teamIds;

    // Role + team consistency: AGENT must have ≥1 team; ADMIN/MANAGER must have 0 teams.
    if (finalRole === 'AGENT' && finalTeamIds.length === 0) {
      throw createAppError(
        'Agents must belong to at least 1 team',
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }
    if (finalRole !== 'AGENT' && finalTeamIds.length > 0) {
      throw createAppError(
        `${finalRole} cannot be assigned to teams`,
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    if (teamIds !== undefined) {
      await validateTeamIds(req.workspaceId, teamIds);
    }

    if (role && role !== user.role) {
      // Demoting / changing role of last admin? block it.
      if (user.role === 'ADMIN' && role !== 'ADMIN') {
        await assertNotLastAdmin(req.workspaceId, user);
      }
      changes.previousRole = user.role;
      changes.newRole = role;
      user.role = role;
      // When role changes between AGENT ↔ non-AGENT, force teamIds to be supplied
      // so the consistency check above already validated them.
      if (teamIds !== undefined) user.teamIds = teamIds;
      else if (role !== 'AGENT') user.teamIds = []; // promoting to MANAGER/ADMIN clears teams
    } else if (teamIds !== undefined) {
      changes.previousTeamIds = user.teamIds;
      changes.newTeamIds = teamIds;
      user.teamIds = teamIds;
    }

    if (status && status !== user.status) {
      if (status === 'DISABLED') {
        await assertNotLastAdmin(req.workspaceId, user);
        user.lastCredentialChangeAt = new Date(); // Invalidate active tokens
      }
      changes.previousStatus = user.status;
      changes.newStatus = status;
      user.status = status;
    }

    await user.save();

    let actionType = 'USER_UPDATED';
    if (changes.newRole) actionType = 'USER_ROLE_CHANGED';
    if (changes.newStatus === 'DISABLED') actionType = 'USER_DISABLED';
    if (changes.newStatus === 'ACTIVE' && changes.previousStatus === 'DISABLED') {
      actionType = 'USER_ENABLED';
    }

    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.user._id,
      actionType,
      entityType: 'User',
      entityId: user._id,
      metadata: changes,
    });

    res.json(
      successResponse({
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        teamIds: user.teamIds,
        status: user.status,
        updatedAt: user.updatedAt,
      })
    );
  } catch (error) {
    next(error);
  }
}

export async function disableUser(req, res, next) {
  try {
    const { userId } = req.params;

    if (!OBJECT_ID_RE.test(userId)) {
      throw createAppError('Invalid user ID format', 400, ErrorCodes.VALIDATION_ERROR);
    }

    const user = await User.findOne({
      _id: userId,
      workspaceId: req.workspaceId,
      deletedAt: null,
    });

    if (!user) {
      throw createAppError('User not found', 404, ErrorCodes.USER_NOT_FOUND);
    }

    if (req.user._id.equals(user._id)) {
      throw createAppError(
        'You cannot disable your own account.',
        400,
        ErrorCodes.FORBIDDEN
      );
    }

    assertCanEdit(req.user, user);
    await assertNotLastAdmin(req.workspaceId, user);

    if (user.status === 'DISABLED') {
      throw createAppError('User is already disabled', 400, ErrorCodes.VALIDATION_ERROR);
    }

    user.status = 'DISABLED';
    user.lastCredentialChangeAt = new Date(); // Invalidate active tokens
    await user.save();

    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.user._id,
      actionType: 'USER_DISABLED',
      entityType: 'User',
      entityId: user._id,
      metadata: { email: user.email },
    });

    res.json(successResponse({ message: 'User disabled successfully' }));
  } catch (error) {
    next(error);
  }
}

export async function enableUser(req, res, next) {
  try {
    const { userId } = req.params;

    if (!OBJECT_ID_RE.test(userId)) {
      throw createAppError('Invalid user ID format', 400, ErrorCodes.VALIDATION_ERROR);
    }

    const user = await User.findOne({
      _id: userId,
      workspaceId: req.workspaceId,
      deletedAt: null,
    });

    if (!user) {
      throw createAppError('User not found', 404, ErrorCodes.USER_NOT_FOUND);
    }

    assertCanEdit(req.user, user);

    if (user.status !== 'DISABLED') {
      throw createAppError('User is not disabled', 400, ErrorCodes.VALIDATION_ERROR);
    }

    user.status = 'ACTIVE';
    await user.save();

    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.user._id,
      actionType: 'USER_ENABLED',
      entityType: 'User',
      entityId: user._id,
      metadata: { email: user.email },
    });

    res.json(successResponse({ message: 'User enabled successfully' }));
  } catch (error) {
    next(error);
  }
}
