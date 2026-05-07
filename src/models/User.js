import mongoose from 'mongoose';
import bcryptjs from 'bcryptjs';

const SALT_ROUNDS = process.env.NODE_ENV === 'production' ? 12 : 10;

const userSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: false,
      default: null,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: false,
      trim: true,
      default: undefined,
    },
    role: {
      type: String,
      enum: ['ADMIN', 'MANAGER', 'AGENT'],
      required: false,
      default: undefined,
    },
    teamIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'Team',
      default: [],
    },
    status: {
      type: String,
      enum: [
        'PENDING_VERIFICATION',
        'EMAIL_VERIFIED',
        'INVITED',
        'ACTIVE',
        'DISABLED',
      ],
      default: 'PENDING_VERIFICATION',
    },

    // Auth method
    authProvider: {
      type: String,
      enum: ['EMAIL', 'GOOGLE', 'HYBRID'],
      default: 'EMAIL',
    },
    googleSub: {
      type: String,
      default: null,
    },

    // Password
    passwordHash: {
      type: String,
      default: null,
    },
    passwordResetTokenHash: {
      type: String,
      default: null,
    },
    passwordResetExpiresAt: {
      type: Date,
      default: null,
    },

    // Email verification (magic link)
    emailVerificationTokenHash: {
      type: String,
      default: null,
    },
    emailVerificationExpiresAt: {
      type: Date,
      default: null,
    },
    emailVerifiedAt: {
      type: Date,
      default: null,
    },

    // Brute-force protection
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },
    lockedUntil: {
      type: Date,
      default: null,
    },

    // 2FA (placeholder; not yet enabled)
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    twoFactorSecret: {
      type: String,
      default: null,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },
    lastCredentialChangeAt: {
      type: Date,
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Email unique within a workspace; for unverified accounts (no workspace yet)
// the partial unique index below covers email uniqueness.
userSchema.index(
  { workspaceId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { workspaceId: { $type: 'objectId' } },
  }
);
// Email must be globally unique while still in PENDING_VERIFICATION / EMAIL_VERIFIED
// (no workspace yet) — prevents two people racing to register the same address.
userSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { workspaceId: null },
  }
);
userSchema.index({ workspaceId: 1, role: 1 });
userSchema.index({ workspaceId: 1, teamIds: 1 });
userSchema.index({ deletedAt: 1 });
userSchema.index(
  { googleSub: 1 },
  { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } }
);

userSchema.query.active = function () {
  return this.where({ deletedAt: null });
};

// Auto-hash password when set as plaintext on passwordHash field.
// Hash is recognised by the bcrypt prefix ($2a$ / $2b$ / $2y$).
userSchema.pre('save', async function (next) {
  if (!this.isModified('passwordHash')) return next();
  if (!this.passwordHash) return next();
  if (/^\$2[aby]\$/.test(this.passwordHash)) return next(); // already hashed

  try {
    const salt = await bcryptjs.genSalt(SALT_ROUNDS);
    this.passwordHash = await bcryptjs.hash(this.passwordHash, salt);
    this.lastCredentialChangeAt = new Date();
    next();
  } catch (error) {
    next(error);
  }
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.passwordHash) return false;
  return bcryptjs.compare(candidatePassword, this.passwordHash);
};

userSchema.methods.isTokenValid = function (iat) {
  const tokenIssuedAt = iat * 1000;
  const lastChangeTime = this.lastCredentialChangeAt?.getTime() || 0;
  return tokenIssuedAt >= lastChangeTime;
};

userSchema.methods.isLocked = function () {
  return !!(this.lockedUntil && this.lockedUntil > new Date());
};

export const User = mongoose.model('User', userSchema);
