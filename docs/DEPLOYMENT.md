# Deployment Safety Workflow

Production target:
- Live app: https://app.solascholars.com
- Railway project: `happy-motivation` · environment: `production` · service: `hospitable-trust`
- Builder: RAILPACK · start: `node backend/server.js` · healthcheck: `/api/health`

**Deploys are never automatic. A human approves and triggers every production deploy.**

## 1. Pre-deploy gate (run locally first)

```powershell
pwsh ./scripts/predeploy-check.ps1
```

This runs, in order:
1. Repo safety (`scripts/repo-safety.ps1`) — clean tree, no staged secrets, `.env` ignored.
2. `npm test` — all four suites must pass.
3. `npm audit --omit=dev` — zero critical/high prod vulnerabilities.
4. `railway.json` sanity — healthcheck is `/api/health`, start command present.
5. Basic Auth present — `requireAuth` wired to `/api`, blank-password refusal, timing-safe compare.
6. Local boot — server starts and `/api/health` returns `ok` with `auth: enabled`, no secret-like values.
7. Approved-file check — only expected paths changed.

Exit 0 = safe to **request** deploy approval. Exit 1 = blocked.

## 2. Human approval checklist (cannot be automated)

- [ ] Railway `production` env vars set: `INTERNAL_PASSWORD` (strong), `INTERNAL_USER`, provider keys as needed.
- [ ] Confirm target: `happy-motivation` / `production` / `hospitable-trust`.
- [ ] Basic Auth confirmed enabled (do not disable).
- [ ] Source is clean, reviewed, committed (GitHub = source of truth — see below).
- [ ] Provider status reviewed at `/api/providers/status`.
- [ ] Approve + trigger deploy manually in Railway.

## 3. Post-deploy health check

```powershell
# /api/health is open (no auth) and must never expose secret values.
Invoke-WebRequest https://app.solascholars.com/api/health -UseBasicParsing | Select-Object -Expand Content
```
Expect: `status: ok`, `auth: enabled`, and a `services` map of `configured`/`missing` (no values).

For richer (sanitized) provider status, authenticated:
`GET /api/providers/status`.

## 4. Rollback

Railway keeps prior deploys. If a deploy regresses:
1. Railway dashboard → service `hospitable-trust` → Deployments → select last good → **Redeploy / Rollback**.
2. Re-run the post-deploy health check.
3. Do not change env vars or DNS as part of rollback unless the failure is a config error and you have approval.

## 5. Source-of-truth target (long term)

- GitHub becomes source of truth; Railway deploys from a clean, reviewed branch.
- `package-lock.json` is now tracked (reproducible RAILPACK builds).
- Production deploy requires approval; no dirty-repo deploys.

## Deployment report template

```
Deploy report — <date> <time>
Commit: <sha>            Branch: <branch>
Pre-deploy gate: PASS/FAIL (predeploy-check.ps1)
Tests: PASS/FAIL         Prod vulns: <n critical/high>
Basic Auth: enabled      Verified-only filtering: intact
Target: happy-motivation / production / hospitable-trust
Approved by: <name>
Health after deploy: status=ok auth=enabled
Providers working: <list>   failing: <list>
Rollback plan: redeploy <last-good-sha>
Notes:
```
