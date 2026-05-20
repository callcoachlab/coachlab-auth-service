import { Workspace } from '../models/Workspace.js';
import { User } from '../models/User.js';
import { createAppError, ErrorCodes } from '../utils/errors.js';
import { logAuditEvent } from '../utils/audit.js';
import { successResponse } from '../utils/response.js';
import { generateAccessToken, generateRefreshToken } from '../utils/token.js';

const isProd = process.env.NODE_ENV === 'production';

// Mirrors authController.refreshCookieOptions. Production uses SameSite=None
// because the frontend is on a different registrable domain than the backend.
function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/auth',
  };
}

// POST /workspaces/setup
// Auth: setupTokenMiddleware (issued by /auth/verify-email or /auth/login when
// status == EMAIL_VERIFIED). Creates the workspace, promotes the user to ADMIN,
// and returns a regular session.
export async function setupWorkspace(req, res, next) {
  try {
    const user = req.user; // attached by setupTokenMiddleware
    const { workspaceName, industryType, timezone, languagesEnabled, name } =
      req.validatedData;

    if (user.workspaceId) {
      throw createAppError(
        'User already belongs to a workspace',
        400,
        ErrorCodes.WORKSPACE_ALREADY_EXISTS
      );
    }

    const workspace = await Workspace.create({
      name: workspaceName,
      industryType,
      timezone: timezone || 'UTC',
      languagesEnabled: languagesEnabled?.length ? languagesEnabled : ['en'],
      settings: {
        permissions: {
          managersCanEditScorecards: true,
          managersCanPublishScorecards: false,
          managersCanEditOutcomes: true,
          managersCanManageIntegrations: false,
          managersCanExportData: true,
          agentsCanViewOwnCallScores: true,
        },
      },
      createdBy: user._id,
    });

    user.workspaceId = workspace._id;
    user.role = 'ADMIN';
    user.status = 'ACTIVE';
    if (name) user.name = name;
    if (!user.name) user.name = user.email.split('@')[0];
    user.lastLoginAt = new Date();
    await user.save();

    await logAuditEvent({
      workspaceId: workspace._id,
      actorUserId: user._id,
      actionType: 'WORKSPACE_CREATED',
      entityType: 'Workspace',
      entityId: workspace._id,
      metadata: { industryType, timezone: workspace.timezone },
    });

    // user.role is set to ADMIN inside this controller before the token is issued.
    const accessToken = await generateAccessToken(user._id, workspace._id, user.role);
    const refreshToken = await generateRefreshToken(user._id);

    res.cookie('refreshToken', refreshToken, refreshCookieOptions());

    res.status(201).json(
      successResponse({
        workspace: {
          id: workspace._id,
          name: workspace.name,
          industryType: workspace.industryType,
          timezone: workspace.timezone,
        },
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          teamIds: user.teamIds,
          status: user.status,
        },
        auth: { accessToken },
      })
    );
  } catch (error) {
    next(error);
  }
}

// PATCH /workspaces/me — admin updates workspace name / timezone / languages
export async function updateMyWorkspace(req, res, next) {
  try {
    const { name, timezone, languagesEnabled } = req.validatedData;

    const workspace = await Workspace.findById(req.workspaceId).active();
    if (!workspace) {
      throw createAppError(
        'Workspace not found',
        404,
        ErrorCodes.WORKSPACE_NOT_FOUND
      );
    }

    const changes = {};
    if (name !== undefined && name !== workspace.name) {
      changes.name = { from: workspace.name, to: name };
      workspace.name = name;
    }
    if (timezone !== undefined && timezone !== workspace.timezone) {
      changes.timezone = { from: workspace.timezone, to: timezone };
      workspace.timezone = timezone;
    }
    if (languagesEnabled !== undefined) {
      const prev = workspace.languagesEnabled || [];
      const same =
        prev.length === languagesEnabled.length &&
        prev.every((l) => languagesEnabled.includes(l));
      if (!same) {
        changes.languagesEnabled = { from: prev, to: languagesEnabled };
        workspace.languagesEnabled = languagesEnabled;
      }
    }

    if (Object.keys(changes).length === 0) {
      return res.json(
        successResponse({
          id: workspace._id,
          name: workspace.name,
          industryType: workspace.industryType,
          timezone: workspace.timezone,
          languagesEnabled: workspace.languagesEnabled,
        })
      );
    }

    await workspace.save();

    await logAuditEvent({
      workspaceId: workspace._id,
      actorUserId: req.user._id,
      actionType: 'WORKSPACE_UPDATED',
      entityType: 'Workspace',
      entityId: workspace._id,
      metadata: { changes },
    });

    res.json(
      successResponse({
        id: workspace._id,
        name: workspace.name,
        industryType: workspace.industryType,
        timezone: workspace.timezone,
        languagesEnabled: workspace.languagesEnabled,
        updatedAt: workspace.updatedAt,
      })
    );
  } catch (error) {
    next(error);
  }
}

export async function getMyWorkspace(req, res, next) {
  try {
    const workspace = await Workspace.findById(req.workspaceId).active();
    if (!workspace) {
      throw createAppError(
        'Workspace not found',
        404,
        ErrorCodes.WORKSPACE_NOT_FOUND
      );
    }

    res.json(
      successResponse({
        id: workspace._id,
        name: workspace.name,
        industryType: workspace.industryType,
        timezone: workspace.timezone,
        settings: workspace.settings,
      })
    );
  } catch (error) {
    next(error);
  }
}
