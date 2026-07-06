# Operations Guide

## Local setup (no secrets required to start reading code)

```powershell
npm install
Copy-Item .env.example .env        # then fill INTERNAL_PASSWORD + any provider keys
npm start                          # http://localhost:8080  (PORT overridable)
```

- The server **refuses to serve `/api/*`** if `INTERNAL_PASSWORD` is blank (503). This is intentional.
- `.env` is gitignored. Never commit it. `.env.example` holds placeholders only.
- Tests run without any secrets: `npm test`.

## Authentication (Basic Auth — V1)

- All `/api/*` routes except `/api/health` require HTTP Basic Auth (`requireAuth`).
- Credentials compared with `crypto.timingSafeEqual` (no timing leak).
- `/api/health` is open but exposes only `configured`/`missing` per provider — never key values.
- Errors are sanitized: the global handler returns `Internal error` (500) or a clean 4xx for bad JSON / oversized bodies; no stack traces reach the client.
- Auth failure logs redact key-like tokens (`api_key=<REDACTED>`).

**Do not disable Basic Auth. Clerk (V2) is configured for forward-compatibility only and is not used in V1.**

## Provider diagnostics

Authenticated endpoint: `GET /api/providers/status`.

Per provider it reports a sanitized status (no secrets, no response bodies):

| Status | Meaning |
|---|---|
| `working` | Configured; last recorded call succeeded |
| `configured` | Configured; no recent activity yet |
| `configured-but-failing` | Configured; last call failed (see `lastErrorCategory`) |
| `missing-key` | Required env var(s) not set — provider skipped |
| `disabled` | No credentials defined / not used in V1 (e.g. Clerk) |

`lastErrorCategory` is one of: `missing-key`, `plan-restricted`, `auth-rejected`, `rate-limited`, `bad-request`, `provider-error`, `network-error`, `unknown-error`. `lastHttpStatus` is a numeric code only.

Providers tracked: Apollo, PDL, GitHub, Firecrawl, Hunter, Adzuna, OpenAI, Airtable, Clerk.

## Role templates

Editable in `config/role-templates.json`. Served at `GET /api/role-templates`. The One-Click Pipeline page shows a "Start from a saved role template" selector that prefills role, required skills, location, and seniority. Add a role by adding an object to the `templates` array — no code change needed.

Nine templates ship by default (Microsoft Sentinel SOC Analyst, Microsoft Sentinel Detection Analyst, Azure Security Engineer, Azure Cloud Security Engineer, Cloud Security Engineer, IAM / PAM Analyst, GRC Analyst, AWS Cloud Security Engineer, Data Analyst / Power BI Analyst).

## Scoring profiles (PREPARED — not active)

`config/scoring-profiles.json` defines per-role scoring intent (critical skills, supporting skills, hands-on evidence signals, cert signals). It is served read-only at `GET /api/scoring-profiles`.

**`enabled` is `false`. These profiles are NOT used in score math.** The current strict scoring (`matchDisplayLabel` / `runMatchmaker`) is unchanged. Flipping `enabled` to `true` would change candidate scores and must not be done without an explicit reviewed decision validated against the guardrails in the file (no inflation, missing skills stay visible, Needs Review preserved, no single cert overpowering missing hands-on evidence).

## Candidate-search mode

`managerId: null` is **not an error**. Candidate-only searches skip hiring-manager discovery on purpose. The pipeline now returns `managerStatus` (`found`/`skipped`) and `managerStatusLabel` ("Manager lookup skipped — candidate search mode"), and the UI shows that label instead of a raw `managerId: null`.

## Candidate quality & review (current behavior)

The pipeline already enforces:
- **Verified-only shortlist:** only `scoutDecision === 'accepted'` candidates with a usable profile link reach matches/reports (`isVisibleMatch`). Review/possible-candidate records never appear in the client shortlist.
- **Real profile links:** scout rejects job boards, blogs, docs, tutorials; LinkedIn `/in/` and GitHub user URLs are normalized and deduped.
- **Needs Review preserved:** incomplete evidence → validation tier `Needs Review`; the client report marks these `needsManualReview: true` with recommended action "Manual review required — confirm evidence before client submission".
- **Missing skills visible:** every match carries `matchedSkills` and `missingSkills`; both appear in the report and CSV.

## Client report

`POST /api/client-report/generate` (and the pipeline) produce, for the top 5 of N visible candidates:
role + required skills, score, display label, matched skills, missing skills, evidence/validation tier, why-fits, recommended next step, profile links, an email draft, and a CSV export. No secrets, no raw debug fields.

## Approval workflow (statuses — prepared)

Recommended candidate statuses for client submission (not auto-applied, no outreach sent):
`Shortlisted` · `Approved for client` · `Needs manual review` · `Backup candidate` · `Rejected` · `Do not submit`.

Today these map to validation tier + `needsManualReview` + match visibility. The system never auto-approves a candidate for client submission and never sends outreach/email automatically.

## Saved successful searches (structure — prepared)

A saved search should capture: role title, required skills, nice-to-have skills, location, seniority, number sourced, number accepted, number matched, best-candidate notes, search-quality notes, run date/time, and `pipelineRunId` / `reportId`. Each pipeline run already produces `pipelineRunId`, per-source counts, and a `reportId`, so saved searches can be derived from existing run output without changing pipeline behavior.

## JSON Store Backup and Recovery

Sola Scholars still uses a single JSON data store for the internal deployment. Production must run as a single active writer with `EXPECTED_INSTANCE_COUNT=1` and `JSON_STORE_SINGLE_INSTANCE_ACK=true`.

Supported non-secret settings:

- `DATA_BACKUP_DIR`: backup directory. Use a Railway volume-backed path.
- `DATA_BACKUP_RETENTION`: number of valid backups to retain. Default: `20`.
- `DATA_BACKUP_ENABLED`: set to `false` only for disposable local tests.
- `DATA_BACKUP_INTERVAL_MINUTES`: reserved for scheduled backup cadence.
- `BUILD_COMMIT`, `SOURCE_COMMIT`, or `RAILWAY_GIT_COMMIT_SHA`: non-secret source commit metadata exposed by health/status.
- `APP_VERSION` and `BUILD_TIME`: optional non-secret build metadata.

Manual commands:

```powershell
npm run data:verify
npm run data:backup
npm run data:list-backups
npm run data:restore -- --backup <backup-name>
```

Restore safeguards:

- The restore command accepts backup file names only and rejects path traversal.
- The current primary file is backed up before restore.
- Invalid JSON or invalid data shape is refused.
- Corrupt startup data is quarantined and the newest valid backup is restored.
- If no valid backup exists, startup fails with a recovery-required state instead of silently replacing data with an empty database.

Protected status:

- `/api/health` exposes only redacted build metadata and service configured/missing states.
- `/api/system/status` is Basic Auth protected and reports redacted storage health, latest backup timestamp, valid backup count, recovery state, and lock state. It never returns local filesystem paths or file contents.

## Pipeline Run Safety

Pipeline runs are persisted in pipeline_runs with an idempotency key, normalized request fingerprint, stages, result summary, and provider-call ledger entries. The backend rejects reuse of the same idempotency key for a different request and blocks active equivalent runs so a browser retry or double click cannot launch duplicate paid-provider work. Active run locks use `PIPELINE_RUN_LOCK_TTL_MS` to expire stale crashed runs without unlocking browser-disconnected in-flight runs immediately. The frontend disables the run button while a submission is being accepted and displays the persistent run ID returned by the API.

Protected endpoints:

- GET /api/pipeline-runs: recent pipeline runs.
- GET /api/pipeline-runs/:id: a single run record and stage history.

Provider calls should use the shared timeout wrapper for new integrations. The wrapper maps request timeouts to sanitized provider errors and can respect retry-after for bounded retry paths where the operation is safe to replay.
