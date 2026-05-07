# Roadmap & Execution Plan

What's done, what's next, and how it ties into the Call Coach Lab v1 product milestones. The product context (user journeys, scorecard model, contact journey, etc.) lives in the v1 Bible and Build Backlog PDFs at the project root. This document is the engineering view, scoped to this repo (`coachLab/` = M0 service) and its sister service `coachLab-m1/`.

---

## Where things stand

### ✅ M0 — Foundations (this service)
Production-ready. All v1 prerequisites for auth + workspace + RBAC + audit:
- JWT auth with refresh rotation + instant revocation via `lastCredentialChangeAt`
- Multi-tenant isolation enforced on every query
- 4 permission toggles in `workspace.settings`
- Bulk invite system with hashed tokens + TTL
- Immutable audit log (15 action types)
- CSRF (double-submit), CORS whitelist, Helmet+CSP, mongo-sanitize, rate limiting
- Internal API for M1↔M0 idempotent call upsert

### ✅ M1 — Telephony pipeline (`../coachLab-m1`)
Just completed: full Twilio recorded-audio path.
- `/twilio/voice` (TwiML), `/twilio/status`, `/twilio/recording`, `/twilio/dial-status`
- Twilio signature validation
- Bull queue: download recording → S3 upload (SSE-AES256) → presigned URL → POST M2 `/analyze`
- `CallAssignment` state machine: `pending → recorded → uploading → uploaded → sent_to_m2 → analyzed`
- M2 callback receiver at `/m2/callback`
- `AgentMapping` (per workspace) for resolving agent from external Twilio number
- S3 connectivity verified

### ⚠️ M1 — Bulk Upload (partial)
Model + state machine exist (`IngestionJob.js`); validate→preview→process flow not yet wired end-to-end in the controller layer.

### ❌ Not yet built
- **M2 (Python AI service)** — referenced via `M2_API_URL`, does not exist as code
- **Exotel ingestion** — only Twilio is implemented
- **Scorecard builder full schema** (`Scorecard` is a skeleton in M0)
- **QA queue rules engine** (lowest score / unclear / critical fail / new rep / random sample / trigger terms)
- **Override system** (manager corrects criterion → recompute score → audit)
- **Outcome mapping rules engine** (call outcome → contact stage / final outcome)
- **Outcome mismatch detector** (transcript vs agent-set outcome)
- **Insights aggregations** (Marketing ROI, QA Trends, Voice of Customer)
- **Evidence pack PDF + share-link expiry/revoke**
- **Notifications** (in-app + email digests via SES)
- **Lead Attribution Resolver** (UTM CSV import + phone+time-window matching)
- **Frontend SPA**

---

## Phase plan (firm order, dates intentionally blank)

### Phase 1 — Stabilize foundations
- Rotate **all** secrets (`.env` is currently checked in with live AWS + Twilio creds in coachLab-m1) — move to AWS Parameter Store or Doppler
- Scrub git history (`git filter-repo`)
- `Dockerfile` + `docker-compose.yml` for both services
- GitHub Actions CI: lint + Jest + build on PR
- Initial test scaffolding: auth, JWT validation, workspace isolation, CSRF, Twilio signature, S3 round-trip
- Add `TwilioNumberMapping(phoneNumber → workspaceId)` so the same `/twilio/voice` URL serves all tenants

### Phase 2 — M2 AI service (critical path, blocking v1)
- FastAPI service with `/analyze` and `/health`
- Whisper-large-v3 ASR (Hindi + English + Punjabi) on GPU (Modal/Replicate)
- Pyannote channel-based diarization (dual-channel input)
- LLM scorer: scorecard JSON + transcript → per-criterion `{status, confidence, evidence, reason}` via JSON-mode
- "Unclear" semantics enforced (low confidence or missing evidence)
- HMAC-signed callback to M1
- E2E target: real recording → score in < 3 min p95

### Phase 3 — Scorecard builder + versioning
On M0:
- Full `Scorecard` + `ScorecardVersion` schema (sections, criteria, points, critical fails, evidence requirements)
- Versioning: `DRAFT` / `ACTIVE` / `ARCHIVED`; publish creates new version
- Templates: Inbound Lead, Follow-up, Consult
- M2 reads active scorecard from M0 at scoring time (60s cache)

### Phase 4 — QA Queue + Call Review
- QA queue rules engine (the 6 modes)
- `GET /calls/:id/review` returns audio presigned URL + synced transcript + per-criterion results + flags + override controls + journey
- Override system: stores original AI value, manager final value, reason; recomputes call score; audit-logged
- "Send next action" → in-app notification on M0

### Phase 5 — Outcomes + Contact Journey
- Per-scorecard outcome sets (agent UI to set)
- `OutcomeMappingRule` engine (configurable per workspace)
- Contact journey aggregation API (timeline of calls + final outcome)
- Outcome mismatch detector: post-scoring on M0, flags discrepancy between transcript signal and agent-set outcome

### Phase 6 — Insights + Exports
- Nightly aggregation cron → `InsightSnapshot` collection
- Marketing ROI / QA Trends / Voice of Customer dashboards
- Evidence pack PDF generator + share-link with expiry + revoke
- CSV export, audio download (permission-checked), CRM-note copy block

### Phase 7 — Exotel + polish
- Exotel ingestion (mirrors Twilio architecture)
- Notifications (in-app + email weekly digest)
- Lead Attribution Resolver (UTM CSV import, phone+time-window match)

### Phase 8 — Frontend (parallel from Phase 3)
Next.js + Tailwind + shadcn/ui. Screens per the v1 Build Backlog PDF:
- Onboarding wizard
- Home / Calls Inbox / QA Queue / Call Review / Scorecard Builder
- Insights (3 tabs)
- Team page / Contact Journey
- Agent: My Evaluations / Evaluation Detail

---

## Definition of done for v1

Every box in the Build Backlog PDF Section 11 (Acceptance Criteria) passes:

- p95 scoring SLA < 5 min on real calls
- Every score has evidence + confidence OR Unclear
- Overrides logged (AI vs final)
- Outcome mismatch flagged (not silently overwritten)
- Hindi + English + Punjabi transcription works (mixed-language calls don't break scoring)
- Evidence pack PDF includes score + evidence; share links expire and revoke
- 1 paying pilot running 100+ calls/day for 2 weeks without manual intervention

---

## Engineering deliverables (workstream view)

| Workstream | Deliverables | Dependencies |
|---|---|---|
| **Auth & Roles** *(✅ M0 done)* | Workspace, invites, roles, manager permission toggles | — |
| **Ingestion** *(⚠️ Twilio done, Exotel + bulk pending)* | Upload+CSV validator, Exotel ingest, retries, S3 storage | Auth |
| **Processing** *(❌)* | Multi-language transcribe, diarization, scoring, evidence extraction, SLA monitoring | Ingestion |
| **Review Backend** *(❌)* | QA queue rules, call review endpoints, override + audit log | Processing |
| **Outcomes / Journey** *(❌)* | Call outcomes, mismatch detection, contact linking, mapping rules | Processing |
| **Insights** *(❌)* | Aggregations by source/channel, QA trends, VoC topics | Outcomes |
| **Exports** *(❌)* | Evidence pack PDF, share links, CSV export, audio download, CRM notes | Review |
| **Observability** *(⚠️ logs only)* | Metrics for ingest success, SLA, unclear rate, override rate; Sentry; OTel tracing | All |

---

## Beyond v1

- **v1.5:** Browser softphone (Twilio Voice SDK), TaskRouter queues, multi-workspace per user, password reset flow
- **v2:** Live transcription via Twilio Media Streams + streaming ASR (only if v1 misses SLA at scale)
- **v2:** Twilio subaccount-per-workspace isolation
- **v2:** Mobile app, multi-location workspaces, missed-call tracking
- **v2:** Email integration for inbox-style call surfacing
- **v3:** AI-powered learning plans (full coaching mode)

---

## Risks (top 5 to manage)

1. **Leaked secrets** — Phase 1 must rotate everything. Currently the highest-impact, lowest-effort risk.
2. **M2 quality on Hindi/Punjabi** — without language-specific eval sets, scoring trust collapses. Bias toward "Unclear" when uncertain; manager override + drift monitoring.
3. **5-min SLA fragile under load** — queue depth alerts; M2 GPU autoscaling; degrade to "Processing" UI rather than 5xx.
4. **Outcome mismatch false positives** — conservative threshold; require strong contradiction signals; manager-rejectable.
5. **Single-region deploy** — pin all infra to `ap-south-1`; only LLM scorer talks across regions.

---

*Last updated: 2026-05-04*
