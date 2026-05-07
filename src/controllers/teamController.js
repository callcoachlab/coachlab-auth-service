import { Team } from '../models/Team.js';
import { User } from '../models/User.js';
import { createAppError, ErrorCodes } from '../utils/errors.js';
import { logAuditEvent } from '../utils/audit.js';
import { successResponse, paginatedResponse } from '../utils/response.js';

export async function createTeam(req, res, next) {
  try {
    const { name } = req.validatedData;

    const existing = await Team.findOne({
      workspaceId: req.workspaceId,
      name,
      deletedAt: null,
    }).collation({ locale: 'en', strength: 2 });

    if (existing) {
      throw createAppError(
        `A team named "${name}" already exists in this workspace`,
        409,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const team = await Team.create({
      workspaceId: req.workspaceId,
      name,
      createdBy: req.user._id,
    });

    // Log audit event
    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.user._id,
      actionType: 'TEAM_CREATED',
      entityType: 'Team',
      entityId: team._id,
      metadata: { name },
    });

    res.status(201).json(
      successResponse({
        id: team._id,
        name: team.name,
        createdAt: team.createdAt,
      })
    );
  } catch (error) {
    next(error);
  }
}

export async function getTeams(req, res, next) {
  try {
    const { page, limit } = req.validatedQuery;

    const total = await Team.countDocuments({
      workspaceId: req.workspaceId,
      deletedAt: null,
    });

    const teams = await Team.find({
      workspaceId: req.workspaceId,
      deletedAt: null,
    })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const data = teams.map(team => ({
      id: team._id,
      name: team.name,
      createdAt: team.createdAt,
    }));

    res.json(paginatedResponse(data, page, limit, total));
  } catch (error) {
    next(error);
  }
}

export async function updateTeam(req, res, next) {
  try {
    const { teamId } = req.params;
    const { name } = req.validatedData;

    // Validate teamId is a valid MongoDB ObjectId
    if (!teamId.match(/^[0-9a-fA-F]{24}$/)) {
      throw createAppError('Invalid team ID format', 400, ErrorCodes.VALIDATION_ERROR);
    }

    const team = await Team.findOne({
      _id: teamId,
      workspaceId: req.workspaceId,
      deletedAt: null,
    });

    if (!team) {
      throw createAppError('Team not found', 404, ErrorCodes.TEAM_NOT_FOUND);
    }

    const previousName = team.name;
    if (name && name !== team.name) {
      const conflict = await Team.findOne({
        workspaceId: req.workspaceId,
        name,
        deletedAt: null,
        _id: { $ne: team._id },
      }).collation({ locale: 'en', strength: 2 });

      if (conflict) {
        throw createAppError(
          `A team named "${name}" already exists in this workspace`,
          409,
          ErrorCodes.VALIDATION_ERROR
        );
      }
      team.name = name;
    }
    await team.save();

    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.user._id,
      actionType: 'TEAM_UPDATED',
      entityType: 'Team',
      entityId: team._id,
      metadata: { previousName, newName: team.name },
    });

    res.json(
      successResponse({
        id: team._id,
        name: team.name,
        updatedAt: team.updatedAt,
      })
    );
  } catch (error) {
    next(error);
  }
}

export async function deleteTeam(req, res, next) {
  try {
    const { teamId } = req.params;

    // Validate teamId is a valid MongoDB ObjectId
    if (!teamId.match(/^[0-9a-fA-F]{24}$/)) {
      throw createAppError('Invalid team ID format', 400, ErrorCodes.VALIDATION_ERROR);
    }

    const team = await Team.findOne({
      _id: teamId,
      workspaceId: req.workspaceId,
      deletedAt: null,
    });

    if (!team) {
      throw createAppError('Team not found', 404, ErrorCodes.TEAM_NOT_FOUND);
    }

    // Block deletion if it would leave any AGENT with zero teams
    // (AGENTs are required to belong to ≥1 team).
    const agentsLosingLastTeam = await User.find({
      workspaceId: req.workspaceId,
      role: 'AGENT',
      status: { $ne: 'DISABLED' },
      deletedAt: null,
      teamIds: [team._id],
    }).select('email');

    if (agentsLosingLastTeam.length > 0) {
      throw createAppError(
        `Cannot delete: ${agentsLosingLastTeam.length} agent(s) would be left without any team. Reassign them first.`,
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    // Pull team from teamIds of all members who are still on it.
    await User.updateMany(
      { workspaceId: req.workspaceId, teamIds: team._id },
      { $pull: { teamIds: team._id } }
    );

    team.deletedAt = new Date();
    await team.save();

    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.user._id,
      actionType: 'TEAM_DELETED',
      entityType: 'Team',
      entityId: team._id,
      metadata: { name: team.name },
    });

    res.json(successResponse({ message: 'Team deleted successfully' }));
  } catch (error) {
    next(error);
  }
}
