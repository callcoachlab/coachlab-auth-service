import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config/index.js';
import { RefreshToken } from '../models/RefreshToken.js';

export async function generateAccessToken(userId, workspaceId, role = null) {
  const payload = {
    userId,
    workspaceId,
    scope: 'app',
  };
  // Role is optional so unverified accounts (no workspace yet) still get tokens.
  if (role) payload.role = role;

  return jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiry,
  });
}

export async function generateRefreshToken(userId) {
  const jti = crypto.randomUUID();

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  const payload = {
    userId,
    jti,
  };

  const token = jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiry,
  });

  await RefreshToken.create({ userId, jti, expiresAt });

  return token;
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, config.jwt.accessSecret);
  } catch (error) {
    return null;
  }
}

export async function verifyRefreshToken(token) {
  try {
    const decoded = jwt.verify(token, config.jwt.refreshSecret);

    const refreshRecord = await RefreshToken.findOne({ jti: decoded.jti });
    if (!refreshRecord) {
      return null;
    }

    return decoded;
  } catch (error) {
    return null;
  }
}

export async function revokeRefreshToken(jti) {
  await RefreshToken.deleteOne({ jti });
}

// Short-lived JWT used to bridge the verify-email step → workspace setup step.
// Scope is 'workspace_setup'. Lifetime is short (configurable) so a stolen
// link can't be replayed days later.
export function generateSetupToken(userId) {
  return jwt.sign(
    { userId, scope: 'workspace_setup' },
    config.jwt.accessSecret,
    { expiresIn: config.setupTokenExpiry }
  );
}

export function verifySetupToken(token) {
  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret);
    if (decoded.scope !== 'workspace_setup') return null;
    return decoded;
  } catch {
    return null;
  }
}

// Random URL-safe token for magic links / password reset (256 bits of entropy).
export function generateRandomToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Backwards-compatible alias used by existing invite code.
export function generateInviteToken() {
  return generateRandomToken();
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateCSRFToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashCSRFToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
