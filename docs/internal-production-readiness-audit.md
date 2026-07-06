# Sola Scholars Internal Production Readiness Audit

Audit date: 2026-07-05
Repository: kaykay2023/sola-scholar
Local path: C:\Users\oluka\Downloads\verify code\sola-scholar
Branch audited: main
Commit audited: bf108f0ca5fddae8ef1868536a94131df658c883
Scope: current main branch, local code, tests, docs, deployment configuration, and safe static inspection. No provider keys, secrets, env files, Railway variables, DNS, deploy, merge, push, or paid provider calls were touched.

## A. Executive Conclusion

Decision: not ready for full internal production use.

Readiness estimate: 72%.

The core Sola Scholars recruiting pipeline is much stronger than a prototype. Apollo discovery, market gating, Firecrawl-only blocking, candidate validation, PDL enrichment after validation, match scoring, review gates, client-safe reporting, outcome capture, and local verification are all covered by meaningful tests. Basic Auth is present and protected APIs are not public by default.

The main blockers are operational and email-workflow related, not the matching math. The app currently drafts outreach and client reports, but it does not integrate with Lemlist or any equivalent sending/status provider. Users can mark outreach as sent or replied manually, including via the mailto flow, which makes delivery/reply statuses not source-of-truth safe. The app also still relies on a local JSON data file without a proven backup/restore path, durable job/idempotency controls, or a deploy-time commit identity exposed by the running app.

A cautious internal pilot is possible only if Sola Scholars is used as the system of record for sourcing, review, scoring, and report drafting, while actual outreach sending/status tracking remains manual and explicitly outside the app. It is not ready to be the trusted production sender/status system until the P0 items are fixed.

## B. What Works Today

- Server boots locally and exposes the expected Express API surface.
- Basic Auth protects all `/api/*` routes except `/api/health`.
- Blank `INTERNAL_PASSWORD` is refused for protected API use.
- Local JSON persistence uses a temp-file rename pattern for in-process writes.
- Apollo remains the primary discovery source.
- PDL is no longer a broad discovery source and is used as capped person enrichment after validation/market gating.
- PDL parser/status handling covers populated skills, empty/missing skills, 404, 402, 429, and 5xx cases in tests.
- Firecrawl-only unresolved candidates are blocked from visible/client-ready results across market modes.
- Market gate, verified-only filtering, score-based ordering, and Basic Auth are covered by tests.
- Client reports are generated from visible, client-ready matches and suppress internal diagnostics/scores.
- Manual skills are tracked separately and do not change scoring or gates.
- Candidate outcomes and daily learning summaries are present.
- `scripts/predeploy-check.ps1` gives a useful local production gate and passed on this checkout.

## C. Critical Blockers

### P0-1: Lemlist/email sending and status truth are missing

The application drafts outreach but does not send through Lemlist, queue leads into campaigns, store Lemlist lead/campaign/message IDs, receive webhooks, or sync delivered/opened/replied/bounced/unsubscribed/failed statuses.

Observed behavior:

- `runComposer()` creates outreach drafts only.
- `PATCH /api/outreach/:id` accepts manual status changes including sent/replied-style states.
- The frontend mailto action opens the local mail client and immediately marks a drafted item as `sent`.
- There is no Lemlist-specific env var, client, webhook route, campaign enrollment route, bounce/unsubscribe handling, provider delivery proof, or duplicate campaign guard.

Production risk: Sola Scholars would not be the source of truth for outreach status. Operators could believe a message was sent, opened, replied, or progressed when no provider-backed event exists.

Required fix: add a real outbound email/Lemlist integration or explicitly remove provider-like status semantics from the app. Store provider IDs and status events, prevent duplicate enrollment, handle bounces/unsubscribes/failures, and make manual statuses clearly separate from provider-confirmed statuses.

### P0-2: Persistence backup, recovery, and data-loss controls are not production-grade

The app stores data in one JSON file. Writes use a temp file and rename, which is reasonable for a small single-process app, but startup parse failure logs the error, resets to an empty default DB, and persists. There is no observed backup/restore test, corrupt-file recovery flow, scheduled export, point-in-time restore, retention policy, or cross-process file lock.

Production risk: a corrupt JSON file, volume issue, or accidental multi-instance deployment could lose or overwrite recruiting data.

Required fix: add verified backups, restore drills, startup corruption quarantine instead of overwrite, export tooling, and a single-instance guard. Consider Postgres once concurrent internal usage or audit retention grows.

### P0-3: Production deploy cannot prove the exact Git commit from the live app

The app exposes `version: 1.0.0` on `/api/health`, but not a build commit SHA. Railway upload-style deployments may expose image/snapshot metadata without an obvious Git SHA. That makes it hard to prove production is running the reviewed commit after deployment.

Production risk: operators cannot reliably answer which reviewed source is live.

Required fix: inject and expose a non-secret `BUILD_COMMIT`/`SOURCE_COMMIT` value in health or a protected status endpoint, and include it in the predeploy/deploy runbook.

### P0-4: Pipeline runs are synchronous and not idempotent

`POST /api/pipeline/run` orchestrates company/manager/need/scout/queue/validator/PDL/match/report work inside one request. There is no durable pipeline job table, idempotency key, per-need run lock, retry status, or duplicate-submit guard around paid provider calls.

Production risk: a double click, timeout retry, or two operators running the same request could duplicate records and consume Apollo/PDL/Hunter/OpenAI credits.

Required fix: add run locks/idempotency keys, persisted run state, safe retry semantics, and UI feedback that prevents duplicate launches.

## D. Important Improvements

### P1-1: Add API rate limiting and brute-force protection

Basic Auth is implemented with timing-safe comparison and blank-password refusal, but there is no rate limiter or account lockout. Add IP/user scoped rate limits, especially for protected APIs and pipeline/provider-triggering routes.

### P1-2: Strengthen route validation and status enums

Many mutation routes validate required fields but allow broad strings, large arrays, status values, and loosely shaped payloads. Add explicit schemas, enum checks, max lengths, and stricter error messages.

### P1-3: Add external provider timeouts and retry policy

Several provider calls rely on plain `fetch`. Add `AbortController` timeouts, bounded retries where safe, and consistent provider error mapping for Apollo, Firecrawl, Hunter, PDL, OpenAI, Airtable, and Adzuna.

### P1-4: Add continuous integration

There are no tracked GitHub Actions workflows. Add CI that runs `npm ci`, `npm test`, `npm audit --omit=dev`, and `scripts/predeploy-check.ps1` where supported.

### P1-5: Document and enforce single-instance Railway runtime

The JSON store is only safe as a single-writer deployment. Document the Railway volume, instance count, restart behavior, and rollback process. Add a startup warning or guard if multiple instances are configured.

### P1-6: Add backup, export, restore, and retention runbooks

Operations docs are useful but do not prove scheduled backup/restore. Add backup location, frequency, restore steps, retention, and a recurring restore test.

### P1-7: Tighten frontend production build posture

The frontend is a single HTML file using browser-loaded scripts/transforms. It works for the current scope, but production would benefit from precompiled assets, pinned integrity where possible, no runtime Babel dependency, and browser E2E checks.

### P1-8: Clean up stale documentation

`README.md` and `docs/PRODUCTION-READINESS.md` are behind the current code. They undercount routes, omit Apollo/PDL/resolution/outcomes/review features, and contain obsolete readiness language.

### P1-9: Improve diagnostics without leaking sensitive data

Provider diagnostics are generally careful, but production should standardize redaction tests for every status endpoint/report path and add explicit no-email/no-phone/no-LinkedIn assertions for diagnostics.

### P1-10: Add user/account attribution if multiple operators use the app

Basic Auth is acceptable for a very small internal pilot, but it does not identify individual reviewers. If auditability matters, add per-user auth before broader internal rollout.

## E. Later Improvements

- Move persistence to Postgres once multi-user concurrent usage or long-term audit history is required.
- Add Sentry/OpenTelemetry-style server error reporting.
- Add browser E2E tests for the main workflows.
- Add saved searches and run history screens for pipeline runs.
- Add admin views for provider credit usage and daily caps.
- Add structured data retention/delete workflows for candidate records.
- Expand Airtable sync into a documented mirror/export instead of a one-off snapshot.
- Add separate reviewer, admin, and read-only roles if external stakeholders ever access the app.

## F. Email and Lemlist Capability Matrix

| Capability | Current status | Production assessment |
| --- | --- | --- |
| Draft email copy | Present | Useful and tested through composer/report paths. |
| Review before sending | Present | Manual review path exists. |
| Send through Lemlist | Missing | P0 blocker if Lemlist is required sender. |
| Enroll lead in Lemlist campaign | Missing | P0 blocker. |
| Store provider lead/campaign/message IDs | Missing | P0 blocker for traceability. |
| Queue/retry sending | Missing | P0/P1 depending on rollout size. |
| Delivered status | Missing | Cannot be trusted. |
| Opened status | Manual/status-only | Cannot be trusted. |
| Replied status | Manual/status-only | Cannot be trusted. |
| Bounce handling | Missing | P0 for safe outbound. |
| Unsubscribe handling | Missing | P0 for safe outbound. |
| Failed-send handling | Missing | P0 for operator safety. |
| Duplicate campaign prevention | Missing | P0 for credit/reputation safety. |
| Verified email enforcement before send | Partial | Candidate/manager emails are validated shallowly, but provider-verified send rules are not enforced. |
| Webhook endpoint | Missing | P0 for provider-backed statuses. |
| Manual status notes | Present | Fine if clearly marked as manual, not provider proof. |

## G. End-to-End Workflow Matrix

| Step | Capability | Status | Notes |
| --- | --- | --- | --- |
| 1 | Health check | Works | `/api/health` is open and redacted. |
| 2 | Protected API auth | Works | Basic Auth wraps `/api/*` after health. |
| 3 | Company creation | Works | Minimal validation. |
| 4 | Hiring manager lookup | Works | Apollo/Hunter/provider fallback paths exist. |
| 5 | Hiring need creation | Works | Needs stronger schema validation. |
| 6 | Apollo candidate discovery | Works | Primary discovery source. |
| 7 | PDL broad discovery | Disabled | Intentional and correct. |
| 8 | Market gate | Works | Tests cover core modes. |
| 9 | Firecrawl-only unresolved block | Works | Blocks visible/client-ready across market modes. |
| 10 | Resolution queue | Works | Apollo resolver path, capped drains, safe fallback. |
| 11 | Candidate validation | Works | Gate semantics tested. |
| 12 | PDL enrichment | Works | Capped after validation/market gate and before scoring. |
| 13 | Skill provenance | Works | PDL/Apollo/manual provenance separated. |
| 14 | Match scoring | Works | Math covered; enriched evidence can improve scores. |
| 15 | Score-based ordering | Works | Tests preserve ordering behavior. |
| 16 | Bulk review | Works | Does not bypass hard trust gates. |
| 17 | Client report generation | Works | Client-safe report path exists. |
| 18 | Outreach drafting | Works | Draft-only; no provider send. |
| 19 | Outreach sending/status | Not production-ready | Lemlist/provider integration missing. |
| 20 | Outcomes/learning | Works | Candidate outcomes and summaries exist. |

## H. Route Audit

The server registers 40 routes. `/api/health` is public. Later `/api/*` routes are protected by Basic Auth.

| Route | Auth | Validation strength | Production risk |
| --- | --- | --- | --- |
| `GET /api/health` | Public | N/A | Low; redacted health data only. |
| `GET /api/providers/status` | Basic Auth | N/A | Low; should remain redacted. |
| `GET /api/role-templates` | Basic Auth | N/A | Low. |
| `GET /api/scoring-profiles` | Basic Auth | N/A | Low. |
| `GET /api/dashboard/stats` | Basic Auth | N/A | Low/medium; ensure no PII expansion later. |
| `GET /api/companies` | Basic Auth | Query only | Low. |
| `GET /api/hiring-managers` | Basic Auth | Query only | Low. |
| `GET /api/hiring-needs` | Basic Auth | Query only | Low. |
| `GET /api/candidates` | Basic Auth | Query only | Medium; contains internal candidate data. |
| `GET /api/candidate-validations` | Basic Auth | Query only | Medium. |
| `GET /api/matches` | Basic Auth | Query only | Medium. |
| `GET /api/outreach` | Basic Auth | Query only | Medium/high; contains email body drafts. |
| `GET /api/client-reports` | Basic Auth | Query only | Medium; client-safe but still business data. |
| `GET /api/candidate-outcomes` | Basic Auth | Query only | Medium. |
| `GET /api/candidate-outcomes/:id` | Basic Auth | ID only | Medium. |
| `GET /api/agent-learning/summaries` | Basic Auth | Query only | Low/medium. |
| `GET /api/activity-logs` | Basic Auth | Query only | Medium; diagnostics must stay redacted. |
| `POST /api/companies` | Basic Auth | Minimal | P1: add schema/length validation. |
| `POST /api/hiring-managers` | Basic Auth | Minimal email check | P1: validate names/company/email. |
| `POST /api/hiring-needs` | Basic Auth | Minimal | P1: validate role/location/skills/status enums. |
| `PATCH /api/hiring-needs/:id` | Basic Auth | Broad field update | P1: constrain fields/enums/lengths. |
| `DELETE /api/hiring-needs/:id` | Basic Auth | ID only | Medium; consider soft-delete/audit. |
| `POST /api/candidate-outcomes` | Basic Auth | Meaningful | Low/medium; duplicate protection tested. |
| `PATCH /api/candidate-outcomes/:id` | Basic Auth | Meaningful | Low/medium. |
| `PATCH /api/candidates/:id/manual-skills` | Basic Auth | Meaningful | Low; tests prevent scoring/gate impact. |
| `POST /api/candidates/bulk-review` | Basic Auth | Meaningful | Low/medium; hard gates preserved. |
| `GET /api/review/metrics` | Basic Auth | N/A | Low. |
| `GET /api/resolution-queue` | Basic Auth | Query only | Medium. |
| `PATCH /api/matches/:id` | Basic Auth | Weak status validation | P1: add enum and audit trail. |
| `PATCH /api/outreach/:id` | Basic Auth | Weak status validation | P0 due manual provider-like status truth. |
| `POST /api/connector/run` | Basic Auth | Provider/action path | Medium/high; provider-cost route needs rate/idempotency. |
| `POST /api/needs/detect` | Basic Auth | Text payload | Medium; OpenAI path needs timeout/size rules. |
| `POST /api/scout/run` | Basic Auth | Provider-cost route | Medium/high; cap/idempotency/rate limits needed. |
| `POST /api/validator/run` | Basic Auth | Candidate payload | Medium; safe but validate size/shape. |
| `POST /api/matchmaker/run` | Basic Auth | Need/candidate payload | Medium. |
| `POST /api/outreach/draft` | Basic Auth | Draft input | Medium; no send, but contains email content. |
| `POST /api/client-report/generate` | Basic Auth | Need/client path | Medium; tested for safety. |
| `POST /api/agent-learning/daily-summary` | Basic Auth | Summary path | Low/medium. |
| `POST /api/pipeline/run` | Basic Auth | Minimal top-level | P0 for idempotency/duplicate paid calls. |
| `POST /api/airtable/sync` | Basic Auth | Provider path | Medium; provider side-effect route needs strong validation/rate limits. |

## I. Environment Variable Audit

No env files or secrets were read. This audit uses code/docs references only.

| Variable | Purpose | Current status/risk |
| --- | --- | --- |
| `PORT` | Server port | Optional; defaults to 3000. |
| `DATA_PATH` | JSON data file or directory | Required for persistent production data; needs backup/restore runbook. |
| `INTERNAL_USER` | Basic Auth user | Required for protected API access. |
| `INTERNAL_PASSWORD` | Basic Auth password | Required; blank value refuses API use. |
| `APOLLO_API_KEY` | Apollo discovery/manager lookup | Optional but core discovery depends on it. |
| `PDL_API_KEY` | PDL enrichment | Optional but enriched skill scoring depends on it. |
| `FIRECRAWL_API_KEY` | Firecrawl evidence | Optional; Firecrawl-only unresolved candidates remain blocked. |
| `GITHUB_TOKEN` | GitHub evidence | Optional; used for public evidence enrichment. |
| `HUNTER_API_KEY` | Email finding | Optional. |
| `ADZUNA_APP_ID` | Adzuna jobs | Referenced by code/docs; verify `.env.example` coverage. |
| `ADZUNA_API_KEY` | Adzuna jobs | Optional/disabled unless configured. |
| `ADZUNA_DISCOVERY_ENABLED` | Adzuna discovery flag | Optional; document default behavior. |
| `OPENAI_API_KEY` | parser/scoring/report/draft assistance | Optional with fallbacks, but quality depends on it. |
| `AIRTABLE_PAT` | Airtable sync | Optional. |
| `AIRTABLE_BASE_ID` | Airtable sync | Optional. |
| `AIRTABLE_TABLE_NAME` | Airtable sync table | `.env.example` appears to contain a non-placeholder default; predeploy warns to verify safety. |
| `CLERK_PUBLISHABLE_KEY` | Future auth | Optional/not active for Basic Auth path. |
| `CLERK_SECRET_KEY` | Future auth | Optional/not active for Basic Auth path. |
| `APOLLO_MAX_RESULTS_PER_VARIANT` | Apollo cap | Code-supported; document in env example/runbook. |
| `APOLLO_MAX_VARIANTS_PER_RUN` | Apollo cap | Code-supported; document in env example/runbook. |
| `APOLLO_MAX_CANDIDATES_PER_RUN` | Apollo cap | Code-supported; document in env example/runbook. |
| `APOLLO_MAX_PAGES_PER_ATTEMPT` | Apollo cap | Code-supported; document in env example/runbook. |
| `PDL_ENRICH_MAX_PER_RUN` | PDL client-ready cap | Code-supported; should be documented for credit control. |
| `PDL_BORDERLINE_ENRICH_MAX_PER_RUN` | PDL borderline cap | Code-supported; should be documented for credit control. |
| `RESOLUTION_QUEUE_DRAIN_MAX_PER_RUN` | Queue drain cap | Code-supported; should be documented. |

Missing/unused concern: there is no observed Lemlist env variable, webhook secret, campaign ID, API key, sender ID, or provider status sync configuration.

## J. Test and Verification Evidence

Commands run locally on the audited checkout:

| Command | Result | Notes |
| --- | --- | --- |
| `git fetch origin main` | Passed | Fetched latest GitHub main without modifying source. |
| `git status --short` | Clean before report artifact | Source tree was clean before writing this audit report. |
| `npm ci` | Not run | Escalation was blocked because `npm ci` mutates `node_modules` during a no-code-change audit. Existing install was used for safe local checks. |
| `npm test` | Passed | Smoke, behavior, audit, and pipeline suites all passed. |
| `npm audit --omit=dev` | Passed | `found 0 vulnerabilities`. |
| `pwsh -NoProfile -File scripts\predeploy-check.ps1` | Passed | Tests, prod audit, auth check, local boot, health check, and critical/high audit gate passed. |

Notable predeploy warning:

- `.env.example` has one non-placeholder line that should be verified as a safe default.

Test coverage strengths:

- Basic Auth behavior and blank-password refusal.
- Route registration and frontend transform checks.
- No hardcoded secrets/static frontend key storage checks.
- Pipeline isolation, score ordering, required-skill scoring, Firecrawl-only blocking, verified-only behavior, market gates, PDL enrichment caps/statuses/provenance, manual skills safety, report safety, bulk review gates, outcomes, and learning summaries.

Test gaps:

- No tracked CI workflow.
- No browser E2E suite.
- No backup/restore/corrupt-data recovery test.
- No multi-process/concurrent-write test.
- No pipeline idempotency/double-submit paid-call guard test.
- No Lemlist/provider webhook/status sync tests because that integration is absent.

## K. Deployment and Operations Checklist

| Area | Status | Readiness |
| --- | --- | --- |
| Railway config | Present | Good baseline. |
| Healthcheck path | `/api/health` | Works but lacks commit SHA. |
| Start command | `node backend/server.js` | Correct. |
| Basic Auth | Present | Acceptable for small pilot with strong password; add rate limits. |
| Secrets handling | Safe in inspected code/tests | Do not expose env values in diagnostics. |
| Data persistence | JSON file | Needs backup/restore/corruption plan before production trust. |
| Single-instance assumption | Implicit | Must be documented/enforced. |
| Provider caps | Present for Apollo/PDL/queue | Good, but add run-level idempotency. |
| Diagnostics | Generally redacted | Continue expanding no-PII tests. |
| Commit observability | Missing | Add build SHA to health/status. |
| Deploy verification | Predeploy script present | Good, but CI should run it too. |
| Rollback | Not fully evidenced | Add commit-aware rollback runbook. |
| Monitoring/alerting | Not evidenced | Add app/provider/volume/error alerts. |

## L. Prioritized Implementation Plan

1. Build real Lemlist/outbound provider integration.
   - Add provider client, campaign enrollment, send/queue semantics, provider IDs, webhook receiver, event table, duplicate prevention, bounce/unsubscribe handling, and status mapping.
   - Separate manual notes from provider-confirmed status.
   - Add tests for sent/delivered/opened/replied/bounced/unsubscribed/failed events.

2. Harden persistence and data recovery.
   - Add timestamped backups before writes or on a schedule.
   - Quarantine corrupt JSON instead of overwriting it.
   - Add restore command/runbook and a test fixture for corrupted data.
   - Document Railway volume path and single-instance requirement.

3. Make production commit identity verifiable.
   - Inject a non-secret build commit at deploy time.
   - Expose it in `/api/health` or a protected status endpoint.
   - Update predeploy/deploy docs to verify source commit before and after deploy.

4. Add pipeline idempotency and run state.
   - Add per-need/run locks, idempotency keys, persisted run status, retry state, and duplicate-click protection.
   - Ensure paid provider calls are not repeated accidentally.

5. Add production hardening around API, providers, and CI.
   - Add route schemas/enums/length limits.
   - Add rate limiting.
   - Add provider timeouts/retries.
   - Add GitHub Actions for install/test/audit/predeploy.
   - Refresh README and production docs to match the current route and provider architecture.

Final audit judgment: Sola Scholars is close for internal sourcing/review/report drafting, but not ready to be the trusted production outreach and operations system until the P0 blockers are resolved.

## Remediation Status - 2026-07-05

This section was added after the production-readiness implementation work. It does not replace the original audit findings above.

| Original P0 | Status | Remediation summary | Remaining external setup |
| --- | --- | --- | --- |
| Real Lemlist email integration and provider-backed outreach statuses | Fixed in code; pending external configuration | Added Lemlist lead creation, campaign enrollment, approval before enrollment, verified-email enforcement, duplicate enrollment prevention, provider IDs, provider-confirmed statuses, webhook handling, bounce/unsubscribe blocking, retryable failures, mocked tests, and UI changes that stop mailto from marking outreach as sent. | Configure `LEMLIST_API_KEY`, `LEMLIST_CAMPAIGN_ID`, `LEMLIST_WEBHOOK_SECRET`, and register the webhook URL in Lemlist. Do not send/enroll real contacts until those settings are reviewed. |
| JSON backup, restore, and corruption recovery | Fixed in code | Added timestamped JSON backups, retention, manual backup/list/restore/verify commands, corrupt primary quarantine, recovery from newest valid backup, no silent empty replacement, storage health, and single-instance lock protection. | Confirm Railway volume-backed `DATA_PATH`/`DATA_BACKUP_DIR`, retention policy, and single-instance runtime settings. |
| Deployed Git commit identity | Fixed in code; pending deployment metadata | Added build identity resolution from `BUILD_COMMIT`, `SOURCE_COMMIT`, or `RAILWAY_GIT_COMMIT_SHA`, redacted health output, and protected system status. | Configure Railway/build process to provide the reviewed commit SHA as non-secret metadata. |
| Pipeline idempotency, run locking, and paid-provider-call protection | Fixed in code | Added persisted `pipeline_runs`, idempotency keys, normalized request fingerprints, active equivalent-run blocking, provider-call ledger entries, request validation, rate limits, frontend duplicate-click prevention, run ID display, and pipeline status endpoints. | Operators should use the UI or supply stable idempotency keys for scripted runs. |

P1 work completed in the remediation branches:

- API request validation for pipeline launches and outreach status changes.
- Status enum separation for outreach manual/system/provider-confirmed states.
- Route-level rate limits for outreach, Lemlist webhook, pipeline, and provider-triggering routes.
- Reusable provider timeout/retry wrapper introduced and covered by tests for timeout mapping.
- GitHub Actions CI workflow for install, tests, production audit, predeploy gate, and safety checks.
- Updated `.env.example`, README, and operations runbook with non-secret configuration and procedures.

Current readiness estimate after code remediation: 88% before external setup, 94% after Lemlist/Railway metadata/backup-volume setup is completed and verified.

Production is still not automatically ready to deploy from this report alone. The remaining work is external setup and review: Lemlist credentials/campaign/webhook registration, Railway build commit variable, Railway backup directory/volume confirmation, and human review/merge of the stacked pull requests.
