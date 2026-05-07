import mongoose from 'mongoose';
import { config } from '../config/index.js';

const inviteSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ['ADMIN', 'MANAGER', 'AGENT'],
      required: true,
    },
    teamIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'Team',
      default: [],
    },
    tokenHash: {
      type: String,
      required: false,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expireAfterSeconds: 0 }, // TTL index
    },
    status: {
      type: String,
      enum: ['PENDING', 'ACCEPTED', 'REVOKED'],
      default: 'PENDING',
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    acceptedAt: {
      type: Date,
      default: null,
    },
    acceptedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    resendCount: {
      type: Number,
      default: 0,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Indexes
inviteSchema.index({ workspaceId: 1, status: 1 });
inviteSchema.index({ deletedAt: 1 });
// Prevent duplicate PENDING invite for the same email in the same workspace.
inviteSchema.index(
  { workspaceId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'PENDING', deletedAt: null },
  }
);

// Query helper for active invites
inviteSchema.query.active = function () {
  return this.where({ deletedAt: null });
};

export const Invite = mongoose.model('Invite', inviteSchema);
