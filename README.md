# Call Coach Lab — Core Backend (M0)

Production-ready Node.js + Express + MongoDB backend implementing the multi-tenant, role-based foundation for Call Coach Lab. Owns auth, workspaces, users, teams, scorecards, calls, contacts, and audit logs. Talks to the M1 ingestion service (`../coachLab-m1`) over an internal HTTP API.

> See [ARCHITECTURE.md](ARCHITECTURE.md) for design decisions and full API reference. See [ROADMAP.md](ROADMAP.md) for what's next.

---

## Quick Start

### Prerequisites
- Node.js 18+
- MongoDB 6.0+ (local, Docker, or Atlas)
- Postman or curl

### Install

```bash
cd coachLab
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
MONGODB_URI=mongodb://localhost:27017/call-coach-lab
JWT_SECRET=<32+ chars>
JWT_REFRESH_SECRET=<32+ chars>
PORT=3000
HOST=localhost
NODE_ENV=dev
CORS_ORIGIN=http://localhost:3001
```

Generate strong secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Start MongoDB

```bash
# Docker (cross-platform)
docker run -d -p 27017:27017 --name mongodb mongo:latest

# macOS Homebrew
brew services start mongodb-community

# Windows
Get-Service MongoDB | Start-Service
```

### Run

```bash
npm run dev          # auto-reload (nodemon)
npm start            # production
```

Health check: `curl http://localhost:3000/health` → `{ "success": true, "message": "Server is healthy" }`

---

## Golden Flow (End-to-End Acceptance Test)

This is the canonical 11-step test that exercises auth, RBAC, permissions, audit logging. Run it via Postman (`Call-Coach-Lab-API.postman_collection.json`) or curl.

| # | Action | Endpoint | Verifies |
|---|---|---|---|
| 1 | Create workspace | `POST /workspaces` | Workspace + admin user created, all 4 permissions = TRUE |
| 2 | Get CSRF token | `GET /csrf` | Token + httpOnly cookie issued |
| 3 | Login | `POST /auth/login` | Access token returned, refresh cookie set |
| 4 | Get current user | `GET /me` | Returns user + workspace + permissions + teams |
| 5 | Create team | `POST /teams` | Team created, admin can manage |
| 6 | Bulk invite (manager + agent) | `POST /invites` | 2 invites with one-time tokens |
| 7 | Accept invite (manager) | `POST /auth/accept-invite` | User created, status=ACTIVE |
| 8 | Update permissions | `PATCH /settings/permissions` | Toggle persists, audit logged |
| 9 | Login as manager | `POST /auth/login` | Manager credentials accepted |
| 10 | Manager `/me` shows updated permissions | `GET /me` | Reflects step 8 changes |
| 11 | Admin views audit logs | `GET /audit-logs` | Contains 8+ action types from above |

**Expected audit events:** `WORKSPACE_CREATED`, `USER_INVITED ×2`, `USER_INVITED_ACCEPTED`, `LOGIN_SUCCESS ×2`, `PERMISSION_TOGGLES_UPDATED`.

### Curl quick-runner

```bash
# Step 1
curl -X POST http://localhost:3000/workspaces \
  -H "Content-Type: application/json" \
  -d '{"workspaceName":"Acme Dental","industryType":"Dental","timezone":"America/New_York","adminEmail":"admin@acme.com","adminPassword":"SecurePass123!"}'

# Step 2
curl http://localhost:3000/csrf

# Step 3
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" -H "X-CSRF-Token: <token>" \
  -d '{"email":"admin@acme.com","password":"SecurePass123!"}'
```

Full curl + Postman walkthrough is in [ARCHITECTURE.md → Testing](ARCHITECTURE.md#testing).

---

## Project Structure

```
coachLab/
├── src/
│   ├── index.js              # Express bootstrap (helmet, CORS, mongo-sanitize, routes)
│   ├── config/               # env, logger (Pino), database (Mongoose connect)
│   ├── models/               # 10 schemas: Workspace, User, Team, Invite, Call, Contact,
│   │                         # Scorecard, Outcome, AuditLog, RefreshToken
│   ├── controllers/          # workspace, auth, user, team, invite, settings, audit, me, internalCall
│   ├── routes/               # one per resource: /auth /workspaces /teams /users /invites /me
│   │                         # /settings /audit-logs /internal /csrf
│   ├── middleware/           # auth (JWT+RBAC), csrf, validation (Zod), errorHandler,
│   │                         # rateLimiter, internalAuth
│   ├── validators/           # Zod schemas
│   └── utils/                # token, errors, audit logger, response helpers
├── docs/
│   └── INTERNAL_CALLS_UPSERT.openapi.yaml   # M1↔M0 internal contract
├── Call-Coach-Lab-API.postman_collection.json
├── package.json
├── .env.example
├── README.md                 # this file
├── ARCHITECTURE.md           # design + full API reference
└── ROADMAP.md                # next-up + future
```

---

## Common Issues

### MongoDB: `Operation buffering timed out after 10000ms`
Your code is connecting before MongoDB is reachable. Fixes:
1. Verify connection string in `.env` — Atlas users: ensure password is URL-encoded (`@` → `%40`).
2. **Atlas:** add your IP under Network Access (or `0.0.0.0/0` for dev — not for prod).
3. Connection string already includes sane timeouts: `serverSelectionTimeoutMS=5000&socketTimeoutMS=45000`.
4. Verify locally: `mongosh "$MONGODB_URI"`.

### Port already in use
```bash
# Find and kill (Linux/macOS)
lsof -i :3000 ; kill -9 <PID>
# Windows
Get-NetTCPConnection -LocalPort 3000 | Select-Object OwningProcess
Stop-Process -Id <PID> -Force
```
Or change `PORT` in `.env`.

### `JWT secret must be at least 32 characters`
Generate proper secrets — see Configure step above. Both `JWT_SECRET` and `JWT_REFRESH_SECRET` must be ≥32 chars.

### `VALIDATION_ERROR` on a request
Check the request body against the Zod schemas in `src/validators/schemas.js`. Common causes: missing `Content-Type: application/json`, invalid email format, password <8 chars, role not in `{ADMIN,MANAGER,AGENT}`.

### `TOKEN_INVALID` (token expired)
Access tokens are 15 min. Either call `POST /auth/refresh` (uses the refresh cookie) or log in again.

### CSRF: `403 Forbidden`
You forgot to call `GET /csrf` first, or you sent the wrong header name. State-changing requests require the `X-CSRF-Token` header **and** the matching `csrfToken` cookie (auto-set by `/csrf`).

### Cross-workspace queries return empty
That's correct — every query is scoped by `req.workspaceId` extracted from the JWT. You cannot query another tenant's data.

---

## Service Boundaries (you are here: M0)

```
┌───────────────────────────────────────────────────────────────┐
│  Frontend (Next.js — TBD)                                     │
└────────────────┬──────────────────────────────────────────────┘
                 │ JWT in HTTP-only cookie
                 ▼
┌───────────────────────────────────────────────────────────────┐
│  M0 — Core Backend  (this service, port 3000)                 │
│  Auth, workspaces, users, teams, scorecards (master),         │
│  calls (master), contacts, audit logs                         │
└────────────────┬──────────────────────────────────────────────┘
                 │ shared-secret HTTP (M1→M0 internal API)
                 ▼
┌───────────────────────────────────────────────────────────────┐
│  M1 — Ingestion + Telephony  (../coachLab-m1, port 3001)      │
│  Twilio webhooks, S3 upload, M2 dispatch, bulk CSV ingestion  │
└────────────────┬──────────────────────────────────────────────┘
                 │ POST /analyze
                 ▼
┌───────────────────────────────────────────────────────────────┐
│  M2 — AI Scoring  (Python + FastAPI, future)                  │
│  ASR + diarization + scorecard evaluation + evidence          │
└───────────────────────────────────────────────────────────────┘
```

---

## License

Proprietary — Call Coach Lab. All rights reserved.
