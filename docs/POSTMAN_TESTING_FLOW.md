# CoachLab — Postman Testing Flow

**Base URL:** `http://15.207.18.201` (EC2) or `http://localhost:3000` (local)

Hit the routes **in this exact order**. Each step tells you what to copy from the response and where to paste it next.

---

## 🟢 STEP 1 — Register a new admin

**`POST /auth/register`**

Body:
```json
{
  "email": "test-admin@example.com",
  "password": "AcmeSecure!2026"
}
```

✅ Copy `data._devOnly_verificationToken` from response → use in **Step 2**.

---

## 🟢 STEP 2 — Verify email

**`POST /auth/verify-email`**

Body:
```json
{
  "token": "<paste _devOnly_verificationToken from Step 1>"
}
```

✅ Copy `data.setupToken` from response → use in **Step 3**.

---

## 🟢 STEP 3 — Create the workspace (one-time onboarding)

**`POST /workspaces/setup`**

Headers:
```
Authorization: Bearer <paste setupToken from Step 2>
```

Body:
```json
{
  "workspaceName": "Acme Dental",
  "industryType": "Dental",
  "timezone": "America/New_York"
}
```

✅ Copy `data.auth.accessToken` from response → use as Bearer token everywhere from now on.
✅ Cookie `refreshToken` is set automatically by Postman — leave it alone.

---

## 🟢 STEP 4 — Get a CSRF token

**`GET /csrf`**

Headers:
```
Authorization: Bearer <accessToken from Step 3>
```

✅ Copy `data.csrfToken` from response. You'll send it as `X-CSRF-Token` header on every POST/PATCH/DELETE.
✅ Cookie `csrf-token` is set automatically.

---

## 🟢 STEP 5 — Sanity check: who am I?

**`GET /me`**

Headers:
```
Authorization: Bearer <accessToken>
```

Should return your user, workspace, permissions, and `teams: []` (admins aren't team members).

---

## 🟢 STEP 6 — Create a team

**`POST /teams`**

Headers:
```
Authorization: Bearer <accessToken>
X-CSRF-Token: <csrfToken from Step 4>
```

Body:
```json
{ "name": "Front Desk" }
```

✅ Copy `data.id` (team ID) → use in Step 7.

---

## 🟢 STEP 7 — Send an invite to an AGENT

**`POST /invites`**

Headers:
```
Authorization: Bearer <accessToken>
X-CSRF-Token: <csrfToken>
```

Body:
```json
{
  "invites": [
    {
      "email": "agent1@example.com",
      "role": "AGENT",
      "teamIds": ["<team ID from Step 6>"]
    }
  ]
}
```

✅ Copy `data.invites[0]._devOnly_inviteToken` → use in Step 8.

> Rules:
> - AGENT must have ≥1 team
> - ADMIN / MANAGER must have empty `teamIds: []`

---

## 🟢 STEP 8 — Preview the invite (public — no auth)

**`GET /invites/preview?token=<paste _devOnly_inviteToken from Step 7>`**

Returns `{ email, role, workspaceName, alreadyHasAccount }` so the UI can render "You've been invited to {workspace}".

---

## 🟢 STEP 9 — Accept the invite (creates the agent's account)

**`POST /auth/accept-invite`**

(No auth — public endpoint, the token is the credential.)

Body:
```json
{
  "token": "<_devOnly_inviteToken from Step 7>",
  "password": "AgentPass!2026",
  "name": "Agent One"
}
```

✅ Returns `{ user, workspace, auth: { accessToken } }` — the agent is now logged in.

---

## 🟢 STEP 10 — List members

**`GET /users`**

Headers:
```
Authorization: Bearer <admin's accessToken>
```

Query (optional): `?role=AGENT` or `?status=ACTIVE` or `?teamId=<id>`

---

## 🟢 STEP 11 — Update a member (e.g. promote AGENT to MANAGER)

**`PATCH /users/<userId>`**

Headers:
```
Authorization: Bearer <accessToken>
X-CSRF-Token: <csrfToken>
```

Body:
```json
{ "role": "MANAGER", "teamIds": [] }
```

> MANAGER and ADMIN must have empty teamIds. AGENT must have ≥1 team.

---

## 🟢 STEP 12 — Disable / re-enable a user

**Disable:**
`POST /users/<userId>/disable` (Bearer + CSRF, no body)

**Enable:**
`POST /users/<userId>/enable` (Bearer + CSRF, no body)

---

## 🟢 STEP 13 — Get / update workspace settings

**`GET /settings`** → returns permission toggles
**`PATCH /settings/permissions`** (ADMIN + CSRF) — toggle 4 booleans:
```json
{
  "managersCanEditScorecards": false,
  "managersCanEditOutcomes": true,
  "managersCanExportData": true,
  "agentsCanViewOwnCallScores": true
}
```

---

## 🟢 STEP 14 — Update the workspace itself

**`PATCH /workspaces/me`** (ADMIN + CSRF)

```json
{ "name": "Acme Dental Renamed", "timezone": "Asia/Kolkata" }
```

---

## 🟢 STEP 15 — Audit logs

**`GET /audit-logs?actionType=TEAM_CREATED`** (ADMIN/MANAGER)

Returns paginated audit history.

---

## 🔁 LOGIN AGAIN LATER

When the agent (or admin) comes back another day:

**`POST /auth/login`**
```json
{ "email": "agent1@example.com", "password": "AgentPass!2026" }
```
✅ New `accessToken` in body, refresh cookie set.
✅ Then call `GET /csrf` again to get a new CSRF token.

---

## 🔁 ACCESS TOKEN EXPIRED (after 15 min)

**`POST /auth/refresh`** (no body, no auth header — relies on the cookie)

✅ New `accessToken` in body.

---

## 🔁 PASSWORD RESET

1. `POST /auth/forgot-password` `{ "email": "..." }` → copy `_devOnly_resetToken`
2. `POST /auth/reset-password` `{ "token": "...", "password": "NewPass!2026" }`
3. Login again — all old sessions are killed automatically.

---

## 🔁 LOGOUT

**`POST /auth/logout`** (Bearer)

Kills all current access tokens and clears the refresh cookie.

---

## 🚫 Common errors and what they mean

| Code | Likely cause |
|---|---|
| `TOKEN_INVALID` / 401 | accessToken expired (15m) → call `/auth/refresh` |
| `FORBIDDEN` "CSRF token missing" | Forgot `X-CSRF-Token` header on POST/PATCH/DELETE → call `/csrf` again |
| `FORBIDDEN` "Insufficient permissions" | You're MANAGER trying to do an ADMIN action |
| `INVITE_NOT_FOUND` on accept-invite | Wrong token — you sent setupToken instead of inviteToken |
| `EMAIL_NOT_VERIFIED` on login | Skipped Step 2 |
| `WORKSPACE_NOT_FOUND` | Skipped Step 3 (no workspace yet — use setupToken instead) |
| `RATE_LIMIT_EXCEEDED` | You hit a route too many times — wait it out |

---

## 📋 Postman quick setup

1. Create a Postman **Environment** with variables:
   - `baseUrl` = `http://15.207.18.201`
   - `accessToken` = (set after Step 3)
   - `csrfToken` = (set after Step 4)
2. Use `{{baseUrl}}/auth/login` etc. in URLs.
3. Add to Collection-level **Authorization** tab: type `Bearer Token`, value `{{accessToken}}` — applies to all requests.
4. Add to Collection-level **Headers**: `X-CSRF-Token: {{csrfToken}}` — applies to all requests.
5. **Enable cookies** in Postman (default on) so refresh + CSRF cookies persist.

That's it — start at Step 1 and follow the chain.
