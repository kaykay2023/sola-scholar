# Sola Scholars Production Readiness Handover for Claude

Date: 2026-07-05
Repo: kaykay2023/sola-scholar
Base audited commit: bf108f0ca5fddae8ef1868536a94131df658c883

## Branches to verify

1. `feat/internal-production-email`
   - Commit: `86bcf28`
   - Base: `main`
   - Scope: Lemlist provider-backed outreach status truth.

2. `feat/internal-production-recovery`
   - Commit: `5af7c1a`
   - Base: `feat/internal-production-email`
   - Scope: JSON backup/recovery and build identity.

3. `feat/internal-production-pipeline-safety`
   - Commit: `c626fff` plus final audit/handover commit
   - Base: `feat/internal-production-recovery`
   - Scope: persisted pipeline runs, idempotency, rate limits, provider timeout wrapper, CI, docs, audit remediation.

## What to verify

- No scoring weights changed.
- Verified-only, Firecrawl-only blocking, manual-skill safety, client-report safety, market gates, ordering, and Basic Auth tests still pass.
- Lemlist tests use mocked HTTP and webhook fixtures only; no live email or campaign enrollment occurs.
- JSON recovery tests use small temp files and clean them up.
- No `.env`, provider keys, Railway variables, DNS, production data, or live provider calls were touched.
- `.github/workflows/ci.yml` runs `npm ci`, `npm test`, `npm audit --omit=dev`, and `scripts/predeploy-check.ps1`.

## Verification already run locally

For PR 1:
- `npm ci` completed; npm reported one low dev/overall advisory.
- `npm test` passed.
- `npm audit --omit=dev` passed with 0 vulnerabilities.
- `pwsh -NoProfile -File scripts\predeploy-check.ps1` passed.

For PR 2:
- `npm ci` passed.
- `npm test` passed after disabling backup churn only inside `test/pipeline.cjs`; `test/recovery.cjs` covers backup behavior.
- `npm audit --omit=dev` passed with 0 vulnerabilities.
- `pwsh -NoProfile -File scripts\predeploy-check.ps1` passed.

For PR 3:
- `npm ci` passed; npm reported one low dev/overall advisory.
- `npm test` passed.
- `npm audit --omit=dev` passed with 0 vulnerabilities.
- `pwsh -NoProfile -File scripts\predeploy-check.ps1` passed after allowing `.github/workflows/` in the approved-file check.

## Remaining external setup

- Set real Lemlist API key, campaign ID, and webhook secret outside git.
- Register the Lemlist webhook URL with Lemlist.
- Configure Railway/build metadata to provide `BUILD_COMMIT`, `SOURCE_COMMIT`, or `RAILWAY_GIT_COMMIT_SHA`.
- Confirm Railway volume-backed data path and backup directory.
- Confirm single-instance runtime for JSON store.

## Merge order

1. Merge PR 1: email/Lemlist.
2. Merge PR 2: recovery/build identity.
3. Merge PR 3: pipeline safety/CI/docs/audit remediation.

Do not deploy until all external setup is complete and verified.
