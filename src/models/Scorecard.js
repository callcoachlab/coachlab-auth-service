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

// Case-insensitive unique name within a workspace (active scorecards only).
// Why collation: "Sales Quality" and "sales quality" must collide so managers
// don't accidentally create two scorecards that the CSV name-lookup can't
// distinguish. Collation strength=2 = case + diacritic insensitive.
// Why partial: soft-deleted scorecards (deletedAt != null) shouldn't block
// re-creating a new one with the same name.
scorecardSchema.index(
  { workspaceId: 1, name: 1 },
  {
    unique: true,
    collation: { locale: 'en', strength: 2 },
    partialFilterExpression: { deletedAt: null },
  }
);

// Query helper
scorecardSchema.query.active = function () {
  return this.where({ deletedAt: null });
};

export const Scorecard = mongoose.model('Scorecard', scorecardSchema);
