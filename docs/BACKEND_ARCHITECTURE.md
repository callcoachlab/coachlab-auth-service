# Call Coach Lab — Backend Architecture & Flow

**Audience:** Frontend engineers, integration partners
**Version:** M0 (0.1.0)
**Backend stack:** Node.js · Express · MongoDB (Atlas) · JWT · Resend (transactional email)

---

## Table of Contents

1. [What this backend does](#1-what-this-backend-does)
2. [High-level architecture](#2-high-level-architecture)
3. [Request lifecycle](#3-request-lifecycle)
4. [Authentication architecture](#4-authentication-architecture)
5. [Workspace-based architecture](#5-workspace-based-architecture)
6. [Token lifecycle](#6-token-lifecycle)
7. [CSRF protection model](#7-csrf-protection-model)
8. [Cookie strategy](#8-cookie-strategy)
9. [Auth flows (step-by-step)](#9-auth-flows-step-by-step)
10. [Data model — what gets stored where](#10-data-model)
11. [Error format & error codes](#11-error-format--error-codes)
12. [Rate limiting](#12-rate-limiting)
13. [Security decisions explained](#13-security-decisions-explained)
14. [Known M0 limitations](#14-known-m0-limitations)

---

## 1. What this backend does

Call Coach Lab is an **AI-powered call coaching SaaS**. The M0 (Milestone Zero) backend covers the **identity, workspace, and member-management foundation**:

- Account creation with email verification
- Workspace creation (one workspace = one company / clinic / org)
- Role-based member management (ADMIN / MANAGER / AGENT)
- Team CRUD inside a workspace
- Invitation system (admins invite people; invitees accept via magic link)
- Audit logging
- Permission toggles
- Internal service-to-service endpoint for the M1 ingestion service (out of scope for the frontend)

Calls, scorecards, and outcomes are part of M1/M2 — not yet exposed.

---

## 2. High-level architecture

```
┌──────────────┐        HTTPS / HTTP          ┌──────────────────────────┐
│              │ ───────────────────────────► │                          │
│  Frontend    │                              │   Express API server     │
│  (React,     │ ◄─────────────────────────── │   (routes + middleware)  │
│   Postman,   │       JSON + Cookies         │                          │
│   etc.)      │                              └─────────┬────────────────┘
│              │                                        │
└──────────────┘                                        │ Mongoose
                                                        ▼
                                            ┌──────────────────────────┐
                                            │   MongoDB Atlas          │
                                            │   (Users, Workspaces,    │
                                            │    Teams, Invites,       │
                                            │    AuditLogs, Refresh-   │
                                            │    Tokens, Calls...)     │
                                            └──────────────────────────┘

                                                        │
                                                        ▼
                                            ┌──────────────────────────┐
                                            │   Resend (email API)     │
                                            │   verification, reset,   │
                                            │   invite emails          │
                                            └──────────────────────────┘
```

### Module map

```
src/
├── index.js               ← entry point; wires middleware + routes
├── config/                ← env loader, DB connection, logger
├── routes/                ← URL → controller mapping
├── controllers/           ← business logic per resource
├── middleware/            ← auth, CSRF, validation, rate limiting, error handler
├── models/                ← Mongoose schemas
├── services/              ← email service (Resend wrapper)
├── utils/                 ← token generation, response helpers, audit, errors
├── validators/            ← Zod schemas for every request body / query
└── docs/openapi.yaml      ← OpenAPI 3.0 spec — source of truth for routes
```

### Route groups

| Mount path | What it covers |
|---|---|
| `/csrf` | Issue CSRF tokens |
| `/auth` | Register, login, logout, refresh, verify-email, password reset, accept-invite |
| `/me` | Current user profile, change password |
| `/workspaces` | Workspace setup, get / update workspace |
| `/teams` | Team CRUD |
| `/users` | List / update / disable / enable workspace members |
| `/invites` | Send / list / revoke / resend invites + public preview |
| `/settings` | Workspace permission toggles |
| `/audit-logs` | Audit trail (admin/manager only) |
| `/internal` | Service-to-service endpoints (NOT for frontend) |

---

## 3. Request lifecycle

Every request flows through a chain of middleware before reaching the controller. Here's a fully-authenticated POST example (`POST /teams`):

```
Request
   │
   ▼
[1] helmet         ── adds security headers (CSP, HSTS, etc.)
   ▼
[2] cors           ── checks Origin against CORS_ORIGIN allowlist
   ▼
[3] express.json   ── parses JSON body
   ▼
[4] mongoSanitize  ── strips $ and . from keys to block NoSQL injection
   ▼
[5] cookieParser   ── parses Cookie header into req.cookies
   ▼
[6] authMiddleware ── verifies Bearer token; loads req.user, req.workspaceId
   ▼
[7] workspaceMW    ── loads req.workspace from req.workspaceId
   ▼
[8] requireRole    ── checks req.user.role is in allowed set
   ▼
[9] csrfProtection ── checks X-CSRF-Token matches stored hash for csrf-token cookie
   ▼
[10] validateRequest(zodSchema)
                   ── validates req.body shape; attaches req.validatedData
   ▼
[11] controller    ── business logic; writes to DB; returns response
   ▼
[12] globalErrorHandler  (only on thrown error)
                   ── maps thrown errors to JSON envelope with status code
   │
   ▼
Response
```

Public routes (login, register, accept-invite, etc.) skip steps 6–9. GET routes skip step 9.

---

## 4. Authentication architecture

CallCoachLab uses **stateless JWT for access tokens** and **persisted JWT for refresh tokens**.

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   ACCESS TOKEN (short-lived, 15 minutes)                            │
│   ─────────────────────────────────────────                         │
│   • JWT signed with JWT_ACCESS_SECRET                               │
│   • Payload: { userId, workspaceId, scope: 'app', iat, exp }        │
│   • Returned in response body — frontend stores in MEMORY only      │
│   • Sent on every request as: Authorization: Bearer <token>         │
│   • Verified statelessly — no DB lookup needed for signature check  │
│                                                                     │
│                                                                     │
│   REFRESH TOKEN (long-lived, 7 days)                                │
│   ─────────────────────────────────────                             │
│   • JWT signed with JWT_REFRESH_SECRET                              │
│   • Payload: { userId, jti (unique id), iat, exp }                  │
│   • Stored in httpOnly cookie 'refreshToken' — JS cannot read it    │
│   • Persisted in RefreshToken collection (DB) keyed by jti          │
│   • Used only by POST /auth/refresh                                 │
│   • Rotated on every refresh (old jti becomes invalid)              │
│                                                                     │
│                                                                     │
│   SETUP TOKEN (short-lived, 15 minutes)                             │
│   ─────────────────────────────────────                             │
│   • JWT signed with JWT_ACCESS_SECRET, scope: 'workspace_setup'     │
│   • Returned in response body of /auth/verify-email or /auth/login  │
│     when user is EMAIL_VERIFIED but has no workspace                │
│   • Used as Bearer in POST /workspaces/setup ONLY                   │
│                                                                     │
│                                                                     │
│   CSRF TOKEN                                                        │
│   ────────────                                                      │
│   • Random 32-byte hex string                                       │
│   • csrfToken returned in response body  → store in JS memory       │
│   • csrf-token cookie (different value) → set automatically         │
│   • Server stores hash(csrfToken) keyed by cookie value             │
│   • Frontend must echo the body token in 'X-CSRF-Token' header on   │
│     every POST/PATCH/DELETE                                         │
│                                                                     │
│                                                                     │
│   EMAIL-VERIFICATION / PASSWORD-RESET / INVITE TOKENS               │
│   ─────────────────────────────────────────────────                 │
│   • Random 32-byte hex string (NOT a JWT)                           │
│   • Sent only via email link                                        │
│   • Server stores SHA-256 hash; raw token is never persisted        │
│   • Single-use; consumed on verify / reset / accept                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Token revocation

The backend supports **session invalidation** via `User.lastCredentialChangeAt`:

- On password change, password reset, logout, or admin disabling a user → backend sets `lastCredentialChangeAt = now`.
- Every authenticated request runs `user.isTokenValid(token.iat)` — if the token was issued **before** `lastCredentialChangeAt`, it's rejected with `TOKEN_INVALID`.
- This means **logout / password change kills all existing access tokens** without needing a blocklist.

Refresh tokens are revoked by deleting the `RefreshToken` row (`jti`).

---

## 5. Workspace-based architecture

**Every authenticated request is scoped to exactly one workspace.** This is non-negotiable.

```
                ┌──────────────────────┐
                │      Workspace       │
                │  (Acme Dental, etc.) │
                └────┬───────────┬─────┘
                     │           │
        owns         │           │ owns
                     ▼           ▼
            ┌─────────────┐   ┌─────────────┐
            │   Users     │   │   Teams     │
            │ (ADMIN /    │   │             │
            │  MANAGER /  │   │             │
            │  AGENT)     │   │             │
            └──┬──────────┘   └─────────────┘
               │   ▲                ▲
   members of  │   │ teamIds[]      │ teamIds[]
               ▼   └────────────────┘
              (AGENT only — must belong to ≥1 team)

         ┌─────────────┐    ┌─────────────┐
         │   Invites   │    │ AuditLogs   │
         │ (per email) │    │ (per action)│
         └─────────────┘    └─────────────┘
```

### Role rules (enforced server-side, not just UI)

| Role | Belongs to teams? | Can do |
|---|---|---|
| **ADMIN** | No (`teamIds = []`) | Everything in the workspace |
| **MANAGER** | No (`teamIds = []`) | Manage AGENTs, manage teams (no delete), no settings/permissions |
| **AGENT** | Yes (≥1 team) | View calls (M1+), no admin power |

### Last-admin protection

The backend refuses any operation that would leave a workspace with **zero ADMINs** — disabling, demoting, or deleting the last admin returns 400.

---

## 6. Token lifecycle

```
                                ┌────────────────────────────┐
                                │  USER REGISTERS            │
                                │  POST /auth/register       │
                                └────────────┬───────────────┘
                                             ▼
                              [verification token in email + DB hash]
                                             │
                                             ▼
                                ┌────────────────────────────┐
                                │  POST /auth/verify-email   │
                                │  with token                │
                                └────────────┬───────────────┘
                                             ▼
                                       [setupToken issued]
                                             │
                                             ▼
                                ┌────────────────────────────┐
                                │  POST /workspaces/setup    │
                                │  Authorization: Bearer     │
                                │    <setupToken>            │
                                └────────────┬───────────────┘
                                             ▼
                          [accessToken (body) + refreshToken (cookie)]
                                             │
                                             ▼
       ┌─────────────────────────────────────┴─────────────────────────────┐
       │                                                                   │
       ▼                                                                   ▼
  [hits any                                                       [accessToken
   protected route                                                 expires after
   with Bearer token]                                              15 minutes]
       │                                                                   │
       │                                                                   ▼
       │                                                  ┌────────────────────────────┐
       │                                                  │  POST /auth/refresh        │
       │                                                  │  (cookie sent automatic)   │
       │                                                  └────────────┬───────────────┘
       │                                                               ▼
       │                                                   [new accessToken (body) +
       │                                                    new refreshToken (cookie)
       │                                                    — old jti deleted]
       │                                                               │
       └───────────────────────────────────────────────────────────────┘
```

---

## 7. CSRF protection model

CSRF uses the **double-submit cookie pattern**.

```
1. Frontend calls GET /csrf
   ├─ Server generates token T and cookieId C, stores hash(T) keyed by C
   └─ Response:
      • Body: { csrfToken: "T..." }       ← frontend stores in memory
      • Set-Cookie: csrf-token=C... (httpOnly)

2. Frontend calls POST /teams
   ├─ Browser auto-sends cookie csrf-token=C
   ├─ Frontend manually adds header X-CSRF-Token: T
   └─ Server hashes incoming T, looks up by C in store, compares hashes.
      Mismatch → 403 FORBIDDEN.
```

**Important:** GET / HEAD / OPTIONS requests are exempt from CSRF.

CSRF cookie expires after 1 hour. If your CSRF call returns 403, just hit `GET /csrf` again to refresh.

---

## 8. Cookie strategy

Two httpOnly cookies are set by the backend:

| Cookie | Set by | Read by | Lifetime |
|---|---|---|---|
| `refreshToken` | login, accept-invite, workspace setup, refresh | `/auth/refresh` only | 7 days |
| `csrf-token` | `/csrf` endpoint | every state-changing route | 1 hour |

Cookie attributes (set in code):
- `httpOnly: true` — JavaScript cannot read or modify
- `secure: true` (only in production) — sent only over HTTPS
- `sameSite: 'strict'` (production) / `'lax'` (development)

For the frontend, this means:
- Use `credentials: 'include'` on every fetch / `withCredentials: true` on every Axios call.
- Never try to read the cookies from JS — you can't.

---

## 9. Auth flows (step-by-step)

### 9.1 Sign-up + workspace creation (new admin)

```
┌──────────┐                                                   ┌──────────┐
│ Frontend │                                                   │ Backend  │
└────┬─────┘                                                   └────┬─────┘
     │  POST /auth/register { email, password }                    │
     ├────────────────────────────────────────────────────────────►│
     │                                                              │ creates User
     │                                                              │ status = PENDING_VERIFICATION
     │                                                              │ generates verification token
     │                                                              │ sends email
     │  200 { message, _devOnly_verificationToken (DEV ONLY) }     │
     │◄────────────────────────────────────────────────────────────┤
     │                                                              │
     │  POST /auth/verify-email { token }                          │
     ├────────────────────────────────────────────────────────────►│
     │                                                              │ marks status = EMAIL_VERIFIED
     │                                                              │ issues setupToken (15m)
     │  200 { setupToken, nextStep: 'workspace_setup' }            │
     │◄────────────────────────────────────────────────────────────┤
     │                                                              │
     │  POST /workspaces/setup                                     │
     │  Authorization: Bearer <setupToken>                         │
     │  Body: { workspaceName, industryType, timezone }            │
     ├────────────────────────────────────────────────────────────►│
     │                                                              │ creates Workspace
     │                                                              │ promotes user to ADMIN
     │                                                              │ status = ACTIVE
     │                                                              │ issues access + refresh
     │  201 { user, workspace, auth: { accessToken } }             │
     │  Set-Cookie: refreshToken=...                               │
     │◄────────────────────────────────────────────────────────────┤
     │                                                              │
     │ STORES accessToken IN MEMORY                                 │
```

### 9.2 Login

```
POST /auth/login { email, password }
   │
   ├─► [no user] → 401 INVALID_CREDENTIALS
   ├─► [account locked] → 423/429 ACCOUNT_LOCKED
   ├─► [DISABLED] → 403 USER_DISABLED
   ├─► [PENDING_VERIFICATION] → 403 EMAIL_NOT_VERIFIED
   ├─► [EMAIL_VERIFIED + no workspace] → 200 { setupToken, nextStep: 'workspace_setup' }
   └─► [ACTIVE + has workspace] → 200 { user, workspace, auth: { accessToken } }
                                  Set-Cookie: refreshToken=...
```

After 5 failed login attempts the account locks for 5 min. After 10 → 15 min. After 20 → 60 min.

### 9.3 Logout

```
POST /auth/logout
Authorization: Bearer <accessToken>

→ Sets user.lastCredentialChangeAt = now (kills all current accessTokens)
→ Clears refreshToken cookie
→ 200 { message: "Logged out successfully" }
```

### 9.4 Refresh

```
POST /auth/refresh
(Cookie sent automatically: refreshToken=...)

→ Verifies refreshToken signature
→ Looks up jti in RefreshToken collection
→ Issues new accessToken (body) + new refreshToken (cookie)
→ Old jti is replaced — old refresh cookie no longer works

→ 200 { auth: { accessToken } }
```

**Frontend rule:** when any protected request returns 401, call `/auth/refresh` once. If that also fails, redirect to login.

### 9.5 Password reset

```
POST /auth/forgot-password { email }
   → 200 generic message (always — anti-enumeration)
     DEV: includes _devOnly_resetToken if email matched

POST /auth/reset-password { token, password }
   → Validates token + complexity
   → Sets new passwordHash, sets lastCredentialChangeAt
   → Returns 200 { message }
   → All existing sessions are killed
```

### 9.6 Invite flow

```
A. ADMIN sends invite
─────────────────────
POST /invites (auth required)
  Body: { invites: [{ email, role, teamIds }] }

  → Creates Invite (status PENDING)
  → Generates token, hashes it, stores hash
  → Emails the invite link to the invitee
  → Returns 201 { count, invites: [{ id, email, role, ..., _devOnly_inviteToken (DEV) }] }


B. INVITEE (no account) opens email
────────────────────────────────────
GET /invites/preview?token=...  (PUBLIC)
  → Returns { email, role, workspaceName, alreadyHasAccount } so the
    frontend can render "You've been invited to {workspace}".

POST /auth/accept-invite { token, password, name? }  (PUBLIC, rate-limited)
  → Atomically marks invite ACCEPTED
  → Creates User in workspace with the role/teamIds from the invite
  → status = ACTIVE
  → Issues accessToken (body) + refreshToken (cookie)
  → Returns 200 { user, workspace, auth: { accessToken } }


C. ADMIN can also:
──────────────────
GET /invites?status=PENDING        → list invites
POST /invites/:id/revoke           → kills the link (tokenHash → null)
POST /invites/:id/resend           → rotates token (max 5 times) + re-sends email
```

### 9.7 Email verification re-send

```
POST /auth/resend-verification { email }
  → If user exists AND status = PENDING_VERIFICATION:
       new token issued + emailed (DEV: also returned)
  → Otherwise: identical 200 response (anti-enumeration)
```

---

## 10. Data model

(High-level — the source of truth is `src/models/`.)

### User
```
_id, workspaceId (nullable until setup), email, name, role,
teamIds[], status (PENDING_VERIFICATION | EMAIL_VERIFIED | INVITED | ACTIVE | DISABLED),
authProvider, googleSub, passwordHash, passwordResetTokenHash, passwordResetExpiresAt,
emailVerificationTokenHash, emailVerificationExpiresAt, emailVerifiedAt,
failedLoginAttempts, lockedUntil, twoFactorEnabled, twoFactorSecret,
lastLoginAt, lastCredentialChangeAt, deletedAt, timestamps
```

### Workspace
```
_id, name, industryType (Dental | Skin | Hair | Chiro | Other), timezone,
languagesEnabled[], settings.permissions{...}, createdBy, deletedAt, timestamps
```

### Team
```
_id, workspaceId, name (case-insensitive unique within workspace),
createdBy, deletedAt, timestamps
```

### Invite
```
_id, workspaceId, email, role, teamIds[], tokenHash,
expiresAt (TTL index — auto-deletes after expiry),
status (PENDING | ACCEPTED | REVOKED), invitedBy, acceptedAt,
acceptedByUserId, resendCount, deletedAt, timestamps
```

### AuditLog
```
_id, workspaceId, actorUserId, actionType (enum), entityType (enum),
entityId, metadata (mixed), timestamps
```

### RefreshToken
```
_id, userId, jti (unique), expiresAt, timestamps
```

---

## 11. Error format & error codes

**Every error response uses the same envelope:**

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable description"
  }
}
```

### Common error codes (from `src/utils/errors.js`)

| Code | Meaning | Typical HTTP |
|---|---|---|
| `INVALID_CREDENTIALS` | Wrong email/password | 401 |
| `USER_NOT_FOUND` | Account doesn't exist or is soft-deleted | 401/404 |
| `USER_DISABLED` | Account is DISABLED | 403 |
| `EMAIL_NOT_VERIFIED` | Login blocked — email not verified | 403 |
| `ACCOUNT_LOCKED` | Lockout window active | 429 |
| `WORKSPACE_ALREADY_EXISTS` | User already belongs to a workspace | 400 |
| `VERIFICATION_TOKEN_INVALID` | Bad / expired verification token | 400 |
| `PASSWORD_RESET_TOKEN_INVALID` | Bad / expired reset token | 400 |
| `SETUP_TOKEN_INVALID` | Bad / expired setup token | 401 |
| `INVITE_EXPIRED` | Invite past expiresAt | 410 |
| `INVITE_NOT_FOUND` | Token doesn't match any pending invite | 404 |
| `INVITE_ALREADY_ACCEPTED` | Token previously consumed | 410 |
| `INVITE_REVOKED` | Admin revoked it | 410 |
| `UNAUTHORIZED` | No / bad Authorization header | 401 |
| `FORBIDDEN` | Auth OK but lacks role / CSRF | 403 |
| `TOKEN_INVALID` | JWT bad, expired, or revoked via lastCredentialChangeAt | 401 |
| `VALIDATION_ERROR` | Body / query failed Zod schema | 400 |
| `INVALID_EMAIL` | Bad email format | 400 |
| `WEAK_PASSWORD` | Password fails complexity rules | 400 |
| `EMAIL_ALREADY_EXISTS` | Email is already a member | 400 |
| `INVITE_REQUIRES_TEAM` | AGENT invite has no teams | 400 |
| `WORKSPACE_NOT_FOUND` | Workspace missing / soft-deleted | 404 |
| `TEAM_NOT_FOUND` | Team missing / soft-deleted | 404 |
| `USER_ALREADY_EXISTS` | Conflict on email | 409 |
| `INTERNAL_SERVER_ERROR` | Unhandled crash | 500 |
| `DATABASE_ERROR` | Mongo error | 500 |
| `NOT_FOUND` | Endpoint doesn't exist | 404 |

---

## 12. Rate limiting

| Endpoint | Limit | Window |
|---|---|---|
| `POST /auth/login` | 10 | 15 min |
| `POST /auth/register` | 5 | 1 hour |
| `POST /auth/refresh` | 30 | 15 min |
| `POST /auth/resend-verification` | 5 | 1 hour |
| `POST /auth/forgot-password` | 5 | 1 hour |
| `GET /auth/verify-email` | 30 | 15 min |
| `POST /auth/accept-invite` | 10 | 1 hour |
| `POST /invites` | 20 | 15 min |
| `GET /invites/preview` | 30 | 15 min (shared with verify) |

Exceeding limits returns:
```json
{ "success": false, "error": { "code": "RATE_LIMIT_EXCEEDED", "message": "..." } }
```
HTTP 429.

---

## 13. Security decisions explained

| Decision | Why |
|---|---|
| **httpOnly refresh + CSRF cookies** | XSS in the SPA cannot steal them — the browser sends them automatically. JS can never read them. |
| **Access token in memory (not localStorage)** | XSS still leaks tokens from localStorage. Memory-only means a fresh page load → must refresh. |
| **15-min access token expiry** | If a token leaks, the window of abuse is small. Long-lived refresh covers UX. |
| **Refresh token rotation** | Every refresh issues a new jti and invalidates the previous one. A stolen old refresh token is useless. |
| **CSRF double-submit** | Even if an attacker steals the cookie value (via subdomain weakness), they still need the body token, which can't leak via cross-site. |
| **`lastCredentialChangeAt` revocation** | Logout / password change instantly kills tokens with no blocklist storage. |
| **Anti-enumeration on register/forgot/resend** | Generic 200 response either way prevents attackers from probing which emails are registered. |
| **bcrypt with 12 rounds (prod)** | Industry-standard cost factor. |
| **Mongo sanitize + Zod validation** | Strips operators from input + validates shape before any DB call. |
| **Account lockout** | Escalating tiers (5/10/20 attempts → 5/15/60 min). Throttles credential stuffing. |
| **Constant-time login (fake bcrypt compare on no-user path)** | Defends against timing-based email enumeration on `/login`. |
| **Hashed tokens at rest** | Verification, reset, invite tokens stored as SHA-256 hashes. DB dump = no usable tokens. |
| **Workspace scoping enforced server-side** | Users cannot see or touch data outside their workspace, regardless of what they send. |

---

## 14. Known M0 limitations

- **CSRF store is in-memory.** All CSRF tokens are wiped on server restart. Fix: replace `Map` with Redis (M0 → M1).
- **Rate limiter is in-memory.** Doesn't shared across instances. Same fix.
- **CSP exempts `/api-docs`.** Swagger UI needs inline scripts; only enabled when `NODE_ENV !== production`.
- **Resend free tier** can only deliver to one address. Use the `_devOnly_*` token fields for testing other emails.
- **Calls / scorecards / outcomes** models exist but no routes yet — these come in M1.
- **No 2FA enforcement yet** — schema fields exist as placeholders.
- **HTTP-only deploy on EC2** — `NODE_ENV=development` is intentionally set so cookies (`secure: false`) work over HTTP. When HTTPS is added, switch to `production`.

---
