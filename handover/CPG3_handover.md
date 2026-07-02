# Group 3 — review workflow + trust tightening

## Status: COMPLETE (branch `feat/group3-review-trust`, STACKED on `feat/group2-pull-evidence`; NOT merged, NOT deployed)

## G3A — reviewer bulk actions
- `POST /api/candidates/bulk-review` (auth-protected). Actions: approve / reject / keep.
  Requires candidateIds + action + reason; max batch 50; per-candidate ok/failure results
  (never silent). Approve reuses existing manual-approval semantics; reject sets
  `manualVisibilityRejection` → MANUAL_REVIEW_REJECTED (HIDDEN, recoverable). Every action
  writes a `reviewAudit` entry (action, reason, reviewer, at, previous/new state + reason code).
  **Non-bypassable:** bulk approve refuses a firecrawl-only-unresolved candidate.
- UI: Needs Review workspace on Candidates page (Status=Review) — grouped by reason code,
  per-candidate checkboxes + group select-all, count before action, confirm dialog, partial-
  failure display, filters (reason via grouping, provider, location/work-history confidence),
  resolution-queue status per candidate. No secrets/PII/provider payloads shown.

## G3B — tighten UNSTRUCTURED_PROVIDER_SECURITY_PROFILE (tighten-only)
- Source trust (Apollo/PDL/LinkedIn) and/or a LinkedIn URL alone are no longer sufficient.
  A candidate VISIBLE only via UNSTRUCTURED_PROVIDER_SECURITY_PROFILE with NO structured
  work-history evidence → NEEDS_REVIEW / `UNSTRUCTURED_PROFILE_NO_WORK_HISTORY_PROOF` (recoverable).
- Acceptable work-history evidence (`hasApprovedWorkHistoryEvidence`): Apollo/PDL structural
  resolution, PDL-enriched experience, or a structured workHistory/experience/positions field.
- Applied as the FINAL step in `evaluateSourcingQuality`, AFTER the specific structural gates,
  so firecrawl-only / Apollo-unresolved / out-of-market keep their exact reason codes.
- discovered_by / resolved_by / provider_of_record distinctions preserved.
- **Impact analysis (fixture, aggregate, no PII):** source-trust-only shapes
  (apollo/pdl/linkedin, no history) → NEEDS_REVIEW; structured-work-history shape stays VISIBLE
  (MID_SECURITY_EXPERIENCE_PASS). No previously-blocked candidate becomes visible.

## G3C — internal confidence/evidence explanations
- `ReviewExplanation` component (internal View Matches + Needs Review): plain-language reason,
  discovered/resolved/record providers, location + work-history confidence, identity status,
  resolution-queue status, last review action. Concise, deduped, INTERNAL ONLY. No raw payloads,
  no secrets, no unnecessary PII. `GET /api/resolution-queue` for reviewer view.

## G3D — client-safe "why this candidate"
- `clientWhyLine()` — deterministic (no OpenAI). Built ONLY from verified evidence: scored
  (provider-evidence) matched skills — NOT display buckets, so manual skills can't appear as
  proof — plus title/company (company only if work-history verified) + location-match reasoning.
  No score, no match labels, no provider names, no reason codes, no review language. Thin
  evidence → minimal factual line. Rendered in Client Report card + email + CSV column.

## G3E — review backlog metrics
- `GET /api/review/metrics` + `reviewBacklogMetrics()`: totals, Needs Review by reason/provider/
  location-confidence/work-history-confidence, aging buckets, resolution-queue by status, bulk
  actions (approved/rejected/kept). Aggregate counts only — no candidate PII (asserted).

## Files changed
- backend/server.js (bulk review + metrics + why-line + G3B tighten + 3 routes + exports)
- backend/public/index.html (ReviewExplanation, Needs Review workspace, why-line render)
- test/pipeline.cjs (G3 section; 3 GitHub-contributor assertions tightened accepted→NEEDS_REVIEW)

## Protection-test changes (TIGHTENED, never loosened; before/after)
GitHub contributor mining (Azure Security Engineer / Remote need): contributors have security
bios but no employment history, so under G3B they are held in Needs Review (GitHub alone is not
client-ready). BEFORE: `scoutDecision==='accepted'` + `acceptedBySource.github>=2`. AFTER:
`scoutDecision==='review'` + `visibility===NEEDS_REVIEW` + `reason===UNSTRUCTURED_PROFILE_NO_WORK_HISTORY_PROOF`
+ recoverable + `reviewBySource.github>=2`. Identity still verified; candidates retained. Stricter.
No other existing assertion changed (the Apollo-unresolved / firecrawl reason-code tests pass
UNCHANGED because the tighten runs last and those specific gates keep precedence).

## Verification
`npm test` PASS 1–4 · `npm audit --omit=dev` 0 vulnerabilities · `predeploy-check.ps1` exit 0
(SAFE TO REQUEST DEPLOY APPROVAL). No merge, no deploy, no Railway/DNS/env/secret/key changes.
