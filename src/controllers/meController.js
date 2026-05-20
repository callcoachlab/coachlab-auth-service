import { Team } from '../models/Team.js';
import { User } from '../models/User.js';
import { successResponse } from '../utils/response.js';
import { createAppError, ErrorCodes } from '../utils/errors.js';
import { logAuditEvent } from '../utils/audit.js';
import { validatePassword } from '../utils/passwordPolicy.js';

export async function getMe(req, res, next) {
  try {
    const teams = await Team.find({
      _id: { $in: req.user.teamIds },
      deletedAt: null,
    }).select('name');

    res.json(
      successResponse({
        user: {
          id: req.user._id,
          email: req.user.email,
          name: req.user.name,
          role: req.user.role,
          teamIds: req.user.teamIds,
          status: req.user.status,
        },
        workspace: {
          id: req.workspace._id,
          name: req.workspace.name,
          industryType: req.workspace.industryType,
          timezone: req.workspace.timezone,
        },
        permissions: req.workspace.settings.permissions,
        teams: teams.map((team) => ({
          id: team._id,
          name: team.name,
        })),
      })
    );
  } catch (error) {
    next(error);
  }
}

export async function updateMe(req, res, next) {
  try {
    const { name } = req.validatedData;

    if (name !== undefined) req.user.name = name;
    await req.user.save();

    res.json(
      successResponse({
        id: req.user._id,
        email: req.user.email,
        name: req.user.name,
      })
    );
  } catch (error) {
    next(error);
  }
}

export async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.validatedData;

    // Re-fetch with passwordHash field included.
    const user = await User.findById(req.user._id);
    if (!user) {
      throw createAppError('User not found', 404, ErrorCodes.USER_NOT_FOUND);
    }

    const isValid = await user.comparePassword(currentPassword);
    if (!isValid) {
      throw createAppError(
        'Current password is incorrect',
        400,
        ErrorCodes.INVALID_CREDENTIALS
      );
    }

    const policy = validatePassword(newPassword, user.email);
    if (!policy.valid) {
      throw createAppError(policy.reason, 400, ErrorCodes.WEAK_PASSWORD);
    }

    if (currentPassword === newPassword) {
      throw createAppError(
        'New password must be different from current password',
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    user.passwordHash = newPassword; // pre-save hook hashes + sets lastCredentialChangeAt
    await user.save();

    await logAuditEvent({
      workspaceId: user.workspaceId,
      actorUserId: user._id,
      actionType: 'PASSWORD_CHANGED',
      entityType: 'User',
      entityId: user._id,
      metadata: { ipAddress: req.ip },
    });

    // Clear refresh cookie — the access token is now invalid via lastCredentialChangeAt.
    res.clearCookie('refreshToken', { path: '/auth' });

    res.json(successResponse({ message: 'Password changed. Please log in again.' }));
  } catch (error) {
    next(error);
  }
}
