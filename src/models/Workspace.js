import mongoose from 'mongoose';

const workspaceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
    },
    industryType: {
      type: String,
      enum: ['Dental', 'Skin', 'Hair', 'Chiro', 'Other'],
      required: true,
    },
    timezone: {
      type: String,
      default: 'UTC',
    },
    languagesEnabled: {
      type: [String],
      default: ['en'],
    },
    settings: {
      permissions: {
        managersCanEditScorecards: { type: Boolean, default: true },
        managersCanEditOutcomes: { type: Boolean, default: true },
        managersCanExportData: { type: Boolean, default: true },
        agentsCanViewOwnCallScores: { type: Boolean, default: true },
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Index for workspace lookups
workspaceSchema.index({ deletedAt: 1 });
workspaceSchema.index({ createdAt: 1 });

// Default query excludes soft-deleted
workspaceSchema.query.active = function () {
  return this.where({ deletedAt: null });
};

export const Workspace = mongoose.model('Workspace', workspaceSchema);
