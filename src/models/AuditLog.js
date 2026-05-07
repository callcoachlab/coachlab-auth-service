import mongoose from 'mongoose';

const auditLogSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: false,
    },
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    actionType: {
      type: String,
      enum: [
        'WORKSPACE_CREATED',
        'WORKSPACE_UPDATED',
        'TEAM_CREATED',
        'TEAM_UPDATED',
        'TEAM_DELETED',
        'USER_INVITED',
        'INVITE_ACCEPTED',
        'INVITE_REVOKED',
        'USER_UPDATED',
        'USER_ROLE_CHANGED',
        'USER_DISABLED',
        'USER_ENABLED',
        'PASSWORD_CHANGED',
        'PERMISSION_TOGGLES_UPDATED',
        'LOGIN_SUCCESS',
        'LOGIN_FAILED',
        'ACCOUNT_LOCKED',
        'USER_REGISTERED',
        'EMAIL_VERIFIED',
        'EMAIL_VERIFICATION_RESENT',
        'PASSWORD_RESET_REQUESTED',
        'PASSWORD_RESET_COMPLETED',
        'LOGOUT',
      ],
      required: true,
    },
    entityType: {
      type: String,
      enum: ['Workspace', 'User', 'Team', 'Invite', 'Auth'],
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

// Indexes for querying
auditLogSchema.index({ workspaceId: 1, createdAt: -1 });
auditLogSchema.index({ workspaceId: 1, actorUserId: 1 });
auditLogSchema.index({ workspaceId: 1, actionType: 1 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
