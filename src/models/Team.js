import mongoose from 'mongoose';

const teamSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Indexes
teamSchema.index({ workspaceId: 1 });
teamSchema.index({ deletedAt: 1 });
// Team name must be unique within a workspace (case-insensitive),
// but only among non-deleted teams — so a deleted team's name can be reused.
teamSchema.index(
  { workspaceId: 1, name: 1 },
  {
    unique: true,
    collation: { locale: 'en', strength: 2 }, // case-insensitive
    partialFilterExpression: { deletedAt: null },
  }
);

// Query helper for active teams
teamSchema.query.active = function () {
  return this.where({ deletedAt: null });
};

export const Team = mongoose.model('Team', teamSchema);
