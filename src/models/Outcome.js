import mongoose from 'mongoose';

const outcomeSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    scorecardId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Scorecard',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['PASS', 'FAIL', 'SCORE'],
      required: true,
    },
    weight: {
      type: Number,
      default: 1,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Indexes
outcomeSchema.index({ workspaceId: 1 });
outcomeSchema.index({ scorecardId: 1 });
outcomeSchema.index({ deletedAt: 1 });

// Query helper
outcomeSchema.query.active = function () {
  return this.where({ deletedAt: null });
};

export const Outcome = mongoose.model('Outcome', outcomeSchema);
