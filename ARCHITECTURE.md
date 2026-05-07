# M0 Architecture & API Reference

This document covers the design decisions, data model, full API reference, security posture, and testing strategy for the M0 core backend. Setup and the golden-flow runbook live in [README.md](README.md). Future work lives in [ROADMAP.md](ROADMAP.md).

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Design Decisions](#2-design-decisions)
3. [Data Model](#3-data-model)
4. [Security Architecture](#4-security-architecture)
5. [API Reference](#5-api-reference)
6. [Internal API (M1↔M0)](#6-internal-api-m1m0)
7. [Error Codes](#7-error-codes)
8. [Testing](#8-testing)
9. [Deployment](#9-deployment)

---

## 1. System Overview

### Tech Stack
- **Framework:** Express.js 4
- **Database:** MongoDB 6+ via Mongoose ODM
- **Auth:** JWT (15-min access + 7-day refresh, JTI rotation)
- **Validation:** Zod
- **Logging:** Pino (structured JSON)
- **Security:** Helmet, CORS, CSRF, rate-limiter, mongo-sanitize, bcryptjs

### Request Lifecycle
```
Request
  → Helmet (HTTP security headers + CSP)
  → CORS check (whitelisted origins)
  → JSON parser (body)
  → mongo-sanitize (strip $ / .)
  → urlencoded parser
  → cookie parser
  → Route → CSRF (state-changing) → JWT auth → RBAC → Validation (Zod) → Controller
  → Error handler (standardized JSON)
```

### Multi-Tenancy
- One workspace per customer; one user belongs to exactly one workspace (M0).
- Every domain document carries `workspaceId`.
- Every query is scoped by `workspaceId` extracted from the JWT (never accepted from request body/params).
- Compound unique index `(workspaceId, email)` on User prevents email reuse within a tenant.

---

## 2. Design Decisions

### 2.1 Stateless JWT with timestamp-based revocation
- Access token (15 min) carries `userId` + `workspaceId`.
- Refresh token (7 days) carries `userId` + `jti`; `jti` stored in the `RefreshToken` collection.
- On every request, middleware compares `token.iat` against `user.lastCredentialChangeAt`. If the token was issued before the user's last credential change, it's rejected.
- **Why:** Instant revocation (password change, disable user) without Redis. Stateless + horizontally scalable.

### 2.2 Permission toggles in workspace, not in JWT
- 4 toggles in `workspace.settings.permissions`: `managersCanEditScorecards`, `managersCanEditOutcomes`, `managersCanExportData`, `agentsCanViewOwnCallScores`.
- Admins can always do everything; managers/agents respect toggles.
- All default to `true` (permissive for fast onboarding; admin can lock down).
- **Why:** Change permissions without re-issuing tokens; single source of truth; clean audit trail (`PERMISSION_TOGGLES_UPDATED` logs before/after).

### 2.3 Soft deletes everywhere
- All major models have a `deletedAt` field and a `.active()` query helper.
- Deleting a team does **not** cascade-update `User.teamIds` — the historical reference is preserved for audit fidelity.
- **Why:** Audit trail integrity; recoverable deletes; no complex cascades in multi-tenant.

### 2.4 CSRF: stateless double-submit
- `GET /csrf` issues a random token + sets a SHA-256 hash in an httpOnly cookie.
- State-changing requests must send the plaintext token in `X-CSRF-Token`; server hashes and compares to the cookie.
- M0: in-memory `Map` for token tracking (single-server). Migrates to Redis at scale.

### 2.5 Audit logging is immutable
- Every state change writes one `AuditLog` row: `{workspaceId, actorUserId, actionType, entityType, entityId, metadata}`.
- 15 action types tracked. Logs are never updated or deleted.
- Logging failures don't block the user action (silent best-effort).

### 2.6 Invite tokens: hashed at rest
- Plaintext token returned **only** at creation/resend; SHA-256 hash stored on `Invite.tokenHash`.
- `expiresAt` field has a TTL index — MongoDB auto-deletes expired invites.
- Bulk invite endpoint validates entire batch atomically (no duplicates within batch; agents must have ≥1 team).

---

## 3. Data Model

### 3.1 Collections (10)

| Collection | Purpose | Key Indexes |
|---|---|---|
| `workspaces` | Tenant root + permission settings | `deletedAt`, `createdAt` |
| `users` | Person in a workspace; one role | `(workspaceId, email)` unique, `(workspaceId, role)`, `(workspaceId, teamIds)`, `deletedAt` |
| `teams` | Optional grouping | `workspaceId`, `deletedAt` |
| `invites` | Onboarding tokens | `(workspaceId, status)`, `expiresAt` (TTL) |
| `refreshtokens` | Valid JTI tracking | `jti` unique, `expiresAt` (TTL) |
| `auditlogs` | Immutable activity records | `(workspaceId, createdAt:-1)`, `(workspaceId, actorUserId)` |
| `calls` | Phone call records (master copy) | `workspaceId`, `agentId`, `teamId`, `timestamp`, `m1_instance_id` |
| `contacts` | Customer journey by phone number | `(workspaceId, phone_e164)` |
| `scorecards` | QA evaluation templates (skeleton in M0) | `workspaceId`, `teamId`, `deletedAt` |
| `outcomes` | Scorecard outcome metrics (skeleton) | `workspaceId`, `scorecardId`, `deletedAt` |

### 3.2 Roles & RBAC

| Role | Capabilities |
|---|---|
| **ADMIN** | Everything in own workspace |
| **MANAGER** | Manage users/teams/invites; edit scorecards & outcomes & export (per toggles); read all calls; read audit logs (workspace-scoped) |
| **AGENT** | Read own user data; read own calls (per toggle); cannot access audit logs |

### 3.3 Audit Action Types

```
WORKSPACE_CREATED
USER_CREATED · USER_INVITED · USER_INVITED_ACCEPTED · USER_UPDATED · USER_DISABLED
LOGIN_SUCCESS · LOGIN_FAILED · PASSWORD_CHANGED
TEAM_CREATED · TEAM_UPDATED · TEAM_DELETED
INVITE_REVOKED · INVITE_RESENT
PERMISSION_TOGGLES_UPDATED
```

### 3.4 Call ↔ M1 Idempotency

The `Call` model has an `m1_instance_id` field (indexed, unique within workspace). M1 sends `CALL_UPSERT` events to M0; M0 uses `Call.createOrUpdateFromM1Upsert(workspaceId, payload)` to either insert or merge. Re-delivery of the same M1 event is a no-op.

### 3.5 Contact Journey

`Contact` keys on normalized E.164 phone number (`phone_e164`) within a workspace. Holds raw attribution fields from M1 ingestion (`raw_channel`, `raw_campaign`, etc.) and ownership of matched lead (`matched_lead_id`, `attribution_source`). Multiple `Call` documents can reference the same `Contact` for journey timeline.

---

## 4. Security Architecture

### 4.1 Posture summary

| Control | Status | Location |
|---|---|---|
| Password hashing (bcryptjs, salt 10) | ✅ | `src/models/User.js` pre-save hook |
| Login rate limiting | ✅ | `src/middleware/rateLimiter.js` (5/15m) |
| JWT access (15m) + refresh (7d) | ✅ | `src/utils/token.js` |
| JTI rotation on refresh | ✅ | `src/utils/token.js` + `RefreshToken` collection |
| Instant revocation (`lastCredentialChangeAt`) | ✅ | `src/middleware/auth.js` |
| Invite tokens hashed (SHA-256) | ✅ | `src/models/Invite.js` |
| Invite TTL (7d) auto-delete | ✅ | TTL index on `expiresAt` |
| Workspace isolation | ✅ | All queries scoped by JWT-derived `workspaceId` |
| Email unique per workspace | ✅ | Compound unique index |
| RBAC role enforcement | ✅ | `requireRole()` middleware |
| Permission toggles (4) | ✅ | `workspace.settings.permissions` |
| Audit logging (immutable) | ✅ | `src/utils/audit.js` |
| CSRF (double-submit) | ✅ | `src/middleware/csrf.js` |
| CORS whitelist | ✅ | `src/index.js` |
| Helmet HTTP headers + CSP | ✅ | `src/index.js` |
| Mongo injection sanitization | ✅ | `express-mongo-sanitize` |
| Zod input validation | ✅ | `src/validators/schemas.js` |
| Standardized error envelope | ✅ | `src/middleware/errorHandler.js` |
| Structured logging (Pino) | ✅ | `src/config/logger.js` |
| Secrets via env | ✅ | `src/config/index.js` |

### 4.2 Known gaps (M1 work)
- Password complexity beyond min-length 8.
- HaveIBeenPwned check.
- CSRF token store → Redis.
- `npm audit` in CI.
- Jest test suite (auth, RBAC, isolation, CSRF, rate limiting).
- Request timeout middleware.
- Secret rotation procedure documented.

### 4.3 Risk view

| Risk | Status |
|---|---|
| Account takeover | 🟢 Mitigated (bcrypt + rate limit) |
| Session hijacking | 🟢 Mitigated (httpOnly + JTI rotation) |
| CSRF | 🟢 Mitigated (token + SameSite) |
| Cross-workspace data leak | 🟢 Mitigated (workspaceId scoping enforced everywhere) |
| Unauthorized admin endpoint access | 🟢 Mitigated (RBAC) |
| NoSQL injection | 🟢 Mitigated (Zod + mongo-sanitize) |
| XSS in API | 🟢 N/A (JSON-only API) |

---

## 5. API Reference

**Base URL:** `http://localhost:3000`

### 5.1 Response envelope

```jsonc
// success
{ "success": true, "data": { /* payload */ } }

// error
{ "success": false, "error": { "code": "CODE", "message": "Human-readable" } }

// validation error
{ "success": false, "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": [{ "field": "email", "error": "Invalid email" }]
}}
```

### 5.2 Auth & Session

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/workspaces` | none | Create workspace + admin user (onboarding) |
| GET | `/csrf` | none | Issue CSRF token + cookie |
| POST | `/auth/login` | CSRF | Login → access token + refresh cookie |
| POST | `/auth/refresh` | refresh cookie | New access token (rotates JTI) |
| POST | `/auth/logout` | JWT | Clear refresh cookie |
| POST | `/auth/accept-invite` | CSRF | Set password + activate invited user |

**Create workspace:**
```http
POST /workspaces
Content-Type: application/json

{
  "workspaceName": "Acme Dental",
  "industryType": "Dental",
  "timezone": "America/New_York",
  "adminEmail": "admin@acme.com",
  "adminPassword": "SecurePass123!"
}
→ 200 { workspace, user, accessToken }   // refresh in httpOnly cookie
```

**Login:**
```http
POST /auth/login
X-CSRF-Token: <token>
Content-Type: application/json
{ "email": "...", "password": "..." }
→ 200 { user, accessToken }   // refresh in httpOnly cookie
```

### 5.3 Me (current user)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/me` | JWT | Returns user + workspace + permissions + teams (frontend bootstrap) |

### 5.4 Workspaces & Settings

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/workspaces/me` | JWT | Get current workspace |
| GET | `/settings` | JWT | Workspace settings |
| PATCH | `/settings/permissions` | JWT + ADMIN + CSRF | Toggle 4 permission flags |

### 5.5 Users

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/users` | JWT | List users (filters: `role`, `status`, `teamId`, pagination) |
| PATCH | `/users/:id` | JWT + ADMIN/MANAGER + CSRF | Update role / teams / status |
| POST | `/users/:id/disable` | JWT + ADMIN + CSRF | Disable user (revokes tokens) |

### 5.6 Teams

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/teams` | JWT + ADMIN + CSRF | Create team |
| GET | `/teams` | JWT | List teams |
| PATCH | `/teams/:id` | JWT + ADMIN + CSRF | Rename team |
| DELETE | `/teams/:id` | JWT + ADMIN + CSRF | Soft delete |

### 5.7 Invites

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/invites` | JWT + ADMIN/MANAGER + CSRF | Bulk create. Returns plaintext tokens **once** |
| GET | `/invites` | JWT | List (filters: `status`, pagination) |
| POST | `/invites/:id/revoke` | JWT + ADMIN/MANAGER + CSRF | Mark REVOKED |
| POST | `/invites/:id/resend` | JWT + ADMIN/MANAGER + CSRF | New token + reset expiry |

**Bulk invite request:**
```http
POST /invites
{
  "invites": [
    { "email": "manager@acme.com", "role": "MANAGER", "teamIds": ["..."] },
    { "email": "agent@acme.com",   "role": "AGENT",   "teamIds": ["..."] }
  ]
}
```

Validation: no duplicate emails within batch; AGENT role requires ≥1 team.

### 5.8 Audit Logs

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/audit-logs` | JWT + ADMIN/MANAGER | Paginated list (filter by `actionType`) |

---

## 6. Internal API (M1↔M0)

The M1 ingestion service writes calls + contacts into M0 via internal endpoints under `/internal`. Auth: shared secret in `X-Internal-Secret` header (validated by `internalAuth` middleware).

Full OpenAPI spec: [`docs/INTERNAL_CALLS_UPSERT.openapi.yaml`](docs/INTERNAL_CALLS_UPSERT.openapi.yaml).

| Method | Path | Description |
|---|---|---|
| POST | `/internal/calls/upsert` | Idempotent call upsert via `m1_instance_id` |
| POST | `/internal/calls/analysis` | M2 scoring results posted back through M1 |

The `Call` model includes `Call.createOrUpdateFromM1Upsert(workspaceId, payload)` for atomic upsert keyed on `m1_instance_id`.

---

## 7. Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `INVALID_CREDENTIALS` | 401 | Email or password incorrect |
| `UNAUTHORIZED` | 401 | Missing or invalid token |
| `TOKEN_INVALID` | 401 | Token expired, malformed, or revoked |
| `FORBIDDEN` | 403 | Insufficient role |
| `PERMISSION_DENIED` | 403 | Workspace toggle disabled this feature |
| `CSRF_FAILED` | 403 | Missing or mismatched CSRF token |
| `WORKSPACE_NOT_FOUND` | 404 | |
| `USER_NOT_FOUND` | 404 | |
| `TEAM_NOT_FOUND` | 404 | |
| `INVITE_NOT_FOUND` | 404 | |
| `INVITE_EXPIRED` | 400 | Token past expiry |
| `EMAIL_ALREADY_EXISTS` | 409 | Email exists in this workspace |
| `DUPLICATE_EMAIL_IN_INVITES` | 400 | Duplicate in bulk request |
| `AGENT_REQUIRES_TEAM` | 400 | Agent role needs ≥1 team |
| `USER_DISABLED` | 403 | Account disabled |
| `VALIDATION_ERROR` | 400 | Body failed Zod schema |
| `INTERNAL_ERROR` | 500 | Server fault |

---

## 8. Testing

### Postman

Import `Call-Coach-Lab-API.postman_collection.json`. Environment vars to set:

| Variable | Initial value |
|---|---|
| `baseUrl` | `http://localhost:3000` |
| `accessToken` | (auto-set after login) |
| `csrfToken` | (auto-set after `/csrf`) |
| `workspaceId` | (auto-set after `POST /workspaces`) |
| `teamId` | (auto-set after `POST /teams`) |
| `inviteToken` | (auto-set after `POST /invites`) |

Pre-request script for state-changing endpoints:

```javascript
if (!pm.environment.get('csrfToken')) {
  pm.sendRequest({
    url: pm.environment.get('baseUrl') + '/csrf',
    method: 'GET'
  }, (err, res) => pm.environment.set('csrfToken', res.json().data.token));
}
```

Test script after login / create-workspace:

```javascript
pm.environment.set('accessToken', pm.response.json().data.accessToken);
```

### Curl Golden Flow

See [README.md → Golden Flow](README.md#golden-flow-end-to-end-acceptance-test) for the full step list. Each request:

1. `POST /workspaces` — capture `accessToken`, `workspace.id`
2. `GET /csrf` — capture `data.token` as `CSRF`
3. `POST /auth/login` — re-capture `accessToken`
4. `GET /me` — verify shape
5. `POST /teams` — capture `team.id`
6. `POST /invites` — capture invite tokens
7. `POST /auth/accept-invite` — verify user created
8. `PATCH /settings/permissions` — set one toggle to false
9. `POST /auth/login` (manager) — verify works
10. `GET /me` (manager) — verify toggle reflected
11. `GET /audit-logs` — verify all 8+ actions present

### RBAC Spot Checks
- Manager cannot `DELETE /teams/:id` (admin-only) → expect 403
- Manager cannot `PATCH /settings/permissions` → expect 403
- Agent cannot `GET /audit-logs` → expect 403
- Cross-workspace user lookup returns empty (workspace isolation)

---

## 9. Deployment

### Production env vars
```
NODE_ENV=production
JWT_SECRET=<32+ random bytes>
JWT_REFRESH_SECRET=<32+ random bytes>
MONGODB_URI=mongodb+srv://...
CORS_ORIGIN=https://app.callcoachlab.com
PORT=3000
```

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src ./src
EXPOSE 3000
CMD ["node", "src/index.js"]
```

### Pre-launch checklist
- [ ] Strong unique JWT secrets (≥32 chars)
- [ ] CORS whitelist matches production frontend domain
- [ ] MongoDB authentication enabled, network access limited
- [ ] HTTPS terminated at reverse proxy (Nginx / Cloudflare)
- [ ] Rate limit windows tuned
- [ ] Audit logs backed up
- [ ] DB backups scheduled
- [ ] Health check (`/health`) registered with monitoring
- [ ] No secrets committed to git (verify `.env` in `.gitignore`)

### Scaling triggers
- **CSRF map → Redis** when running >1 server instance.
- **Rate limiter → Redis store** when running >1 instance.
- **MongoDB sharding by `workspaceId`** when any tenant >1M calls.
- **Async audit log queue** when audit writes become hot path.

---

*Last updated: 2026-05-04*
