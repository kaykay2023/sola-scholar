# Group 1 — skill synonym matching + must-have/nice-to-have handling

## Status: COMPLETE (branch `feat/group1-scoring-synonyms`, pushed; NOT merged, NOT deployed)

Authorized scope (explicit human approval 2026-07-02): synonyms + must-have handling only.
Weights (35/20/15/15/15) and validation component values FROZEN — untouched. Deploy = human.

## G1a — pending-commit verification
HEAD includes be3ad7f (candidate outcomes/learning) + 71830ac (Firecrawl-only block all market
modes), both undeployed (prod = dcbf28c). Verified at HEAD before any change:
`npm test` → PASS 1/2/3/4 ALL CHECKS PASSED, exit 0; `npm audit --omit=dev` → 0 vulnerabilities.
Deploy decision remains human-only.

## G1b — config-driven skill synonym matching
- NEW `config/skill-synonyms.json` — 22 curated alias groups (security-lane focused:
  Sentinel/Microsoft Sentinel/Azure Sentinel, SIEM long-form, SOC long-form, KQL/Kusto,
  IAM, Entra/Azure AD, Defender variants, EDR/XDR, MFA/2FA, DFIR/Incident Response,
  AWS/GCP/Azure long-forms, IaC, K8s, Zero Trust, GRC, pentesting, CrowdStrike, vuln mgmt).
  Loaded via existing `loadJsonConfig` (missing/malformed → no synonyms → legacy behavior).
- backend/server.js: `buildSkillSynonymResolver()` + `resolveSkillKey()` beside
  `normalizeSkillKey()`; test hooks `__setSkillSynonymGroupsForTest` / `__resetSkillSynonymGroups`
  exported via `_internals`.
- Alias resolution swapped in (same resolver everywhere → scoring, display, manual edits agree):
  - `scoreCandidateAgainstNeed` matched/missing + proficiency key lookup
  - `displaySkillBucketsForMatch`
  - `applyManualSkillEdit` dedupe keys (add/remove of one alias supersedes its group)
- Explicit group membership ONLY — no substring matching. Protection test
  "Azure does NOT match azure active directory via inclusion" still passes, plus new G1(b)/G1(f2)
  asserts the config keeps them separate.

## G1c — must-have vs nice-to-have (inside the 35% skill component)
- `need.mustHaveSkills` (optional; createNeed + runPipeline param + PATCH allowlist).
- Weighting: must-have = 2, nice-to-have = 1, applied INSIDE the skill component:
  `skillRaw = matchedWeight / totalWeight * 100` (proficiency path weighted identically).
  Outer weights unchanged. `mustHaveSkills` absent/empty → all weights 1 → **bit-identical to
  legacy formula** (proven: G1(c) expected-59 exact).
- Missing must-haves named in review/drop reasons: "Missing MUST-HAVE skills: X".

## Before/after score distribution (fixtures vs SOC Analyst need, synonyms OFF → ON)
| fixture | before | after | Δ | matched before→after | tier before→after |
|---|---|---|---|---|---|
| Apollo sparse: title-extracted | 47 | 47 | 0 | 2→2 | Weak→Weak |
| Apollo sparse w/ aliases | 36 | 47 | +11 | 0→2 | Drop→Weak |
| PDL-enriched long-form | 36 | 65 | +29 | 0→5 | Drop→Review |
| Exact-match rich (control) | 71 | 71 | 0 | 6→6 | Review→Review |
| Mixed exact + alias | 47 | 65 | +18 | 2→5 | Weak→Review |
| Adjacent-but-not-alias (control) | 36 | 36 | 0 | 0→0 | Drop→Drop |
| Cloud generalist w/ aliases | 36 | 41 | +5 | 0→1 | Drop→Weak |
| Zero overlap (control) | 36 | 36 | 0 | 0→0 | Drop→Drop |

All controls Δ0 → **no inflation**; lift comes only from real equivalent skills now counted.
All existing exact-score protection fixtures (59, 71, CSV, #20d equality) pass UNCHANGED with
the shipped config loaded — zero fixture collisions.

## New tests (test/pipeline.cjs section "G1", 18 assertions)
(a) alias-group match + non-alias still missing · (b) alias ≠ substring ·
(c) legacy formula exact-59 with synonyms off + no mustHaves · (c2) shipped config inert for
non-alias scores · (d) must-have hit = exact-62 · (d2) missing must-have = exact-53 + named in
reason · (e/e2/e3) display buckets agree with scoring, alias-group manual remove, edits stay
display-only (score unchanged) · (f/f2) shipped-config sanity.

## Constraint self-check
- Scoring weights NOT changed (35/20/15/15/15 intact); validation values NOT changed.
- Ordering: still score-desc; no ordering code touched.
- Verified-only filtering / gates / Firecrawl blocking / Basic Auth: untouched.
- Manual skills still display/report-only (G1(e3) proves score unchanged).
- No protection test loosened; existing exact-score tests pass unchanged; new tests added.
- No deploy, no merge, no Railway/DNS/secrets.
- Deviation note: CLAUDE.md Linear workflow — issue creation was DENIED by the permission
  classifier (external write not explicitly requested). Work proceeded under explicit human
  authorization; Linear issue + PR link need human action or permission grant.

## Verification commands
1. `Set-Location "C:\Users\oluka\Downloads\verify code\sola-scholar"; npm test` → PASS 1–4, exit 0.
2. `npm audit --omit=dev` → found 0 vulnerabilities.
3. `node test/pipeline.cjs` → all `G1(...)` OK lines above.

## Deferred (per authorization)
- Validation component rebalance (Group 1 item, weights frozen by user choice).
- Outcomes/learning calibration (later; groundwork verified at HEAD).
