# Sola Scholar — V1

**In-house AI recruiting intelligence for cybersecurity and cloud hiring.**

Internal-only tool. No client portal, no client login, no billing. Sola Scholar runs the recruiting pipeline and generates client-ready shortlist reports that are emailed to clients manually.

## Architecture (V1)

```
Browser  ──>  /api/*  ──>  Express server  ──>  Apollo / Firecrawl / GitHub / Hunter / Adzuna / OpenAI / Airtable
              (Basic Auth)                       (keys in process.env only — never seen by browser)
                                                 │
                                                 └──>  data.json  (at DATA_PATH)
```

- **Frontend**: single static React HTML at `backend/public/index.html` (Babel-in-browser; no build step).
- **Backend**: Express server `backend/server.js`. All external API calls happen here, server-side.
- **Storage**: JSON file at `${DATA_PATH}/data.json`. Atomic writes.
- **Auth**: HTTP Basic Auth on all `/api/*` except `/api/health`. Set `INTERNAL_USER` / `INTERNAL_PASSWORD` on Railway. (Clerk planned for V2.)
- **Keys**: never sent to the browser. Server reports only `configured` / `missing` per service.

## The pipeline

```
Companies → Hiring Managers → Hiring Needs → Candidates → Validations → Matches → Outreach → Client Reports
```

Six agents, all server-side:

| # | Agent          | Purpose                                                     | External call         |
|---|----------------|-------------------------------------------------------------|-----------------------|
| 1 | Connector      | Find verified hiring managers                               | Apollo (+ Hunter for email enrichment) |
| 2 | Need Detector  | Detect open roles at a company                              | Firecrawl, Adzuna fallback |
| 3 | Scout          | Source candidates against a confirmed need                  | Firecrawl + GitHub    |
| 4 | Validator      | GitHub repo analysis → proficiency map + tier (history)     | GitHub                |
| 5 | Matchmaker     | Score candidates × need (35/20/15/15/15)                    | Local                 |
| 6 | Composer       | Draft outreach (shortlist pitch or warm intro)              | OpenAI (template fallback) |

**One-Click Pipeline**: type a company + role + skills → runs all 6 steps and generates a client report end-to-end.

## API routes

All routes (except `/api/health`) require HTTP Basic Auth.

### Reads
- `GET /api/health` — service config presence (no values), auth status, data path
- `GET /api/dashboard/stats` — counts across all collections
- `GET /api/companies`
- `GET /api/hiring-managers`
- `GET /api/hiring-needs`
- `GET /api/candidates`
- `GET /api/candidate-validations`
- `GET /api/matches`
- `GET /api/outreach`
- `GET /api/client-reports`
- `GET /api/activity-logs` (latest 100)

### Mutations
- `POST /api/companies` — create
- `POST /api/hiring-managers` — create (requires real email; no fabricated emails)
- `POST /api/hiring-needs` — create
- `PATCH /api/hiring-needs/:id` — partial update (confirm / unconfirm)
- `DELETE /api/hiring-needs/:id`
- `PATCH /api/matches/:id` — status (proposed → approved / rejected)
- `PATCH /api/outreach/:id` — subject, body, status, replyText, nextAction

### Agent runs
- `POST /api/connector/run` — body: `{ industry?, titles?[] }`
- `POST /api/needs/detect` — body: `{ companyId | companyName }`
- `POST /api/scout/run` — body: `{ needId }`
- `POST /api/validator/run` — body: `{ candidateIds?[] }` (default: all)
- `POST /api/matchmaker/run` — body: `{ needId }`
- `POST /api/outreach/draft` — body: `{ needId?, managerId, matchIds?, kind }`
- `POST /api/client-report/generate` — body: `{ needId }`
- `POST /api/pipeline/run` — body: `{ company, role, skills?[], location?, seniority? }` (one-click)
- `POST /api/airtable/sync` — push current matches snapshot to Airtable

## Run locally

```bash
git clone https://github.com/kaykay2023/sola-scholar.git
cd sola-scholar
npm install

# Copy and fill .env
cp .env.example .env
#  → set INTERNAL_PASSWORD (required) + at least one external API key

npm start
# Server: http://localhost:3000
```

Visit `http://localhost:3000`. Browser will prompt for Basic Auth credentials (`INTERNAL_USER` / `INTERNAL_PASSWORD`).

## Deploy to Railway

1. **Push to GitHub**: this repo on the `main` branch (or a feature branch + PR).
2. **Create Railway service**: New Project → Deploy from GitHub → pick the repo. Railway auto-detects Node.
3. **Set environment variables** under your service → Variables:

   ```
   INTERNAL_USER=sola
   INTERNAL_PASSWORD=<a strong password — required>
   DATA_PATH=/data            # see step 4

   APOLLO_API_KEY=...
   FIRECRAWL_API_KEY=...
   GITHUB_TOKEN=...
   HUNTER_API_KEY=...
   ADZUNA_APP_ID=...
   ADZUNA_API_KEY=...
   OPENAI_API_KEY=...

   AIRTABLE_PAT=...           # optional
   AIRTABLE_BASE_ID=...
   AIRTABLE_TABLE_NAME=Matches

   CLERK_PUBLISHABLE_KEY=     # V2 (not used yet)
   CLERK_SECRET_KEY=
   ```

   `PORT` is set automatically by Railway.

4. **Mount a Volume** for persistent storage:
   - Railway service → Volumes → New Volume.
   - Mount path: `/data` (must match `DATA_PATH`).
   - Without a volume the JSON file is wiped on each deploy.

5. **Deploy**. Railway runs `npm start` automatically. Open the public URL → log in with Basic Auth.

6. **Verify**: hit `/api/health` (open, no auth) — should show `auth: "enabled"` and the configured services.

## What works in V1

- ✅ All 15 API routes implemented and auth-gated (except health)
- ✅ One-Click Pipeline: company + role → vetted shortlist + client report
- ✅ Demand-first flow (Companies → Managers → Needs → Candidates → Validations → Matches → Outreach)
- ✅ Six server-side agents
- ✅ JSON-file persistence with atomic writes
- ✅ Activity logs for every agent run
- ✅ Client report with summary (OpenAI when configured, template fallback), top 3–5 candidates, email draft, CSV export, copy-to-clipboard
- ✅ HTTP Basic Auth gate; server refuses to expose `/api/*` without `INTERNAL_PASSWORD`
- ✅ Frontend never sees keys; values never logged
- ✅ Airtable sync (snapshot of matches) on demand
- ✅ Error boundary; backend-unreachable banner; auth-disabled red banner

## What's V2 (not in this build)

- Clerk auth (replaces Basic Auth) — env vars are in place
- Postgres (replaces JSON file) when scale demands it
- Pre-compile JSX (drop in-browser Babel) for faster first paint
- SRI hashes on CDN scripts
- Rate limiting / batching for external APIs
- Component / E2E tests; CI on push
- Sentry observability
- Multi-table Airtable mirror (V1 syncs only matches)

## Repo layout

```
sola-scholar/
├── backend/
│   ├── server.js              # Express + all /api routes + agents
│   └── public/
│       └── index.html         # React frontend (Babel in browser)
├── data/                      # gitignored, created at runtime
│   └── data.json
├── .env.example               # documents required env vars
├── .gitignore                 # blocks .env, secrets, data/, node_modules
├── package.json               # express dep, optional dotenv, scripts
└── README.md
```
