import bcryptjs from 'bcryptjs';
import { User } from '../models/User.js';
import { Invite } from '../models/Invite.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';
import { createAppError, ErrorCodes } from '../utils/errors.js';
import { logAuditEvent } from '../utils/audit.js';
import { successResponse } from '../utils/response.js';
import {
  generateAccessToken,
  generateRefreshToken,
  generateRandomToken,
  generateSetupToken,
  hashToken,
  verifyRefreshToken,
} from '../utils/token.js';
import { validatePassword } from '../utils/passwordPolicy.js';
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from '../services/emailService.js';

const isProd = process.env.NODE_ENV === 'production';

// Cookie options for the long-lived refresh token.
function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

// Always-on bcrypt compare to keep response time roughly constant whether the
// user exists or not — defends against timing-based email enumeration on /login.
// The hash is irrelevant; we just want CPU work in the user-not-found branch.
const FAKE_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8fE7ozY8vJoG4Yfr3LyT1hP7sV8KKi';

// ---------- helpers ----------

async function applyFailedLogin(user, req, reason) {
  user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;

  const { lockout } = config;
  let lockMinutes = 0;
  if (user.failedLoginAttempts >= lockout.threshold3Attempts) {
    lockMinutes = lockout.threshold3Minutes;
  } else if (user.failedLoginAttempts >= lockout.threshold2Attempts) {
    lockMinutes = lockout.threshold2Minutes;
  } else if (user.failedLoginAttempts >= lockout.threshold1Attempts) {
    lockMinutes = lockout.threshold1Minutes;
  }

  if (lockMinutes > 0) {
    user.lockedUntil = new Date(Date.now() + lockMinutes * 60 * 1000);
    await logAuditEvent({
      workspaceId: user.workspaceId,
      actorUserId: user._id,
      actionType: 'ACCOUNT_LOCKED',
      entityType: 'Auth',
      metadata: {
        attempts: user.failedLoginAttempts,
        lockedUntil: user.lockedUntil,
        ipAddress: req.ip,
      },
    });
  }

  await user.save();

  await logAuditEvent({
    workspaceId: user.workspaceId,
    actorUserId: user._id,
    actionType: 'LOGIN_FAILED',
    entityType: 'Auth',
    metadata: {
      reason,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    },
  });
}

async function clearFailedLogin(user) {
  if (user.failedLoginAttempts || user.lockedUntil) {
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
  }
}

function buildVerifyUrl(token) {
  const base = config.appUrl.replace(/\/$/, '');
  return `${base}/verify-email?token=${token}`;
}

function buildResetUrl(token) {
  const base = config.appUrl.replace(/\/$/, '');
  return `${base}/reset-password?token=${token}`;
}

// ---------- /auth/register ----------

export async function register(req, res, next) {
  try {
    const { email, password } = req.validatedData;

    // Server-side password policy. Zod gives us length only; this enforces complexity.
    const policy = validatePassword(password, email);
    if (!policy.valid) {
      throw createAppError(policy.reason, 400, ErrorCodes.WEAK_PASSWORD);
    }

    const existing = await User.findOne({ email }).active();

    // Anti-enumeration: every code path returns the same response shape.
    const genericResponse = successResponse({
      message:
        "If that email is available, you'll receive a verification link shortly.",
    });

    if (existing) {
      // Two valid sub-cases:
      //  1. Already verified / active — silently do nothing (don't leak account existence).
      //  2. Still pending verification — re-issue the link (helps users who lost the email).
      let devToken = null;
      if (existing.status === 'PENDING_VERIFICATION') {
        const token = generateRandomToken();
        existing.emailVerificationTokenHash = hashToken(token);
        existing.emailVerificationExpiresAt = new Date(
          Date.now() + config.emailVerificationTtlHours * 60 * 60 * 1000
        );
        await existing.save();
        await sendVerificationEmail({
          to: existing.email,
          name: existing.name,
          verifyUrl: buildVerifyUrl(token),
        });
        devToken = token;
      }
      if (!isProd && devToken) {
        return res.json({
          ...genericResponse,
          data: { ...genericResponse.data, _devOnly_verificationToken: devToken },
        });
      }
      return res.json(genericResponse);
    }

    // Create the user. We assign the plaintext to `passwordHash`; the pre-save
    // hook in User.js bcrypts it before insertion.
    const verificationToken = generateRandomToken();
    const user = new User({
      email,
      passwordHash: password,
      status: 'PENDING_VERIFICATION',
      authProvider: 'EMAIL',
      emailVerificationTokenHash: hashToken(verificationToken),
      emailVerificationExpiresAt: new Date(
        Date.now() + config.emailVerificationTtlHours * 60 * 60 * 1000
      ),
    });
    await user.save();

    await logAuditEvent({
      workspaceId: null,
      actorUserId: user._id,
      actionType: 'USER_REGISTERED',
      entityType: 'User',
      entityId: user._id,
      metadata: {
        email,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    });

    await sendVerificationEmail({
      to: email,
      verifyUrl: buildVerifyUrl(verificationToken),
    });

    const responseData = !isProd
      ? {
          ...genericResponse,
          data: { ...genericResponse.data, _devOnly_verificationToken: verificationToken },
        }
      : genericResponse;

    res.json(responseData);
  } catch (error) {
    next(error);
  }
}

// ---------- /auth/verify-email ----------

export async function verifyEmail(req, res, next) {
  try {
    // Accept token from query (link click) or body (SPA form post)
    const rawToken =
      req.validatedData?.token || req.query.token || req.body?.token;
    if (!rawToken) {
      throw createAppError(
        'Verification token is required',
        400,
        ErrorCodes.VERIFICATION_TOKEN_INVALID
      );
    }

    const tokenHash = hashToken(rawToken);
    const user = await User.findOne({
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: { $gt: new Date() },
    }).active();

    if (!user) {
      throw createAppError(
        'Verification link is invalid or has expired',
        400,
        ErrorCodes.VERIFICATION_TOKEN_INVALID
      );
    }

    // If the user is already past verification (e.g., re-clicked link after setup),
    // just no-op so re-clicks aren't an error.
    if (
      user.status !== 'PENDING_VERIFICATION' &&
      user.status !== 'EMAIL_VERIFIED'
    ) {
      throw createAppError(
        'Account is not awaiting verification',
        400,
        ErrorCodes.VERIFICATION_TOKEN_INVALID
      );
    }

    if (user.status === 'PENDING_VERIFICATION') {
      user.status = 'EMAIL_VERIFIED';
      user.emailVerifiedAt = new Date();
    }
    user.emailVerificationTokenHash = null;
    user.emailVerificationExpiresAt = null;
    await user.save();

    await logAuditEvent({
      workspaceId: null,
      actorUserId: user._id,
      actionType: 'EMAIL_VERIFIED',
      entityType: 'User',
      entityId: user._id,
      metadata: { email: user.email, ipAddress: req.ip },
    });

    // Issue a short-lived setup token so the SPA can call /workspaces/setup.
    const setupToken = generateSetupToken(user._id);

    res.json(
      successResponse({
        message: 'Email verified',
        nextStep: user.workspaceId ? 'login' : 'workspace_setup',
        setupToken: user.workspaceId ? null : setupToken,
        user: { id: user._id, email: user.email },
      })
    );
  } catch (error) {
    next(error);
  }
}

// ---------- /auth/resend-verification ----------

export async function resendVerification(req, res, next) {
  try {
    const { email } = req.validatedData;
    const genericResponse = successResponse({
      message:
        'If that email is awaiting verification, a new link has been sent.',
    });

    const user = await User.findOne({ email }).active();
    if (!user || user.status !== 'PENDING_VERIFICATION') {
      return res.json(genericResponse);
    }

    const token = generateRandomToken();
    user.emailVerificationTokenHash = hashToken(token);
    user.emailVerificationExpiresAt = new Date(
      Date.now() + config.emailVerificationTtlHours * 60 * 60 * 1000
    );
    await user.save();

    await sendVerificationEmail({
      to: user.email,
      name: user.name,
      verifyUrl: buildVerifyUrl(token),
    });

    await logAuditEvent({
      workspaceId: null,
      actorUserId: user._id,
      actionType: 'EMAIL_VERIFICATION_RESENT',
      entityType: 'User',
      entityId: user._id,
      metadata: { email: user.email, ipAddress: req.ip },
    });

    res.json(
      !isProd
        ? { ...genericResponse, data: { ...genericResponse.data, _devOnly_verificationToken: token } }
        : genericResponse
    );
  } catch (error) {
    next(error);
  }
}

// ---------- /auth/login ----------

export async function login(req, res, next) {
  try {
    const { email, password } = req.validatedData;

    const user = await User.findOne({ email }).active();

    if (!user) {
      // Constant-time-ish: do a real bcrypt compare against a dummy hash.
      await bcryptjs.compare(password, FAKE_HASH);
      await logAuditEvent({
        workspaceId: null,
        actorUserId: null,
        actionType: 'LOGIN_FAILED',
        entityType: 'Auth',
        metadata: {
          reason: 'USER_NOT_FOUND',
          email,
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        },
      });
      throw createAppError(
        'Invalid email or password',
        401,
        ErrorCodes.INVALID_CREDENTIALS
      );
    }

    if (user.isLocked()) {
      throw createAppError(
        `Account temporarily locked. Try again at ${user.lockedUntil.toISOString()}`,
        429,
        ErrorCodes.ACCOUNT_LOCKED
      );
    }

    if (user.status === 'DISABLED') {
      throw createAppError(
        'Account has been disabled',
        403,
        ErrorCodes.USER_DISABLED
      );
    }

    if (user.status === 'PENDING_VERIFICATION') {
      throw createAppError(
        'Please verify your email before logging in',
        403,
        ErrorCodes.EMAIL_NOT_VERIFIED
      );
    }

    if (!user.passwordHash) {
      // Google-only account; tell them to use OAuth instead of leaking that fact.
      throw createAppError(
        'Invalid email or password',
        401,
        ErrorCodes.INVALID_CREDENTIALS
      );
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      await applyFailedLogin(user, req, 'INVALID_PASSWORD');
      throw createAppError(
        'Invalid email or password',
        401,
        ErrorCodes.INVALID_CREDENTIALS
      );
    }

    // EMAIL_VERIFIED but no workspace yet → user paused mid-onboarding.
    // Don't issue a regular session; hand them a setup token instead.
    if (user.status === 'EMAIL_VERIFIED' || !user.workspaceId) {
      const setupToken = generateSetupToken(user._id);
      await clearFailedLogin(user);
      await user.save();
      return res.json(
        successResponse({
          nextStep: 'workspace_setup',
          setupToken,
          user: { id: user._id, email: user.email },
        })
      );
    }

    await clearFailedLogin(user);
    user.lastLoginAt = new Date();
    await user.save();


    const accessToken = await generateAccessToken(user._id, user.workspaceId);
    console.log("user id and workspace id-");
    console.log(user._id,user.workspaceId);
    const refreshToken = await generateRefreshToken(user._id);

    await logAuditEvent({
      workspaceId: user.workspaceId,
      actorUserId: user._id,
      actionType: 'LOGIN_SUCCESS',
      entityType: 'Auth',
      metadata: {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    });

    res.cookie('refreshToken', refreshToken, refreshCookieOptions());

    res.json(
      successResponse({
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          teamIds: user.teamIds,
          status: user.status,
        },
        workspace: { id: user.workspaceId },
        auth: { accessToken },
      })
    );
  } catch (error) {
    next(error);
  }
}

// ---------- /auth/logout ----------

export async function logout(req, res, next) {
  try {
    // Invalidate all access tokens issued before this moment
    req.user.lastCredentialChangeAt = new Date();
    await req.user.save();

    res.clearCookie('refreshToken', { path: '/' });

    await logAuditEvent({
      workspaceId: req.user.workspaceId,
      actorUserId: req.user._id,
      actionType: 'LOGOUT',
      entityType: 'Auth',
      metadata: { ipAddress: req.ip },
    });

    res.json(successResponse({ message: 'Logged out successfully' }));
  } catch (error) {
    next(error);
  }
}

// ---------- /auth/refresh ----------

export async function refresh(req, res, next) {
  try {
    const refreshToken =
      req.cookies?.refreshToken || req.body?.refreshToken;
    if (!refreshToken) {
      throw createAppError(
        'Refresh token missing',
        401,
        ErrorCodes.UNAUTHORIZED
      );
    }

    const decoded = await verifyRefreshToken(refreshToken);
    if (!decoded) {
      throw createAppError(
        'Invalid or expired refresh token',
        401,
        ErrorCodes.TOKEN_INVALID
      );
    }

    const user = await User.findById(decoded.userId).active();
    if (!user || user.status !== 'ACTIVE' || !user.workspaceId) {
      throw createAppError(
        'User not found or inactive',
        401,
        ErrorCodes.USER_NOT_FOUND
      );
    }

    if (!user.isTokenValid(decoded.iat)) {
      throw createAppError(
        'Token has been revoked',
        401,
        ErrorCodes.TOKEN_INVALID
      );
    }

    const newAccessToken = await generateAccessToken(user._id, user.workspaceId);
    const newRefreshToken = await generateRefreshToken(user._id);

    res.cookie('refreshToken', newRefreshToken, refreshCookieOptions());

    res.json(successResponse({ auth: { accessToken: newAccessToken } }));
  } catch (error) {
    next(error);
  }
}

// ---------- /auth/forgot-password ----------

export async function forgotPassword(req, res, next) {
  try {
    const { email } = req.validatedData;
    const genericResponse = successResponse({
      message:
        "If an account with that email exists, you'll receive password reset instructions.",
    });

    const user = await User.findOne({ email }).active();
    if (!user || !user.passwordHash) {
      // Either no account, or it's Google-only (no password to reset).
      return res.json(genericResponse);
    }

    const token = generateRandomToken();
    user.passwordResetTokenHash = hashToken(token);
    user.passwordResetExpiresAt = new Date(
      Date.now() + config.passwordResetTtlMinutes * 60 * 1000
    );
    await user.save();

    await sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      resetUrl: buildResetUrl(token),
    });

    await logAuditEvent({
      workspaceId: user.workspaceId,
      actorUserId: user._id,
      actionType: 'PASSWORD_RESET_REQUESTED',
      entityType: 'User',
      entityId: user._id,
      metadata: { ipAddress: req.ip },
    });

    res.json(
      !isProd
        ? { ...genericResponse, data: { ...genericResponse.data, _devOnly_resetToken: token } }
        : genericResponse
    );
  } catch (error) {
    next(error);
  }
}

// ---------- /auth/reset-password ----------

export async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.validatedData;

    const tokenHash = hashToken(token);
    const user = await User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() },
    }).active();

    if (!user) {
      throw createAppError(
        'Reset link is invalid or has expired',
        400,
        ErrorCodes.PASSWORD_RESET_TOKEN_INVALID
      );
    }

    const policy = validatePassword(password, user.email);
    if (!policy.valid) {
      throw createAppError(policy.reason, 400, ErrorCodes.WEAK_PASSWORD);
    }

    user.passwordHash = password; // pre-save hook will bcrypt it
    user.passwordResetTokenHash = null;
    user.passwordResetExpiresAt = null;
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    // lastCredentialChangeAt is set by pre-save hook → revokes existing sessions.
    await user.save();

    await logAuditEvent({
      workspaceId: user.workspaceId,
      actorUserId: user._id,
      actionType: 'PASSWORD_RESET_COMPLETED',
      entityType: 'User',
      entityId: user._id,
      metadata: { ipAddress: req.ip },
    });

    res.json(
      successResponse({
        message: 'Password reset successfully. Please log in.',
      })
    );
  } catch (error) {
    next(error);
  }
}

// ---------- /auth/accept-invite (existing flow, kept for invited team members) ----------

export async function acceptInvite(req, res, next) {
  try {
    const { token, password, name } = req.validatedData;

    const tokenHash = hashToken(token);
    const invite = await Invite.findOne({ tokenHash, deletedAt: null });

    if (!invite) {
      throw createAppError(
        'Invite not found or has been revoked',
        404,
        ErrorCodes.INVITE_NOT_FOUND
      );
    }

    if (invite.status === 'REVOKED') {
      throw createAppError(
        'This invite has been revoked',
        410,
        ErrorCodes.INVITE_REVOKED
      );
    }

    if (invite.status !== 'PENDING') {
      throw createAppError(
        'Invite has already been accepted',
        410,
        ErrorCodes.INVITE_ALREADY_ACCEPTED
      );
    }

    if (new Date() > invite.expiresAt) {
      throw createAppError(
        'Invite has expired',
        410,
        ErrorCodes.INVITE_EXPIRED
      );
    }

    const policy = validatePassword(password, invite.email);
    if (!policy.valid) {
      throw createAppError(policy.reason, 400, ErrorCodes.WEAK_PASSWORD);
    }

    // M0 is single-workspace per user. If the email already exists anywhere, reject.
    const existingUser = await User.findOne({ email: invite.email }).active();
    if (existingUser) {
      throw createAppError(
        'An account with this email already exists. Please contact your admin.',
        409,
        ErrorCodes.USER_ALREADY_EXISTS
      );
    }

    // Create the user (pre-save hook hashes passwordHash).
    const user = await User.create({
      workspaceId: invite.workspaceId,
      email: invite.email,
      name: name || invite.email.split('@')[0],
      role: invite.role,
      teamIds: invite.teamIds,
      status: 'ACTIVE',
      authProvider: 'EMAIL',
      passwordHash: password,
      emailVerifiedAt: new Date(), // Clicking the invite proves email ownership
    });

    // Atomic accept: only flips PENDING → ACCEPTED if no one else got here first.
    // matchedCount === 0 means a race winner already accepted; roll back the user.
    const result = await Invite.updateOne(
      { _id: invite._id, status: 'PENDING' },
      {
        $set: {
          status: 'ACCEPTED',
          acceptedAt: new Date(),
          acceptedByUserId: user._id,
          tokenHash: null, // Prevent replay
        },
      }
    );

    if (result.matchedCount === 0) {
      // Lost the race — undo the user we just created.
      await User.deleteOne({ _id: user._id });
      throw createAppError(
        'Invite has already been accepted',
        410,
        ErrorCodes.INVITE_ALREADY_ACCEPTED
      );
    }

    await logAuditEvent({
      workspaceId: invite.workspaceId,
      actorUserId: user._id,
      actionType: 'INVITE_ACCEPTED',
      entityType: 'Invite',
      entityId: invite._id,
      metadata: { email: invite.email, role: invite.role },
    });

    const accessToken = await generateAccessToken(user._id, user.workspaceId);
    const refreshToken = await generateRefreshToken(user._id);

    res.cookie('refreshToken', refreshToken, refreshCookieOptions());

    res.json(
      successResponse({
        user: {
          id: user._id,
          email: user.email,
          name: user.name,
          role: user.role,
          teamIds: user.teamIds,
          status: user.status,
        },
        workspace: { id: user.workspaceId },
        auth: { accessToken },
      })
    );
  } catch (error) {
    next(error);
  }
}
