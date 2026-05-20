# Call Coach Lab — Frontend Integration Guide

**Audience:** Frontend engineers integrating with the Call Coach Lab backend
**API base (testing):** `http://15.207.18.201`
**OpenAPI spec:** ship the `openapi.yaml` to your team — paste into [editor.swagger.io](https://editor.swagger.io) or import into Postman.

---

## Table of Contents

1. [TL;DR — the rules you must follow](#1-tldr)
2. [HTTP client setup (Axios + Fetch)](#2-http-client-setup)
3. [Auth state management](#3-auth-state-management)
4. [The CSRF dance](#4-the-csrf-dance)
5. [Refresh token flow with interceptor](#5-refresh-token-flow-with-interceptor)
6. [Route reference (every endpoint)](#6-route-reference)
7. [Common error handling](#7-common-error-handling)
8. [Testing without an email inbox](#8-testing-without-an-email-inbox)
9. [Common mistakes & gotchas](#9-common-mistakes)
10. [End-to-end checklist](#10-end-to-end-checklist)

---

## 1. TL;DR

Five non-negotiables to integrate correctly:

1. **Always send credentials.** `withCredentials: true` (Axios) or `credentials: 'include'` (fetch). Otherwise refresh token & CSRF cookies don't flow.
2. **Store accessToken in memory only** (Redux, Zustand, React state). Never localStorage. Never sessionStorage.
3. **Bearer header on every protected call:** `Authorization: Bearer <accessToken>`.
4. **CSRF: GET `/csrf` once → store the body token → echo it as `X-CSRF-Token` on every POST/PATCH/DELETE.**
5. **On 401 → call `/auth/refresh` once. If that also 401s → log the user out.**

---

## 2. HTTP client setup

### Axios (recommended)

```js
// src/api/client.js
import axios from 'axios';

export const API_BASE = import.meta.env.VITE_API_BASE || 'http://15.207.18.201';

export const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,            // ← cookies in/out (refresh + csrf)
  headers: { 'Content-Type': 'application/json' },
});

// Inject Bearer token + CSRF on every outgoing request
api.interceptors.request.use((config) => {
  const accessToken = useAuthStore.getState().accessToken;
  const csrfToken   = useAuthStore.getState().csrfToken;

  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;

  // CSRF only on state-changing methods
  if (csrfToken && ['post', 'patch', 'delete', 'put'].includes(config.method)) {
    config.headers['X-CSRF-Token'] = csrfToken;
  }

  return config;
});
```

### Fetch (vanilla)

```js
async function apiFetch(path, { method = 'GET', body, accessToken, csrfToken } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    credentials: 'include',                // ← REQUIRED
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}
```

---

## 3. Auth state management

Minimal recommended shape (Zustand example — adapt to Redux / Pinia / context):

```js
// src/stores/auth.js
import { create } from 'zustand';

export const useAuthStore = create((set) => ({
  accessToken: null,    // JWT — short-lived, kept in memory
  csrfToken:   null,    // Random token from GET /csrf
  user:        null,    // { id, email, name, role, teamIds, status }
  workspace:   null,    // { id, name, industryType, ... }
  permissions: null,    // { managersCanEditScorecards, ... }

  setAuth:  (auth)  => set(auth),
  clear:    ()      => set({ accessToken: null, user: null, workspace: null, permissions: null }),
}));
```

**On page reload everything resets.** That's intentional — refresh-on-load (see §5) restores the session.

---

## 4. The CSRF dance

### When to call `GET /csrf`

- Once on app boot (after refresh succeeds, if user is logged in).
- After every server restart you observe (when CSRF starts failing in dev — see "Known M0 limitations").
- After 1 hour (token expires).

```js
async function loadCsrf() {
  const { data } = await api.get('/csrf');
  useAuthStore.getState().setAuth({ csrfToken: data.data.csrfToken });
}
```

### What it does behind the scenes

```
GET /csrf
  ─► Server returns:
        Body: { success, data: { csrfToken: "abc..." } }
        Set-Cookie: csrf-token=xyz...  (httpOnly, browser stores)

You store csrfToken in memory.
Browser stores csrf-token cookie automatically.

Next time you POST:
  Headers:    X-CSRF-Token: abc...   (← you add this)
  Cookie:     csrf-token=xyz...      (← browser sends automatically)

Server: hash(abc) === stored[xyz]  → ✅ allow
```

If you forget the header on POST/PATCH/DELETE → **403 FORBIDDEN, code: FORBIDDEN, message: "CSRF token missing"**.

---

## 5. Refresh token flow with interceptor

```js
// src/api/client.js (continued)

let isRefreshing = false;
let queue = [];

function flushQueue(error, token = null) {
  queue.forEach((p) => (error ? p.reject(error) : p.resolve(token)));
  queue = [];
}

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config;
    const status   = err.response?.status;
    const code     = err.response?.data?.error?.code;

    // Don't retry refresh itself, login, register, etc.
    const isRefreshCall = original.url.includes('/auth/refresh');
    const isAuthEndpoint = ['/auth/login', '/auth/register', '/auth/accept-invite']
      .some((p) => original.url.includes(p));

    if (status === 401 && !original._retry && !isRefreshCall && !isAuthEndpoint) {
      if (isRefreshing) {
        // Queue this request until refresh completes
        return new Promise((resolve, reject) => queue.push({ resolve, reject }))
          .then((token) => {
            original.headers.Authorization = `Bearer ${token}`;
            return api(original);
          });
      }

      original._retry = true;
      isRefreshing = true;

      try {
        const { data } = await api.post('/auth/refresh');
        const newToken = data.data.auth.accessToken;
        useAuthStore.getState().setAuth({ accessToken: newToken });

        flushQueue(null, newToken);
        original.headers.Authorization = `Bearer ${newToken}`;
        return api(original);
      } catch (refreshErr) {
        flushQueue(refreshErr, null);
        useAuthStore.getState().clear();
        // redirect to /login
        window.location.href = '/login';
        return Promise.reject(refreshErr);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(err);
  }
);
```

### Restoring session on page reload

```js
// App.jsx (top-level)
useEffect(() => {
  (async () => {
    try {
      const { data } = await api.post('/auth/refresh'); // uses cookie
      useAuthStore.getState().setAuth({ accessToken: data.data.auth.accessToken });
      await loadCsrf();
      const me = await api.get('/me');
      useAuthStore.getState().setAuth({
        user: me.data.data.user,
        workspace: me.data.data.workspace,
        permissions: me.data.data.permissions,
      });
    } catch {
      // Not logged in — stay on public route
    }
  })();
}, []);
```

---

## 6. Route reference

Legend:
- 🟢 = public (no auth needed)
- 🔒 = requires Bearer token
- 🛡 = requires CSRF header (POST/PATCH/DELETE)
- 👑 = ADMIN only
- 🤝 = ADMIN or MANAGER

### CSRF

| Method | Path | Auth |
|---|---|---|
| 🟢 GET | `/csrf` | none — but call AFTER login |

### Auth

| Method | Path | Auth | Notes |
|---|---|---|---|
| 🟢 POST | `/auth/register` | — | DEV: returns `_devOnly_verificationToken` |
| 🟢 POST | `/auth/verify-email` | — | returns `setupToken` |
| 🟢 GET | `/auth/verify-email?token=` | — | redirect-friendly variant |
| 🟢 POST | `/auth/resend-verification` | — | DEV: returns `_devOnly_verificationToken` |
| 🟢 POST | `/auth/login` | — | sets `refreshToken` cookie |
| 🔒 POST | `/auth/logout` | Bearer | invalidates ALL access tokens |
| 🟢 POST | `/auth/refresh` | cookie | sets new `refreshToken` cookie |
| 🟢 POST | `/auth/forgot-password` | — | DEV: returns `_devOnly_resetToken` |
| 🟢 POST | `/auth/reset-password` | — | |
| 🟢 POST | `/auth/accept-invite` | — | rate-limited 10/hr |

### Me

| Method | Path | Auth | Notes |
|---|---|---|---|
| 🔒 GET | `/me` | Bearer | returns user + workspace + permissions + teams |
| 🔒🛡 PATCH | `/me` | Bearer + CSRF | update own name |
| 🔒🛡 POST | `/me/change-password` | Bearer + CSRF | invalidates all sessions on success |

### Workspaces

| Method | Path | Auth | Notes |
|---|---|---|---|
| 🟢 POST | `/workspaces/setup` | setupToken Bearer | one-time onboarding |
| 🔒 GET | `/workspaces/me` | Bearer | current workspace |
| 🔒🛡👑 PATCH | `/workspaces/me` | Bearer + CSRF | name, timezone, languagesEnabled |

### Teams

| Method | Path | Auth | Notes |
|---|---|---|---|
| 🔒 GET | `/teams` | Bearer | paginated |
| 🔒🛡🤝 POST | `/teams` | Bearer + CSRF | unique name per workspace |
| 🔒🛡🤝 PATCH | `/teams/:teamId` | Bearer + CSRF | rename |
| 🔒🛡👑 DELETE | `/teams/:teamId` | Bearer + CSRF | blocked if any AGENT would be left without team |

### Users

| Method | Path | Auth | Notes |
|---|---|---|---|
| 🔒🤝 GET | `/users` | Bearer | filters: role, status, teamId, paginated |
| 🔒🛡🤝 PATCH | `/users/:userId` | Bearer + CSRF | role / teamIds / status |
| 🔒🛡🤝 POST | `/users/:userId/disable` | Bearer + CSRF | last-admin protection |
| 🔒🛡🤝 POST | `/users/:userId/enable` | Bearer + CSRF | re-enable |

### Invites

| Method | Path | Auth | Notes |
|---|---|---|---|
| 🟢 GET | `/invites/preview?token=` | — | render "You've been invited" page |
| 🔒🛡🤝 POST | `/invites` | Bearer + CSRF | bulk; AGENT needs ≥1 team |
| 🔒🤝 GET | `/invites` | Bearer | filters: status |
| 🔒🛡🤝 POST | `/invites/:id/revoke` | Bearer + CSRF | |
| 🔒🛡🤝 POST | `/invites/:id/resend` | Bearer + CSRF | max 5 resends |

### Settings

| Method | Path | Auth | Notes |
|---|---|---|---|
| 🔒 GET | `/settings` | Bearer | permissions object |
| 🔒🛡👑 PATCH | `/settings/permissions` | Bearer + CSRF | toggle 4 booleans |

### Audit Logs

| Method | Path | Auth | Notes |
|---|---|---|---|
| 🔒🤝 GET | `/audit-logs` | Bearer | paginated; filter by actionType |

---

## 7. Common error handling

```js
function handleApiError(err) {
  const code = err.response?.data?.error?.code;
  const msg  = err.response?.data?.error?.message;

  switch (code) {
    case 'INVALID_CREDENTIALS':
      return showToast('Wrong email or password');
    case 'EMAIL_NOT_VERIFIED':
      return navigate('/verify-email-prompt');
    case 'ACCOUNT_LOCKED':
      return showToast(`Account locked. ${msg}`);
    case 'USER_DISABLED':
      return showToast('Your account has been disabled. Contact your admin.');
    case 'TOKEN_INVALID':
    case 'UNAUTHORIZED':
      // Interceptor already attempted refresh; we're here means refresh failed.
      return navigate('/login');
    case 'FORBIDDEN':
      if (msg.toLowerCase().includes('csrf')) {
        return loadCsrf().then(() => /* retry once */);
      }
      return showToast('You do not have permission to do this');
    case 'VALIDATION_ERROR':
    case 'WEAK_PASSWORD':
    case 'INVALID_EMAIL':
      return showFieldError(msg);
    case 'RATE_LIMIT_EXCEEDED':
      return showToast('Too many requests. Please slow down.');
    case 'INVITE_EXPIRED':
    case 'INVITE_NOT_FOUND':
    case 'INVITE_REVOKED':
    case 'INVITE_ALREADY_ACCEPTED':
      return navigate('/invite-invalid');
    default:
      return showToast(msg || 'Something went wrong');
  }
}
```

### Status codes you'll see

| Status | Meaning |
|---|---|
| 200 / 201 | Success |
| 400 | Validation / business rule violation |
| 401 | Auth missing / invalid / expired |
| 403 | Forbidden (role / CSRF / disabled) |
| 404 | Resource doesn't exist |
| 409 | Conflict (duplicate name / email) |
| 410 | Gone (invite expired / revoked / accepted) |
| 423 / 429 | Locked / rate-limited |
| 500 | Backend bug — file an issue |

---

## 8. Testing without an email inbox

The backend emails verification, password-reset, and invite tokens. In development (`NODE_ENV !== 'production'`) the **raw token is also returned in the JSON response** for testing convenience.

| Endpoint | Field |
|---|---|
| `POST /auth/register` | `data._devOnly_verificationToken` |
| `POST /auth/resend-verification` | `data._devOnly_verificationToken` |
| `POST /auth/forgot-password` | `data._devOnly_resetToken` |
| `POST /invites` | `data.invites[i]._devOnly_inviteToken` |
| `POST /invites/:id/resend` | `data.invite._devOnly_inviteToken` |

In production these fields are never returned. Frontend should not rely on them — they exist purely for testing.

---

## 9. Common mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| Forgetting `withCredentials: true` | `/auth/refresh` returns 401 even though user is logged in | Set globally on the Axios instance |
| Storing accessToken in localStorage | Token persists across tabs but XSS-stealable | Use memory only |
| Calling `/csrf` before login | Pointless — CSRF cookie is set but cleared by login | Call `/csrf` AFTER session is established |
| Sending CSRF on GET | No effect | Only on POST/PATCH/DELETE |
| Trying to read cookies from JS | Always returns nothing | Cookies are httpOnly. Don't try. |
| Not handling 401 retry-once | Infinite refresh loop on permanent 401 | Use the `_retry` flag pattern in §5 |
| Confusing `setupToken` with `accessToken` | "TOKEN_INVALID" on `/me` | Setup token is ONLY for `/workspaces/setup` |
| Confusing `setupToken` with invite token | "INVITE_NOT_FOUND" on accept-invite | They're different flows; see §9 of architecture doc |
| Building UI assuming admin has team membership | Empty `teams` array confuses dropdown | ADMIN/MANAGER are workspace-wide; `/me.teams` is empty for them. Use `GET /teams` for picker. |
| Hard-coding email links | Email points to `localhost:3001` in dev | Backend `APP_URL` controls this; ignore the URL during testing — use the token only |

---

## 10. End-to-end checklist

A working frontend integration must:

- [ ] Load CSRF after login: `loadCsrf()` after each `/auth/login`, `/auth/accept-invite`, `/workspaces/setup`, `/auth/refresh`.
- [ ] Bearer header attached automatically by Axios interceptor.
- [ ] CSRF header attached automatically on POST/PATCH/DELETE.
- [ ] `withCredentials: true` set globally.
- [ ] 401 → refresh → retry interceptor in place.
- [ ] On page reload, attempt `/auth/refresh` to restore session.
- [ ] Logout calls `/auth/logout` AND clears local store AND redirects to login.
- [ ] Show user-friendly errors for each common error code.
- [ ] Handle `EMAIL_NOT_VERIFIED` by navigating to a verification-prompt screen.
- [ ] Treat `EMAIL_VERIFIED` (no workspace) as "go to workspace setup" rather than "logged in".
- [ ] Hide / disable buttons based on `req.user.role` AND server-side toggles in `permissions`.
- [ ] Don't show "Delete team" button to MANAGER (it's ADMIN-only).
- [ ] Don't show "Workspace settings" / "Permissions" to MANAGER (ADMIN-only).
- [ ] After a password change, log the user out and return to login (server killed the session).
- [ ] After server says `USER_DISABLED`, hard-redirect to login — that user cannot operate anymore.

---

## How to convert these docs to PDF

You have two .md files in `coachLab/docs/`. Three quick options:

1. **VS Code:** open the `.md`, install the "Markdown PDF" extension, right-click → "Markdown PDF: Export (pdf)".
2. **Pandoc (CLI):** `pandoc BACKEND_ARCHITECTURE.md -o BACKEND_ARCHITECTURE.pdf`
3. **Online:** paste the markdown into [md2pdf.netlify.app](https://md2pdf.netlify.app) or `https://www.markdowntopdf.com/` — drag, click, download.

For the cleanest enterprise look, use **VS Code → Markdown PDF** with the GitHub theme.

---
