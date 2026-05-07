import mongoose from 'mongoose';

const scorecardSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    callType: {
      type: String,
    },
    isPublished: {
      type: Boolean,
      default: false,
    },
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Indexes
scorecardSchema.index({ workspaceId: 1 });
scorecardSchema.index({ teamId: 1 });
scorecardSchema.index({ deletedAt: 1 });

// Query helper
scorecardSchema.query.active = function () {
  return this.where({ deletedAt: null });
};

export const Scorecard = mongoose.model('Scorecard', scorecardSchema);
