# Production Readiness Checklist

Status legend: ✅ done · 🟡 prepared (not enabled) · ⛔ user-required blocker

## Safety & security
- ✅ Basic Auth enabled, timing-safe, refuses blank password (503), `/api/*` protected.
- ✅ `/api/health` open but leaks no secret values.
- ✅ Errors sanitized (no stack traces; bad JSON → 400, oversized → 413, else 500 `Internal error`).
- ✅ Auth-failure logs redact key-like tokens.
- ✅ `.env` / `backend/.env` ignored and untracked; `.env.example` placeholders only (now includes `PDL_API_KEY`).
- ✅ Verified-only shortlist filtering intact (`isVisibleMatch`).
- ✅ Strict scoring unchanged; labels: 70+ Strong · 60–69 Good · 50–59 Relevant Security Profile (with evidence) / Partial Match · <50 Weak.

## Dependencies
- ✅ 0 vulnerabilities (prod + dev) after non-force `npm audit fix` (qs DoS + babel high resolved).

## Repo & deploy safety
- ✅ `scripts/repo-safety.ps1` — clean/dirty, secrets, key-file tracking, vulns, safe-to-commit verdict.
- ✅ `scripts/predeploy-check.ps1` — full deploy gate (repo + tests + vulns + railway + auth + local boot + approved files).
- ✅ `package-lock.json` no longer gitignored (reproducible Railway builds).
- ⛔ `package.json`, `package-lock.json`, `railway.json`, `backend/server.js`, `test/`, `config/`, `scripts/`, `docs/` are **untracked** — must be committed (user approval required to commit/push).

## Features wired
- ✅ Role templates (9) — `config/role-templates.json`, `GET /api/role-templates`, pipeline-form selector.
- ✅ Provider diagnostics — `GET /api/providers/status` (sanitized).
- ✅ Candidate-search mode wording — `managerStatusLabel`, humanized step renderer.
- ✅ Client report keeps Needs Review visible (`needsManualReview` + manual-review next step).

## Prepared (not enabled — needs explicit decision)
- 🟡 Role-specific scoring profiles — `config/scoring-profiles.json`, `enabled: false`. Does not change score math.
- 🟡 Approval workflow statuses (documented; no auto-approve, no outreach).
- 🟡 Saved successful searches (structure documented; derivable from existing run output).

## Tests
- ✅ `npm test` — 4 suites (static, behavioral, manual audit, pipeline isolation) all pass, exit 0.

## Classification

**Production-ready with manual approval gates** — once the untracked source files are committed by the user.

The application code, security posture, tests, vulnerability state, diagnostics, reports, and deploy/repo-safety workflows are production-grade. The only thing standing between the current state and a clean production deploy is **committing the untracked source** and the standard **human approval gates** (commit, push, Railway env vars, deploy trigger) — none of which can or should be automated without explicit approval.

## Remaining user-required blockers
1. **Commit & push** the untracked source (requires approval). Suggested commit scope: `backend/`, `test/`, `config/`, `scripts/`, `docs/`, `package.json`, `package-lock.json`, `railway.json`, `.env.example`, `.gitignore`, `README.md`.
2. **Railway production env vars** — confirm `INTERNAL_PASSWORD` + provider keys set (cannot verify without account access).
3. **Provider keys / plans** — any provider showing `missing-key` or `plan-restricted` needs an account/billing decision.
4. **Production deploy approval** — human triggers via Railway.
5. **Decision on scoring profiles** — leave `enabled: false` unless a reviewed scoring change is intended.
