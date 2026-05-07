import { generateCSRFToken, hashCSRFToken } from '../utils/token.js';
import { ErrorCodes } from '../utils/errors.js';

const csrfTokensStore = new Map(); // In-memory store for M0, replace with Redis later

const isProd = process.env.NODE_ENV === 'production';

export function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const csrfToken = req.headers['x-csrf-token'];
  const csrfCookie = req.cookies?.['csrf-token'];

  if (!csrfToken || !csrfCookie) {
    return res.status(403).json({
      success: false,
      error: {
        code: ErrorCodes.FORBIDDEN,
        message: 'CSRF token missing',
      },
    });
  }

  // Hash the received header token and check it matches the stored hash for this cookie
  const incomingHash = hashCSRFToken(csrfToken);
  const storedHash = csrfTokensStore.get(csrfCookie);

  if (!storedHash || storedHash !== incomingHash) {
    return res.status(403).json({
      success: false,
      error: {
        code: ErrorCodes.FORBIDDEN,
        message: 'Invalid CSRF token',
      },
    });
  }

  next();
}

export function csrfTokenEndpoint(req, res) {
  try {
    // token  → sent in response body, frontend stores it in memory/state
    // cookieId → sent as cookie, browser auto-sends it on every request
    // storedHash → server stores hash(token) keyed by cookieId
    const token = generateCSRFToken();
    const tokenHash = hashCSRFToken(token);
    const cookieId = generateCSRFToken();

    csrfTokensStore.set(cookieId, tokenHash);

    res.cookie('csrf-token', cookieId, {
      httpOnly: true,                      // Browser sends it automatically; JS never needs to read it
      secure: isProd,                      // HTTPS only in production
      sameSite: isProd ? 'strict' : 'lax', // Strict in prod; lax allows local dev over HTTP
      maxAge: 60 * 60 * 1000,             // 1 hour
    });

    res.json({
      success: true,
      data: {
        csrfToken: token, // Frontend stores this and sends it as X-CSRF-Token header
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: {
        code: ErrorCodes.INTERNAL_SERVER_ERROR,
        message: 'Failed to generate CSRF token',
      },
    });
  }
}
