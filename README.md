# Sola Scholar — Demand-First Recruiting

A single-file React app that runs entirely in the browser. Deployable as a static site (Railway, Netlify, GitHub Pages, anywhere).

## What it does

A **demand-first** recruiting pipeline that finds hiring managers, confirms what they're hiring for, then sources and validates candidates against a real, confirmed need — *before* reaching out.

```
Companies → Hiring Managers → Hiring Needs → Candidates → Validations → Matches → Outreach
```

## The 6 agents

| # | Agent          | What it does                                                                      | Powered by         |
|---|----------------|-----------------------------------------------------------------------------------|--------------------|
| 1 | Connector      | Find hiring managers (verified name + title + company + email)                    | Apollo.io          |
| 2 | Need Detector  | For a chosen company, scrape job postings → unconfirmed `hiring_needs`            | Firecrawl          |
| 3 | Scout          | Source candidates against a **confirmed** need; deduped pool                      | Firecrawl + GitHub |
| 4 | Validator      | GitHub repo analysis → proficiency map + tier (history-tracked)                   | GitHub             |
| 5 | Matchmaker     | Score candidates × need (35/20/15/15/15); stores all incl. `Drop` tier (<70)      | Local              |
| 6 | Composer       | Draft outreach (shortlist pitch or warm intro) — review/edit before sending       | Local              |

## The 7 entities

`companies` · `hiring_managers` · `hiring_needs` · `candidates` · `candidate_validations` · `matches` · `outreach`

Plus `users` (team members) and `logs` (activity feed).

## Setup

1. Open `index.html` in any modern browser (or deploy the file as a static site).
2. Click **Settings** in the sidebar.
3. Paste your API keys (all stored in browser `localStorage` only — they never leave your device except to call the API they belong to):
   - **Firecrawl** (free 500 credits/mo) — powers Need Detector + Scout.
   - **Apollo.io** (free 50 credits/mo) — powers Connector.
   - **Airtable** (optional) — mirrors all 7 tables for team collaboration.
4. Click **Run The Connector** on the Dashboard or Hiring Managers page to start.

## Architecture

**Client-only.** No backend, no server, no database. Every fetch goes directly from your browser to the relevant public API. Data persists to `localStorage` (capped at ~5MB by browsers) with optional Airtable sync.

### When to migrate to a server-side backend

> **Migration trigger** — when **any one** of these is true, route API calls through a small Express proxy on Railway and store keys in env vars:
> 1. A second teammate joins and you need shared data.
> 2. Apollo (or any other provider) blocks browser CORS.
> 3. You want scheduled jobs (e.g. weekly Need Detector sweeps).
>
> The UI does not change — only the URLs in the `fetch` calls. Estimated work: 1 day.

## Schema (browser-side)

```
companies            { id, name, domain, industry, size, hqLocation, hiringSignals[], notes, createdAt }
hiring_managers      { id, companyId(FK), name, title, roleCategory, email, emailConfidence, linkedinUrl, status, source, createdAt }
hiring_needs         { id, companyId(FK), managerId(FK?), title, description, requiredSkills[], tools[], seniority, locationType, location, salaryRange, sourceUrl, postedAt, confirmed, confirmationEvidence[], urgency, status, createdAt }
candidates           { id, name, currentTitle, currentCompany, location, skills[], github, linkedinUrl, portfolioUrl, resumeUrl, summary, email, source, dedupeKey, createdAt }
candidate_validations{ id, candidateId(FK), validatedAt, tier, proficiency{}, githubStats, certifications[], projects[], evidenceNotes }   # history table — multiple rows per candidate
matches              { id, needId(FK), candidateId(FK), score, tier, matchedSkills[], missingSkills[], reasoning[], rank, status, createdAt }
outreach             { id, managerId(FK), needId(FK?), matchIds[], channel, subject, body, kind, status, sentAt, repliedAt, replyText, nextAction, createdAt }
```

### Design decisions

- **Candidate dedupe** — by normalized LinkedIn URL → GitHub URL → email → `name|currentCompany`. The same person across multiple needs is one row in `candidates`, linked via separate `matches` rows.
- **Sub-70 matches** — stored with `tier='Drop'` and hidden by default. Toggle in Matches page to view.
- **Warm intros** — outreach with `managerId` set and `needId=null`, labeled `kind='warm-intro'`.
- **Validation history** — each Validator pass writes a new row to `candidate_validations`; the latest row is used for scoring. No data is overwritten.
- **No fabricated emails** — manual manager add requires a real email. Apollo records without a verified email are dropped, not synthesized.

## Deployment (Railway, static)

The entire app is a single `index.html`. Railway should be configured to serve the file as a static asset — no build step, no Node runtime, no env vars required server-side. (API keys live in the user's browser only.)

## Backup

Settings → "Export JSON backup" downloads the full local DB (all 7 tables + users + logs) as a single JSON file. There's no built-in restore — paste back into `localStorage.sola_scholar_v2` manually if you ever need it.
