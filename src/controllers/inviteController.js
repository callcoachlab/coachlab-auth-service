import { User } from '../models/User.js';
import { Invite } from '../models/Invite.js';
import { Team } from '../models/Team.js';
import { createAppError, ErrorCodes } from '../utils/errors.js';
import { logAuditEvent } from '../utils/audit.js';
import { successResponse, paginatedResponse } from '../utils/response.js';
import { generateInviteToken, hashToken } from '../utils/token.js';
import { sendInviteEmail } from '../services/emailService.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

const MAX_RESENDS = 5;

function buildInviteUrl(rawToken) {
  const base = config.appUrl.replace(/\/$/, '');
  return `${base}/accept-invite?token=${rawToken}`;
}

export async function createInvites(req, res, next) {
  try {
    const { invites: inviteList } = req.validatedData;

    // AGENT must have ≥1 team; ADMIN/MANAGER must have 0 teams (they aren't on a team).
    for (const inv of inviteList) {
      if (inv.role === 'AGENT' && inv.teamIds.length === 0) {
        throw createAppError(
          'Agents must be assigned to at least 1 team',
          400,
          ErrorCodes.INVITE_REQUIRES_TEAM
        );
      }
      if (inv.role !== 'AGENT' && inv.teamIds.length > 0) {
        throw createAppError(
          `${inv.role} cannot be assigned to teams during invite`,
          400,
          ErrorCodes.VALIDATION_ERROR
        );
      }
    }

    // No duplicate emails in batch
    const emails = inviteList.map(inv => inv.email);
    if (new Set(emails).size !== emails.length) {
      throw createAppError(
        'Duplicate emails in request',
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    // Validate teamIds belong to this workspace
    const allTeamIds = [...new Set(inviteList.flatMap(inv => inv.teamIds))];
    if (allTeamIds.length > 0) {
      const validTeams = await Team.find({
        _id: { $in: allTeamIds },
        workspaceId: req.workspaceId,
        deletedAt: null,
      }).select('_id');
      const validTeamIdSet = new Set(validTeams.map(t => String(t._id)));
      const invalidIds = allTeamIds.filter(id => !validTeamIdSet.has(String(id)));
      if (invalidIds.length > 0) {
        throw createAppError(
          'One or more teams not found in this workspace',
          400,
          ErrorCodes.TEAM_NOT_FOUND
        );
      }
    }

    // Reject if any email is already an active member of THIS workspace
    const existingMembers = await User.find({
      workspaceId: req.workspaceId,
      email: { $in: emails },
      deletedAt: null,
    }).select('email');
    if (existingMembers.length > 0) {
      throw createAppError(
        `Already a member: ${existingMembers.map(u => u.email).join(', ')}`,
        400,
        ErrorCodes.EMAIL_ALREADY_EXISTS
      );
    }

    // Reject if there's already a PENDING invite for any of these emails
    const existingPending = await Invite.find({
      workspaceId: req.workspaceId,
      email: { $in: emails },
      status: 'PENDING',
      deletedAt: null,
    }).select('email');
    if (existingPending.length > 0) {
      throw createAppError(
        `Pending invite already exists for: ${existingPending.map(i => i.email).join(', ')}`,
        409,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const expiresAt = new Date(Date.now() + config.inviteTtlDays * 24 * 60 * 60 * 1000);
    const created = [];

    for (const inviteData of inviteList) {
      const rawToken = generateInviteToken();
      const tokenHash = hashToken(rawToken);

      const invite = await Invite.create({
        workspaceId: req.workspaceId,
        email: inviteData.email,
        role: inviteData.role,
        teamIds: inviteData.teamIds,
        tokenHash,
        expiresAt,
        status: 'PENDING',
        invitedBy: req.user._id,
      });

      await logAuditEvent({
        workspaceId: req.workspaceId,
        actorUserId: req.user._id,
        actionType: 'USER_INVITED',
        entityType: 'Invite',
        entityId: invite._id,
        metadata: {
          email: inviteData.email,
          role: inviteData.role,
          teamCount: inviteData.teamIds.length,
        },
      });

      // Fire-and-log: never block the response if the email transport hiccups.
      sendInviteEmail({
        to: inviteData.email,
        inviterName: req.user.name,
        workspaceName: req.workspace.name,
        role: inviteData.role,
        inviteUrl: buildInviteUrl(rawToken),
        expiresInDays: config.inviteTtlDays,
      }).catch((err) => {
        logger.error({ inviteId: invite._id, err: err.message }, 'Invite email failed to send');
      });

      created.push({
        id: invite._id,
        email: invite.email,
        role: invite.role,
        teamIds: invite.teamIds,
        status: invite.status,
        expiresAt: invite.expiresAt,
      });
    }

    res.status(201).json(
      successResponse({
        invites: created,
        count: created.length,
      })
    );
  } catch (error) {
    next(error);
  }
}

export async function getInvites(req, res, next) {
  try {
    const { status, page, limit } = req.validatedQuery;

    const query = { workspaceId: req.workspaceId, deletedAt: null };
    if (status) query.status = status;

    const total = await Invite.countDocuments(query);
    const invites = await Invite.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('invitedBy', 'name email');

    const data = invites.map(inv => ({
      id: inv._id,
      email: inv.email,
      role: inv.role,
      teamIds: inv.teamIds,
      status: inv.status,
      expiresAt: inv.expiresAt,
      createdAt: inv.createdAt,
      acceptedAt: inv.acceptedAt,
      resendCount: inv.resendCount,
      invitedBy: inv.invitedBy
        ? { id: inv.invitedBy._id, name: inv.invitedBy.name, email: inv.invitedBy.email }
        : null,
    }));

    res.json(paginatedResponse(data, page, limit, total));
  } catch (error) {
    next(error);
  }
}

export async function revokeInvite(req, res, next) {
  try {
    const { inviteId } = req.params;

    const invite = await Invite.findOne({
      _id: inviteId,
      workspaceId: req.workspaceId,
    }).active();

    if (!invite) {
      throw createAppError('Invite not found', 404, ErrorCodes.INVITE_NOT_FOUND);
    }

    if (invite.status !== 'PENDING') {
      throw createAppError(
        'Only pending invites can be revoked',
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    invite.status = 'REVOKED';
    invite.tokenHash = null; // Kill the link immediately
    await invite.save();

    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.user._id,
      actionType: 'INVITE_REVOKED',
      entityType: 'Invite',
      entityId: invite._id,
      metadata: { email: invite.email },
    });

    res.json(successResponse({ message: 'Invite revoked successfully' }));
  } catch (error) {
    next(error);
  }
}

export async function resendInvite(req, res, next) {
  try {
    const { inviteId } = req.params;

    const invite = await Invite.findOne({
      _id: inviteId,
      workspaceId: req.workspaceId,
    }).active();

    if (!invite) {
      throw createAppError('Invite not found', 404, ErrorCodes.INVITE_NOT_FOUND);
    }

    if (invite.status !== 'PENDING') {
      throw createAppError(
        'Only pending invites can be resent',
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    if (invite.resendCount >= MAX_RESENDS) {
      throw createAppError(
        'Resend limit reached for this invite. Revoke and create a new one.',
        429,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    // Rotate token — old link dies the moment we save.
    const rawToken = generateInviteToken();
    invite.tokenHash = hashToken(rawToken);
    invite.expiresAt = new Date(Date.now() + config.inviteTtlDays * 24 * 60 * 60 * 1000);
    invite.resendCount += 1;
    await invite.save();

    await logAuditEvent({
      workspaceId: req.workspaceId,
      actorUserId: req.user._id,
      actionType: 'USER_INVITED',
      entityType: 'Invite',
      entityId: invite._id,
      metadata: { email: invite.email, reason: 'RESEND', resendCount: invite.resendCount },
    });

    sendInviteEmail({
      to: invite.email,
      inviterName: req.user.name,
      workspaceName: req.workspace.name,
      role: invite.role,
      inviteUrl: buildInviteUrl(rawToken),
      expiresInDays: config.inviteTtlDays,
    }).catch((err) => {
      logger.error({ inviteId: invite._id, err: err.message }, 'Invite resend email failed');
    });

    res.json(
      successResponse({
        invite: {
          id: invite._id,
          email: invite.email,
          role: invite.role,
          status: invite.status,
          expiresAt: invite.expiresAt,
          resendCount: invite.resendCount,
        },
      })
    );
  } catch (error) {
    next(error);
  }
}

// Public — no auth. Frontend calls this when the user lands on /accept-invite?token=...
// Returns minimal info to render the "Join {workspace}" screen. Does not consume the token.
export async function previewInvite(req, res, next) {
  try {
    const rawToken = req.query.token;
    if (!rawToken || typeof rawToken !== 'string') {
      throw createAppError(
        'Token is required',
        400,
        ErrorCodes.VALIDATION_ERROR
      );
    }

    const tokenHash = hashToken(rawToken);
    const invite = await Invite.findOne({ tokenHash, deletedAt: null })
      .populate('workspaceId', 'name')
      .populate('invitedBy', 'name email');

    if (!invite) {
      throw createAppError('Invite not found', 404, ErrorCodes.INVITE_NOT_FOUND);
    }

    if (invite.status === 'REVOKED') {
      throw createAppError('Invite has been revoked', 410, ErrorCodes.INVITE_REVOKED);
    }
    if (invite.status === 'ACCEPTED') {
      throw createAppError(
        'Invite has already been accepted',
        410,
        ErrorCodes.INVITE_ALREADY_ACCEPTED
      );
    }
    if (invite.expiresAt < new Date()) {
      throw createAppError('Invite has expired', 410, ErrorCodes.INVITE_EXPIRED);
    }

    // Tell the frontend whether this email is a known user (so it can skip the
    // password form for existing users — though in single-workspace M0 this should
    // never be true, since existing accounts already have a workspace).
    const existing = await User.findOne({ email: invite.email }).active();

    res.json(
      successResponse({
        email: invite.email,
        role: invite.role,
        workspace: invite.workspaceId
          ? { id: invite.workspaceId._id, name: invite.workspaceId.name }
          : null,
        invitedBy: invite.invitedBy
          ? { name: invite.invitedBy.name, email: invite.invitedBy.email }
          : null,
        expiresAt: invite.expiresAt,
        userExists: Boolean(existing),
      })
    );
  } catch (error) {
    next(error);
  }
}
