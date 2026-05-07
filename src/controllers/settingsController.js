import { Workspace } from '../models/Workspace.js';
import { createAppError, ErrorCodes } from '../utils/errors.js';
import { logAuditEvent } from '../utils/audit.js';
import { successResponse } from '../utils/response.js';

export async function getSettings(req, res, next) {
  try {
    const workspace = await Workspace.findById(req.workspaceId).active();
    if (!workspace) {
      throw createAppError('Workspace not found', 404, ErrorCodes.WORKSPACE_NOT_FOUND);
    }

    res.json(
      successResponse({
        permissions: workspace.settings.permissions,
      })
    );
  } catch (error) {
    next(error);
  }
}

export async function updatePermissions(req, res, next) {
  try {
    const workspace = await Workspace.findById(req.workspaceId).active();
    if (!workspace) {
      throw createAppError('Workspace not found', 404, ErrorCodes.WORKSPACE_NOT_FOUND);
    }

    const previousPermissions = { ...workspace.settings.permissions };
    const updates = req.validatedData;

    // Update each permission if provided
    Object.keys(updates).forEach(key => {
      if (updates[key] !== undefined) {
        workspace.settings.permissions[key] = updates[key];
      }
    });

    await workspace.save();

    // Log audit event
    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.user._id,
      actionType: 'PERMISSION_TOGGLES_UPDATED',
      entityType: 'Workspace',
      entityId: workspace._id,
      metadata: {
        previousPermissions,
        newPermissions: workspace.settings.permissions,
      },
    });

    res.json(
      successResponse({
        permissions: workspace.settings.permissions,
      })
    );
  } catch (error) {
    next(error);
  }
}
