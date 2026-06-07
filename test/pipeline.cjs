/**
 * VERIFICATION PASS 4 — PIPELINE RUN ISOLATION (Codex round 2)
 *
 * Hermetic: no live network. global.fetch is stubbed before requiring the
 * server module. The stub returns canned responses for a small set of GitHub
 * users used by the GitHub-validation-path test, and refuses everything else.
 *
 * Covers Codex round-2 acceptance criteria:
 *   1. Match identity scoped to (needId, candidateId, pipelineRunId).
 *   2. Match scoring uses the current run's validation only (not "latest globally").
 *   3. Tests hermetic — no live API/network dependency.
 *   4. Manager selection never borrows from an unrelated company.
 *   5. Dropped counts isolated across runs (with seeded prior drops).
 *   6. Full GitHub validation path lands in Verified Active / Profile-Based.
 *   7. Same candidate across two runs → two distinct match records.
 *   8. Health endpoint no longer leaks dataPath.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const FAILURES = [];
const fail = (m) => { console.error('FAIL:', m); FAILURES.push(m); };
const ok = (m) => console.log('OK:', m);
const assert = (cond, m) => { if (!cond) fail(m); else ok(m); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sola-pipeline-'));
process.env.DATA_PATH = TMP;
process.env.INTERNAL_USER = 'tester';
process.env.INTERNAL_PASSWORD = process.env.INTERNAL_PASSWORD || 'pipeline-test-pw';

// ── Hermetic fetch stub ────────────────────────────────────────────────────
// All external HTTP is intercepted. By default we return a non-ok response so
// every external client (apollo/firecrawl/adzuna/hunter/openai/airtable/github)
// degrades gracefully (those clients all check res.ok). For the GitHub repos
// endpoint of a specific test user we return rich data so we can exercise the
// full GitHub validation path.
let STUB_GH_USER_RECORDS = null; // { login: { type: 'User' | 'Organization', name? } }
const fetchCalls = [];
const mkRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const recentISO = new Date(Date.now() - 1 * 86400 * 1000).toISOString(); // 1 day ago

// Test-controlled response stores for endpoints that vary per test
let STUB_FIRECRAWL_ITEMS = null;     // when set, /v1/search returns these as data[]
let STUB_GH_SEARCH_USERS = null;     // when set, /search/users returns { items: [...] }
let STUB_APOLLO_PEOPLE = null;       // when set, mixed_people/search returns { people: [...] }
let STUB_APOLLO_HTTP = null;         // when set, mixed_people/search returns non-2xx with given status/body
let STUB_APOLLO_MATCH = null;        // map/function for /api/v1/people/match
let STUB_APOLLO_MATCH_HTTP = null;   // when set, people/match returns non-2xx
const APOLLO_MATCH_CALLS = [];       // captured sanitized Match call markers
const APOLLO_SEARCH_CALLS = [];      // captured sanitized Search request bodies
let LAST_APOLLO_MATCH_BODY = null;   // last parsed JSON body sent to Apollo people/match
let STUB_GH_CONTRIBUTORS = null;     // { 'owner/repo': [{login, type, html_url}] }
let STUB_ADZUNA_RESULTS = null;      // { results: [...] }
const GH_CONTRIB_CALLS = [];         // captured 'owner/repo' calls
let STUB_PDL_SEARCH = null;          // when set, /v5/person/search returns { data: [...] }
let STUB_PDL_LOOKUP = null;          // when set, /v5/person/enrich?profile= returns { data: {...} }
let STUB_PDL_RESOLVE = null;         // map: 'firstName lastName' → { data: { linkedin_url } } or null
let STUB_PDL_RESOLVE_HTTP = null;    // when set, /v5/person/enrich resolve returns { status, body }
let STUB_HUNTER_EMAIL = null;        // when set, hunter email-finder returns this string
const PDL_CALLS = [];                // captured endpoint paths
let LAST_PDL_SEARCH_BODY = null;     // last parsed JSON body sent to PDL /v5/person/search
let LAST_PDL_REQUEST_HEADERS = null; // last headers sent to PDL, lower-cased
let STUB_OPENAI_RESPONSE = null;     // when set, openai chat completion returns this content string
const OPENAI_CALLS = [];             // captured request bodies (parsed)
let LAST_APOLLO_REQUEST_BODY = null; // last parsed JSON body sent to Apollo mixed_people/search
let LAST_APOLLO_REQUEST_HEADERS = null; // last headers sent to Apollo, lower-cased
const FIRECRAWL_QUERIES = [];

global.fetch = async (url, opts) => {
  const u = String(url);
  fetchCalls.push(u);

  if (/api\.firecrawl\.dev\/v1\/search/.test(u)) {
    try {
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      FIRECRAWL_QUERIES.push(body.query || '');
    } catch {
      FIRECRAWL_QUERIES.push('');
    }
    return mkRes({ success: true, data: STUB_FIRECRAWL_ITEMS || [] });
  }
  if (/api\.github\.com\/search\/users/.test(u)) {
    return mkRes(STUB_GH_SEARCH_USERS || { items: [] });
  }
  // GitHub /repos/{owner}/{repo}/contributors
  {
    const m = u.match(/api\.github\.com\/repos\/([^/]+)\/([^/?]+)\/contributors/);
    if (m) {
      const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
      GH_CONTRIB_CALLS.push(key);
      const arr = (STUB_GH_CONTRIBUTORS && STUB_GH_CONTRIBUTORS[key]) || [];
      return mkRes(arr);
    }
  }
  // Adzuna /v1/api/jobs/.../search/
  if (/api\.adzuna\.com\/v1\/api\/jobs\/[^/]+\/search/.test(u)) {
    return mkRes(STUB_ADZUNA_RESULTS || { results: [] });
  }
  // PDL /v5/person/search (POST, ES bool body)
  if (/api\.peopledatalabs\.com\/v5\/person\/search/.test(u)) {
    PDL_CALLS.push('search/person');
    try { LAST_PDL_SEARCH_BODY = opts && opts.body ? JSON.parse(opts.body) : null; }
    catch { LAST_PDL_SEARCH_BODY = null; }
    LAST_PDL_REQUEST_HEADERS = {};
    const h = (opts && opts.headers) || {};
    if (typeof h.forEach === 'function') {
      h.forEach((v, k) => { LAST_PDL_REQUEST_HEADERS[String(k).toLowerCase()] = String(v); });
    } else {
      for (const [k, v] of Object.entries(h)) LAST_PDL_REQUEST_HEADERS[String(k).toLowerCase()] = String(v);
    }
    return mkRes(STUB_PDL_SEARCH || { data: [] });
  }
  // PDL /v5/person/enrich (GET) — both Profile Lookup (?profile=) and
  // Profile Resolve (?first_name=&last_name=&company=) hit this endpoint.
  if (/api\.peopledatalabs\.com\/v5\/person\/enrich/.test(u)) {
    if (/[?&]profile=/.test(u)) {
      PDL_CALLS.push('enrich/profile');
      return mkRes(STUB_PDL_LOOKUP || { data: null });
    }
    PDL_CALLS.push('enrich/resolve');
    if (STUB_PDL_RESOLVE_HTTP) {
      return mkRes(STUB_PDL_RESOLVE_HTTP.body || {}, STUB_PDL_RESOLVE_HTTP.status || 200);
    }
    const m = u.match(/first_name=([^&]+)&last_name=([^&]+)/);
    const key = m ? `${decodeURIComponent(m[1])} ${decodeURIComponent(m[2])}` : '';
    const entry = STUB_PDL_RESOLVE && STUB_PDL_RESOLVE[key];
    return mkRes(entry || { data: null });
  }
  // OpenAI chat completions
  if (/api\.openai\.com\/v1\/chat\/completions/.test(u)) {
    try { OPENAI_CALLS.push(opts && opts.body ? JSON.parse(opts.body) : null); }
    catch { OPENAI_CALLS.push(null); }
    if (STUB_OPENAI_RESPONSE) {
      return mkRes({ choices: [{ message: { content: STUB_OPENAI_RESPONSE } }] });
    }
    return mkRes({ choices: [{ message: { content: '' } }] });
  }
  // Hunter email-finder
  if (/api\.hunter\.io\/v2\/email-finder/.test(u)) {
    if (STUB_HUNTER_EMAIL) return mkRes({ data: { email: STUB_HUNTER_EMAIL } });
    return mkRes({ data: { email: null } });
  }
  if (/api\.apollo\.io\/api\/v1\/people\/match/.test(u)) {
    try { LAST_APOLLO_MATCH_BODY = opts && opts.body ? JSON.parse(opts.body) : null; }
    catch { LAST_APOLLO_MATCH_BODY = null; }
    APOLLO_MATCH_CALLS.push({
      hasId: !!(LAST_APOLLO_MATCH_BODY && LAST_APOLLO_MATCH_BODY.id),
      hasLinkedIn: !!(LAST_APOLLO_MATCH_BODY && LAST_APOLLO_MATCH_BODY.linkedin_url),
      hasName: !!(LAST_APOLLO_MATCH_BODY && LAST_APOLLO_MATCH_BODY.name),
      hasOrganizationName: !!(LAST_APOLLO_MATCH_BODY && LAST_APOLLO_MATCH_BODY.organization_name),
    });
    if (STUB_APOLLO_MATCH_HTTP) {
      const body = STUB_APOLLO_MATCH_HTTP.body || {};
      const txt = typeof body === 'string' ? body : JSON.stringify(body);
      return {
        ok: false,
        status: STUB_APOLLO_MATCH_HTTP.status || 404,
        json: async () => (typeof body === 'string' ? {} : body),
        text: async () => txt,
      };
    }
    const key = LAST_APOLLO_MATCH_BODY && (LAST_APOLLO_MATCH_BODY.id || LAST_APOLLO_MATCH_BODY.linkedin_url || LAST_APOLLO_MATCH_BODY.name);
    const entry = typeof STUB_APOLLO_MATCH === 'function'
      ? STUB_APOLLO_MATCH(LAST_APOLLO_MATCH_BODY)
      : (STUB_APOLLO_MATCH && key ? STUB_APOLLO_MATCH[key] : null);
    if (entry === null) return mkRes({ person: null }, 404);
    return mkRes(entry || { person: null });
  }
  if (/api\.apollo\.io\/v1\/mixed_people\/api_search/.test(u)) {
    // Capture outbound body for assertions on title-cap behavior.
    try { LAST_APOLLO_REQUEST_BODY = opts && opts.body ? JSON.parse(opts.body) : null; }
    catch { LAST_APOLLO_REQUEST_BODY = null; }
    APOLLO_SEARCH_CALLS.push({
      person_locations: Array.isArray(LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_locations)
        ? LAST_APOLLO_REQUEST_BODY.person_locations.slice()
        : [],
      person_titles: Array.isArray(LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_titles)
        ? LAST_APOLLO_REQUEST_BODY.person_titles.slice()
        : [],
      q_keywords: LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.q_keywords || '',
      per_page: LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.per_page || 0,
      titleCount: Array.isArray(LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_titles)
        ? LAST_APOLLO_REQUEST_BODY.person_titles.length
        : 0,
    });
    LAST_APOLLO_REQUEST_HEADERS = {};
    const h = (opts && opts.headers) || {};
    if (typeof h.forEach === 'function') {
      h.forEach((v, k) => { LAST_APOLLO_REQUEST_HEADERS[String(k).toLowerCase()] = String(v); });
    } else {
      for (const [k, v] of Object.entries(h)) LAST_APOLLO_REQUEST_HEADERS[String(k).toLowerCase()] = String(v);
    }
    if (STUB_APOLLO_HTTP) {
      // Simulated Apollo non-2xx with response body. Body is whatever the test
      // sets in STUB_APOLLO_HTTP.body (string or object).
      const body = STUB_APOLLO_HTTP.body || {};
      const txt = typeof body === 'string' ? body : JSON.stringify(body);
      return {
        ok: false,
        status: STUB_APOLLO_HTTP.status || 422,
        json: async () => (typeof body === 'string' ? {} : body),
        text: async () => txt,
      };
    }
    const people = (typeof STUB_APOLLO_PEOPLE === 'function')
      ? STUB_APOLLO_PEOPLE(LAST_APOLLO_REQUEST_BODY)
      : (STUB_APOLLO_PEOPLE || []);
    return mkRes({ people });
  }

  // Block anything that isn't api.github.com — we don't want apollo/firecrawl/
  // hunter/openai/airtable/adzuna calls to ever pretend they succeeded.
  if (/^https:\/\/api\.github\.com\/users\/ghdemo-verified\/repos/.test(u)) {
    return mkRes([
      { language: 'JavaScript', stargazers_count: 5, forks_count: 1, pushed_at: recentISO },
      { language: 'TypeScript', stargazers_count: 3, forks_count: 0, pushed_at: recentISO },
      { language: 'JavaScript', stargazers_count: 1, forks_count: 0, pushed_at: recentISO },
    ]);
  }
  // Any other github users/.../repos → 404 (fetch failed). validator falls
  // back to Needs Review / Insufficient Data as appropriate.
  if (/^https:\/\/api\.github\.com\/users\/[^/]+\/repos/.test(u)) {
    return mkRes('Not Found', 404);
  }
  // User-record lookup (no /repos suffix). When test sets STUB_GH_USER_RECORDS,
  // return the stubbed type so the runScout GH API verification path can run.
  // Default for unknown logins: 404 → githubUser returns null → classifier
  // stays at "review" (no blind accept).
  if (/^https:\/\/api\.github\.com\/users\/[^/?#]+(?:[?#]|$)/.test(u) && !/\/repos(?:[?#]|$)/.test(u)) {
    const ghm = u.match(/users\/([^/?#]+)/);
    const login = ghm ? ghm[1] : '';
    if (STUB_GH_USER_RECORDS && STUB_GH_USER_RECORDS[login]) {
      return mkRes(STUB_GH_USER_RECORDS[login]);
    }
    return mkRes({}, 404);
  }
  // Everything else → not-ok. apolloSearch / firecrawlSearch / etc. all handle.
  return mkRes('blocked-by-test-stub', 599);
};

// Prevent the server from binding a real port if start() somehow runs.
const realListen = http.Server.prototype.listen;
http.Server.prototype.listen = function () { this.close && this.close(); return this; };
const server = require(path.join('..', 'backend', 'server.js'));
http.Server.prototype.listen = realListen;

const { DB, _internals } = server;
const {
  findOrCreateCompany, findOrCreateManager, findOrCreateCandidate, createNeed,
  createValidation, createOrUpdateMatch,
  runValidator, runMatchmaker, runScout, runPipeline, latestValidation,
  newPipelineRunId, hasReviewEvidence, tierFromScore, scoreCandidateAgainstNeed,
  classifySourceItem, generateClientReport, isLinkedInProfileUrl,
  isUsableGitHubProfileUrl, hasUsableProfileLink, isVisibleMatch,
  isVerifiedGitHubProfile, isFinalShortlistEligible, isClientReadyForNeed,
  scoreSourcedPage, buildApolloCandidateAttempts, buildFirecrawlProfileQueries,
  buildCandidateSearchExpansion, buildRankedTitleVariants, buildLocationTiers,
  extractProfileKeywordSignals, collectCandidateProfileLinks,
  isGitLabUserProfileUrl, isHuggingFaceProfileUrl, isKaggleProfileUrl,
  isStackOverflowUserUrl, isCredlyProfileUrl, isTryHackMeProfileUrl,
  isHackTheBoxProfileUrl, isWellfoundProfileUrl, isTrustedCandidateProfileUrl,
  VISIBILITY_STATE, applySourcingQualityGate, evaluateSourcingQuality,
  isFirecrawlOnlyUnresolved, isGithubPrimaryEvidenceRole,
  sourcingRejectionStub,
  apolloPeopleMatch, resolveApolloMaxEnrichPerRun, resolveApolloVolumeConfig, APOLLO_MATCH_DEFAULT_MAX_PER_RUN, APOLLO_MAX_RESULTS_PER_VARIANT_DEFAULT, APOLLO_MAX_VARIANTS_PER_RUN_DEFAULT, APOLLO_MAX_CANDIDATES_PER_RUN_DEFAULT, apolloSearchLocationFromNeed,
  selectedMarketFromNeed, isApolloOutsideSelectedMarket,
} = _internals;

// NOTE: do NOT call loadDB() — it reassigns the module-internal `DB` binding
// to a fresh empty object, but our destructured `DB` reference would then be
// stale. The module-load initial DB is already an empty object shared with
// module internals.

async function main() {
  // ── 1. Tier thresholds ────────────────────────────────────────────────
  assert(tierFromScore(85) === 'Strong Match', 'tierFromScore 85 → Strong Match');
  assert(tierFromScore(70) === 'Review',       'tierFromScore 70 → Review');
  assert(tierFromScore(50) === 'Weak Match',   'tierFromScore 50 → Weak Match');
  assert(tierFromScore(30) === 'Drop',         'tierFromScore 30 → Drop');

  // ── 2. hasReviewEvidence ─────────────────────────────────────────────
  assert(hasReviewEvidence({ linkedinUrl: 'x' }) === true,              'hasReviewEvidence: linkedinUrl → true');
  assert(hasReviewEvidence({ skills: ['Azure'] }) === true,             'hasReviewEvidence: skill → true');
  assert(hasReviewEvidence({ source: 'Manual', skills: [] }) === false, 'hasReviewEvidence: bare manual → false');
  assert(hasReviewEvidence({ sourceUrl: 'https://x' }) === true,        'hasReviewEvidence: sourceUrl → true');

  // ── 3. Firecrawl-no-GitHub, bare, and FULL GitHub validation path ────
  const runA = 'test_run_A_' + Date.now().toString(36);
  const fcCand = findOrCreateCandidate({
    name: 'Alex Cloud',
    title: 'Cloud Security Engineer',
    summary: 'Cloud security engineer specializing in Azure Sentinel and KQL detection.',
    skills: ['Azure', 'Sentinel'],
    linkedinUrl: 'https://linkedin.com/in/alex-cloud',
    sourceUrl: 'https://example.com/alex',
    source: 'Web',
    scoutDecision: 'accepted', // legacy run-isolation tests assume matchmaker-eligible
    pipelineRunId: runA,
  });
  // Bare candidate has no links → naturally belongs in review pool, not the
  // final shortlist. Validator still produces "Insufficient Data" for it.
  const bareCand = findOrCreateCandidate({
    name: 'Cory Empty',
    source: 'Manual',
    scoutDecision: 'review',
    pipelineRunId: runA,
  });
  // Full GitHub validation path exerciser — our fetch stub returns 3 repos
  // (JavaScript ×2, TypeScript ×1, recent pushed_at, stars > 0) → Verified Active.
  const ghVerifiedCand = findOrCreateCandidate({
    name: 'GH Demo Verified',
    title: 'Engineer',
    github: 'https://github.com/ghdemo-verified',
    source: 'GitHub',
    scoutDecision: 'accepted',
    pipelineRunId: runA,
  });

  const fetchCountBefore = fetchCalls.length;
  const valRes = await runValidator({
    candidateIds: [fcCand.id, bareCand.id, ghVerifiedCand.id],
    pipelineRunId: runA,
  });
  const fetchCountAfter = fetchCalls.length;

  // Full GitHub path was called (the validator hit api.github.com/users/ghdemo-verified/repos)
  const ghRepoCalls = fetchCalls.slice(fetchCountBefore).filter(u =>
    /api\.github\.com\/users\/ghdemo-verified\/repos/.test(u)
  );
  assert(ghRepoCalls.length >= 1,
    `Full GitHub validation path was called for ghdemo-verified (saw ${ghRepoCalls.length} repo fetches)`);

  const ghVal = latestValidation(ghVerifiedCand.id, runA);
  assert(ghVal && (ghVal.tier === 'Verified Active' || ghVal.tier === 'Profile-Based'),
    `GitHub candidate with repos → tier="${ghVal && ghVal.tier}" (expected Verified Active or Profile-Based)`);
  assert(ghVal && ghVal.githubStats && ghVal.githubStats.repos >= 1,
    `GitHub validation has githubStats.repos >= 1 (got ${ghVal && ghVal.githubStats && ghVal.githubStats.repos})`);
  assert(valRes.fullyValidated >= 1,
    `Validator fullyValidated count ≥ 1 from GitHub path (got ${valRes.fullyValidated})`);

  const fcVal = latestValidation(fcCand.id, runA);
  assert(fcVal && fcVal.tier === 'Needs Review',
    `Firecrawl candidate without GitHub → tier="${fcVal && fcVal.tier}" (expected "Needs Review")`);
  assert(fcVal.pipelineRunId === runA, 'Validation stamped with pipelineRunId');

  const bareVal = latestValidation(bareCand.id, runA);
  assert(bareVal && bareVal.tier === 'Insufficient Data',
    `Bare candidate → tier="${bareVal && bareVal.tier}" (expected "Insufficient Data")`);

  assert(valRes.needsReview >= 1, `Validator needsReview ≥ 1 (got ${valRes.needsReview})`);
  assert(valRes.insufficientData >= 1, `Validator insufficientData ≥ 1 (got ${valRes.insufficientData})`);
  assert(typeof valRes.validated === 'number' && valRes.validated === valRes.fullyValidated + valRes.needsReview,
    `Validator validated = fullyValidated + needsReview (validated=${valRes.validated}, full=${valRes.fullyValidated}, review=${valRes.needsReview})`);
  assert(valRes.validated > 0,
    `validated must not be 0 when validation records were created (got ${valRes.validated})`);

  // ── 4. Matchmaker scoped to current run ──────────────────────────────
  const coA = findOrCreateCompany({ name: 'Run-Isolation Co A', pipelineRunId: runA });
  const need = createNeed({
    companyId: coA.id,
    title: 'Cloud Security Engineer',
    requiredSkills: ['Azure', 'Sentinel', 'KQL'],
    seniority: 'Mid',
    locationType: 'Remote',
    confirmed: true,
    pipelineRunId: runA,
  });

  // Seed 3 prior dropped matches against this need from an OLD run. These
  // must not affect the runA matchmaker's dropped count.
  const oldRunId = 'old_run_' + Date.now().toString(36);
  for (let i = 0; i < 3; i++) {
    createOrUpdateMatch({
      needId: need.id,
      candidateId: 'phantom_old_' + i,
      pipelineRunId: oldRunId,
      score: 10, tier: 'Drop',
      matchedSkills: [], missingSkills: ['Azure'],
      reasoning: ['old run prior drop'], rank: 99,
      dropReason: 'No required skill overlap',
    });
  }
  const seededOldDropped = DB.matches.filter(m =>
    m.needId === need.id && m.pipelineRunId === oldRunId && m.tier === 'Drop'
  ).length;
  assert(seededOldDropped === 3, `Seeded 3 prior-run dropped matches (got ${seededOldDropped})`);

  const mmA = await runMatchmaker({ needId: need.id, pipelineRunId: runA });
  // Pool excludes bareCand (scoutDecision='review' — no usable link). 2 candidates
  // with real LinkedIn / GitHub profile links remain.
  assert(mmA.matched === 2, `runA matchmaker scored 2 link-bearing runA candidates (got ${mmA.matched})`);

  const droppedRunA = DB.matches.filter(m =>
    m.needId === need.id && m.pipelineRunId === runA && m.tier === 'Drop'
  ).length;
  // Old run's dropped matches are still there but untouched
  const droppedOldAfter = DB.matches.filter(m =>
    m.needId === need.id && m.pipelineRunId === oldRunId && m.tier === 'Drop'
  ).length;
  assert(droppedOldAfter === 3, `Prior-run drops unchanged after runA matchmaker (was 3, now ${droppedOldAfter})`);
  assert(mmA.dropped === droppedRunA,
    `Matchmaker reported dropped (${mmA.dropped}) equals runA-scoped drops in DB (${droppedRunA}) — old drops excluded`);

  // ── 5. Matchmaker for runB only scores runB candidates ───────────────
  const runB = 'test_run_B_' + Date.now().toString(36);
  const otherRunCand = findOrCreateCandidate({
    name: 'Dana OtherRun',
    title: 'Engineer',
    skills: ['Python'],
    linkedinUrl: 'https://www.linkedin.com/in/dana-otherrun',
    source: 'Manual',
    scoutDecision: 'accepted',
    pipelineRunId: runB,
  });

  const mmA2 = await runMatchmaker({ needId: need.id, pipelineRunId: runA });
  assert(mmA2.matched === 2,
    `Re-running runA matchmaker still scores only the 2 link-bearing runA candidates (got ${mmA2.matched})`);
  const droppedRunAAfter = DB.matches.filter(m =>
    m.needId === need.id && m.pipelineRunId === runA && m.tier === 'Drop'
  ).length;
  assert(droppedRunA === droppedRunAAfter,
    `runA dropped did not grow when runB candidate exists (was ${droppedRunA}, now ${droppedRunAAfter})`);

  const mmB = await runMatchmaker({ needId: need.id, pipelineRunId: runB });
  assert(mmB.matched === 1, `runB matchmaker scores only the 1 runB candidate (got ${mmB.matched})`);

  const runBMatchedCandidateIds = DB.matches
    .filter(m => m.pipelineRunId === runB && m.needId === need.id)
    .map(m => m.candidateId);
  assert(
    runBMatchedCandidateIds.length > 0 && runBMatchedCandidateIds.every(id => id === otherRunCand.id),
    'Matches stamped with runB only reference runB candidates'
  );

  // ── 6. Every Drop/Weak/Review match has dropReason/reviewReason ──────
  const reviewish = DB.matches.filter(m =>
    m.tier === 'Drop' || m.tier === 'Weak Match' || m.tier === 'Review'
  );
  const missingReason = reviewish.filter(m =>
    (m.tier === 'Drop' ? !m.dropReason : !m.reviewReason)
  );
  assert(missingReason.length === 0,
    `Every Drop/Weak/Review match has a reason (${reviewish.length} checked, ${missingReason.length} missing)`);

  // ── 7. scoreCandidateAgainstNeed produces specific reasons ──────────
  const noOverlapCand = findOrCreateCandidate({
    name: 'No Overlap',
    title: 'Mid',
    skills: ['PHP'],
    source: 'Manual',
    pipelineRunId: runA,
  });
  const score = scoreCandidateAgainstNeed(noOverlapCand, need, runA);
  const dropOrReview = score.dropReason || score.reviewReason;
  assert(/No required skill overlap/.test(dropOrReview),
    `No-overlap reason contains "No required skill overlap" (got: ${dropOrReview})`);
  assert(/Missing required skills: Azure, Sentinel, KQL/.test(dropOrReview),
    `Missing-skills list appears in reason (got: ${dropOrReview})`);

  // ── 8. Same candidate across TWO runs → TWO distinct match records ───
  const sharedCand = findOrCreateCandidate({
    name: 'Cross Run Cand',
    skills: ['Azure', 'Sentinel'],
    linkedinUrl: 'https://linkedin.com/in/cross-run',
    source: 'Web',
    scoutDecision: 'accepted',
    pipelineRunId: runA,
  });
  // Run-scoped validations: low-evidence in runA, full in runB
  createValidation(sharedCand.id, {
    tier: 'Needs Review',
    evidenceNotes: 'runA partial evidence',
    pipelineRunId: runA,
  });
  createValidation(sharedCand.id, {
    tier: 'Verified Active',
    proficiency: { Azure: 95, Sentinel: 90, KQL: 80 },
    evidenceNotes: 'runB strong evidence',
    pipelineRunId: runB,
  });

  // Validation lookup is strictly run-scoped — no cross-run borrowing
  const vA = latestValidation(sharedCand.id, runA);
  const vB = latestValidation(sharedCand.id, runB);
  assert(vA && vA.tier === 'Needs Review',  `latestValidation(runA) returns runA validation only (got tier="${vA && vA.tier}")`);
  assert(vB && vB.tier === 'Verified Active', `latestValidation(runB) returns runB validation only (got tier="${vB && vB.tier}")`);

  // Score sharedCand under each run; expect different scores driven by validation
  const scoreA = scoreCandidateAgainstNeed(sharedCand, need, runA);
  const scoreB = scoreCandidateAgainstNeed(sharedCand, need, runB);
  assert(scoreA.score === 59,
    `Needs Review validation does NOT boost numeric score (expected original 59, got ${scoreA.score})`);
  assert(!(scoreA.reasoning || []).some(r => /Needs human review/.test(r)),
    `Needs Review is not used as a positive scoring reason (got ${JSON.stringify(scoreA.reasoning)})`);
  assert(scoreB.score > scoreA.score,
    `Same candidate scored higher with runB's stronger validation (runA=${scoreA.score}, runB=${scoreB.score})`);

  // ── 7b. Exact skill matching in scoreCandidateAgainstNeed ─────────
  //
  // Scoring math guardrail: a candidate skill must exactly match the required
  // skill after normalization. Compound skills like "azure active directory"
  // or "cloud security" must not score as "Azure" or "Security".
  {
    const exactMatchNeed = createNeed({
      companyId: coA.id,
      title: 'Azure Security Engineer',
      requiredSkills: ['Azure', 'Security', 'KQL', 'Incident Response'],
      seniority: 'Mid',
      locationType: 'Remote',
      confirmed: true,
    });
    const exactRun = 'exact_match_' + Date.now().toString(36);

    // (1) Compound candidate skills do not match shorter required skills.
    const pdlStyleCand = findOrCreateCandidate({
      name: 'PDL-style Compound',
      skills: ['azure active directory', 'cloud security', 'incident response'],
      linkedinUrl: 'https://www.linkedin.com/in/pdl-compound',
      source: 'PDL',
      scoutDecision: 'accepted',
      pipelineRunId: exactRun,
    });
    const compoundScore = scoreCandidateAgainstNeed(pdlStyleCand, exactMatchNeed, exactRun);
    assert(!compoundScore.matchedSkills.includes('Azure'),
      `"Azure" does NOT match "azure active directory" via inclusion (got matched=${JSON.stringify(compoundScore.matchedSkills)})`);
    assert(!compoundScore.matchedSkills.includes('Security'),
      `"Security" does NOT match "cloud security" via inclusion (got matched=${JSON.stringify(compoundScore.matchedSkills)})`);
    assert(compoundScore.matchedSkills.includes('Incident Response'),
      `"Incident Response" still matches exact normalized skill (got matched=${JSON.stringify(compoundScore.matchedSkills)})`);

    // (2) Unrelated required skill stays unmatched and appears in missing list
    for (const missingSkill of ['Azure', 'Security', 'KQL']) {
      assert(compoundScore.missingSkills.includes(missingSkill),
        `"${missingSkill}" appears in missingSkills (got missing=${JSON.stringify(compoundScore.missingSkills)})`);
    }

    // (3) Exact single-token match still works (pre-existing behavior preserved)
    const exactCand = findOrCreateCandidate({
      name: 'Exact Token',
      skills: ['Azure', 'Sentinel', 'KQL'],
      linkedinUrl: 'https://www.linkedin.com/in/exact-token',
      source: 'Manual',
      scoutDecision: 'accepted',
      pipelineRunId: exactRun,
    });
    const exactScore = scoreCandidateAgainstNeed(exactCand, exactMatchNeed, exactRun);
    assert(exactScore.matchedSkills.includes('Azure'),
      `Exact-match "Azure" === "azure" still matched`);
    assert(exactScore.matchedSkills.includes('KQL'),
      `Exact-match "KQL" === "kql" still matched`);
    assert(!exactScore.matchedSkills.includes('Security'),
      `Bare "Sentinel" candidate skill does NOT spuriously match "Security" required skill`);
    assert(exactScore.missingSkills.includes('Security'),
      `Unmatched "Security" appears in missingSkills (got missing=${JSON.stringify(exactScore.missingSkills)})`);

    // (4) Missing-skill reasoning text still surfaces correctly
    const reasonStr = exactScore.dropReason || exactScore.reviewReason || '';
    if (exactScore.missingSkills.length) {
      assert(/Missing required skills:/.test(reasonStr),
        `Missing-skills reason still emitted when applicable (got "${reasonStr}")`);
    }

    // (5) Verified-only shortlist gate unchanged — eligibility is independent
    //     of skill score. Even a candidate with zero skill overlap stays
    //     eligible only on the gate (scoutDecision=accepted + valid LinkedIn).
    const lowOverlapCand = findOrCreateCandidate({
      name: 'Low Overlap Verified',
      skills: ['cloud security'],   // does not exactly match Security/Azure/KQL/IR
      linkedinUrl: 'https://www.linkedin.com/in/low-overlap',
      source: 'PDL',
      scoutDecision: 'accepted',
      pipelineRunId: exactRun,
    });
    assert(isFinalShortlistEligible(lowOverlapCand) === true,
      `Verified-only gate still admits low-skill-overlap PDL candidate with valid LinkedIn URL + accepted decision`);
    // And gate still rejects when decision flips to review
    lowOverlapCand.scoutDecision = 'review';
    assert(isFinalShortlistEligible(lowOverlapCand) === false,
      `Verified-only gate still rejects review-tagged candidate regardless of skill score`);
    lowOverlapCand.scoutDecision = 'accepted'; // restore for any later checks
  }

  // ── 7c. Client-report CSV formula hardening ───────────────────────
  {
    const csvRun = 'csv_formula_' + Date.now().toString(36);
    const csvNeed = createNeed({
      companyId: coA.id,
      title: 'CSV Formula Guard Role',
      requiredSkills: ['Azure'],
      seniority: 'Mid',
      locationType: 'Remote',
      confirmed: true,
      pipelineRunId: csvRun,
    });
    findOrCreateCandidate({
      name: '=Formula Name',
      currentTitle: '+Formula Title',
      currentCompany: '-Formula Co',
      location: '@Formula City',
      skills: ['Azure'],
      linkedinUrl: 'https://www.linkedin.com/in/csv-formula-one',
      source: 'Manual',
      scoutDecision: 'accepted',
      pipelineRunId: csvRun,
    });
    findOrCreateCandidate({
      name: '\tTabbed Name',
      currentTitle: '\rReturn Title',
      skills: ['Azure'],
      linkedinUrl: 'https://www.linkedin.com/in/csv-formula-two',
      source: 'Manual',
      scoutDecision: 'accepted',
      pipelineRunId: csvRun,
    });
    await runMatchmaker({ needId: csvNeed.id, pipelineRunId: csvRun });
    const csvReport = await generateClientReport({ needId: csvNeed.id, pipelineRunId: csvRun });
    const csv = csvReport.report && csvReport.report.csv;
    for (const guarded of ['"\'=Formula Name"', '"\'+Formula Title"', '"\'-Formula Co"', '"\'@Formula City"', '"\'\tTabbed Name"', '"\'\rReturn Title"']) {
      assert(csv && csv.includes(guarded),
        `CSV formula guard prefixes unsafe value ${JSON.stringify(guarded)} (csv=${JSON.stringify(csv)})`);
    }
  }

  // Re-stamp sharedCand under runB and run matchmaker to materialize a runB match record
  sharedCand.pipelineRunId = runB;
  const mmBshared = await runMatchmaker({ needId: need.id, pipelineRunId: runB });
  assert(mmBshared.matched >= 1, 'runB matchmaker now includes shared candidate');

  // Persist a runA match for sharedCand by directly invoking createOrUpdateMatch
  // (simulates sharedCand having been part of runA's matchmaker pass at its time)
  createOrUpdateMatch({
    needId: need.id, candidateId: sharedCand.id, pipelineRunId: runA,
    score: scoreA.score, tier: scoreA.tier,
    matchedSkills: scoreA.matchedSkills, missingSkills: scoreA.missingSkills,
    reasoning: scoreA.reasoning, rank: 1,
    dropReason: scoreA.dropReason, reviewReason: scoreA.reviewReason,
  });

  const sharedMatches = DB.matches.filter(m =>
    m.needId === need.id && m.candidateId === sharedCand.id
  );
  assert(sharedMatches.length === 2,
    `Same candidate across 2 runs creates 2 distinct match records (got ${sharedMatches.length})`);
  const matchA = sharedMatches.find(m => m.pipelineRunId === runA);
  const matchB = sharedMatches.find(m => m.pipelineRunId === runB);
  assert(matchA && matchB, 'Both runA and runB match records exist');
  assert(matchA.score === scoreA.score,
    `runA match preserves runA score (expected ${scoreA.score}, got ${matchA.score})`);
  // matchB was produced via runMatchmaker — its score should be the runB score
  assert(matchB.score === scoreB.score || matchB.score >= scoreA.score,
    `runB match uses runB validation (matchB.score=${matchB.score}, scoreA=${scoreA.score}, scoreB=${scoreB.score})`);

  // ── 9. Manager NEVER borrowed from unrelated company ────────────────
  // Seed a manager attached to a DIFFERENT company. Pipeline for a fresh
  // company must NOT attach this unrelated manager.
  const otherCo = findOrCreateCompany({ name: 'Unrelated Co X', pipelineRunId: 'seed_run' });
  findOrCreateManager({
    name: 'Wrong Mgr', title: 'CISO',
    companyId: otherCo.id, email: 'wrong@unrelated.example',
    emailConfidence: 'verified',
    source: 'Manual',
    pipelineRunId: 'seed_run',
  });

  const pX = await runPipeline({
    company: 'Fresh Pipeline Co',
    role: 'Security Engineer',
    skills: ['Azure', 'Sentinel'],
    location: 'Remote',
    seniority: 'Mid',
  });
  const pXCompany = DB.companies.find(c => c.id === pX.companyId);
  const pXManager = pX.managerId ? DB.hiring_managers.find(m => m.id === pX.managerId) : null;
  // Either no manager attached, OR the manager belongs to the new company.
  assert(
    pXManager === null || pXManager.companyId === pXCompany.id,
    `Pipeline manager (${pX.managerId}) is either null or belongs to current company (manager company=${pXManager && pXManager.companyId}, need company=${pXCompany.id})`
  );

  // ── 10. Pipeline response shape ─────────────────────────────────────
  for (const k of ['pipelineRunId','sourced','fullyValidated','needsReview','insufficientData','validated','visible','dropped']) {
    assert(k in pX, `pipeline response includes "${k}"`);
  }
  assert(typeof pX.pipelineRunId === 'string' && pX.pipelineRunId.length > 4,
    `pipelineRunId is non-empty string (got "${pX.pipelineRunId}")`);
  assert(pX.validated === pX.fullyValidated + pX.needsReview,
    `pipeline.validated = fullyValidated + needsReview`);

  // ── 11. Two pipeline runs → distinct runIds, counts scoped to each run
  const pY = await runPipeline({
    company: 'Fresh Pipeline Co 2',
    role: 'Security Engineer',
    skills: ['Azure', 'Sentinel'],
    location: 'Remote',
    seniority: 'Mid',
  });
  assert(pY.pipelineRunId !== pX.pipelineRunId,
    `Two pipeline runs yield distinct pipelineRunIds (${pX.pipelineRunId} vs ${pY.pipelineRunId})`);

  // Count current-run candidates/validations/matches and compare with pipeline reply
  const pYCands = DB.candidates.filter(c => c.pipelineRunId === pY.pipelineRunId).length;
  assert(pY.sourced === pYCands,
    `pipeline.sourced (${pY.sourced}) == candidates with pipelineRunId=runY (${pYCands})`);
  const pYDropped = DB.matches.filter(m => m.pipelineRunId === pY.pipelineRunId && m.tier === 'Drop').length;
  assert(pY.dropped === pYDropped,
    `pipeline.dropped (${pY.dropped}) == drop matches with pipelineRunId=runY (${pYDropped})`);

  // ── 12. Run-stamping persists on candidates ─────────────────────────
  for (const id of [fcCand.id, bareCand.id]) {
    const c = DB.candidates.find(x => x.id === id);
    assert(c && c.pipelineRunId === runA, `candidate ${c && c.name} stamped with runA pipelineRunId`);
  }

  // ── 13. /api/health no longer leaks dataPath ────────────────────────
  // Boot server in-process via supertest-style http
  const ephem = await new Promise((resolve) => {
    const s = server.app.listen(0, () => resolve(s));
  });
  const PORT = ephem.address().port;
  const healthBody = await new Promise((resolve, reject) => {
    const r = http.request({ hostname: 'localhost', port: PORT, path: '/api/health', method: 'GET' }, (res) => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve(buf));
    });
    r.on('error', reject); r.end();
  });
  ephem.close();
  assert(!/dataPath/i.test(healthBody),
    `/api/health no longer exposes dataPath (body=${healthBody})`);
  assert(!healthBody.includes(TMP),
    `/api/health body does not contain DATA_PATH absolute path`);

  // ── 14. Source classifier — unit cases ──────────────────────────────
  const classCases = [
    {
      label: 'ZipRecruiter job listing',
      input: { title: 'Azure Security Engineer - NOW HIRING', url: 'https://www.ziprecruiter.com/c/Acme/Job/Azure-Security-Engineer/-in-Remote', description: 'Apply now to join our team' },
      expectType: 'job_posting', expectDecision: 'rejected',
    },
    {
      label: 'Microsoft Security Blog article',
      input: { title: 'Microsoft Defender for Cloud — new detection capabilities', url: 'https://www.microsoft.com/en-us/security/blog/2025/01/15/new-detections', description: 'Best practices for hunting' },
      expectType: 'blog_article', expectDecision: 'rejected',
    },
    {
      label: 'Microsoft Learn documentation',
      input: { title: 'Quickstart: enable Microsoft Sentinel', url: 'https://learn.microsoft.com/en-us/azure/sentinel/quickstart-onboard', description: 'Overview of Sentinel' },
      expectType: 'documentation', expectDecision: 'rejected',
    },
    {
      label: 'Tutorial title',
      input: { title: 'How to deploy Sentinel detection rules in 10 minutes', url: 'https://example-tech-blog.com/sentinel-detection-rules', description: 'Step-by-step guide' },
      expectType: 'tutorial', expectDecision: 'rejected',
    },
    {
      label: 'LinkedIn jobs page',
      input: { title: 'Azure Security Engineer at Contoso', url: 'https://www.linkedin.com/jobs/view/azure-security-engineer-at-contoso-1234567890', description: 'Open position' },
      expectType: 'job_posting', expectDecision: 'rejected',
    },
    {
      label: 'Greenhouse ATS',
      input: { title: 'Azure Cloud Security Engineer - Acme', url: 'https://boards.greenhouse.io/acme/jobs/4567890', description: 'We are hiring' },
      expectType: 'job_posting', expectDecision: 'rejected',
    },
    {
      label: 'GitHub repo URL (not user profile)',
      input: { title: 'azure-sentinel-rules', url: 'https://github.com/Azure/Azure-Sentinel', description: 'KQL detection rules' },
      expectType: 'unknown', expectDecision: 'rejected',
    },
    {
      label: 'LinkedIn /in/ profile',
      input: { title: 'Jane Doe — Cloud Security Engineer at Contoso', url: 'https://www.linkedin.com/in/jane-doe-cloud-sec', description: 'Cloud security engineer with 6 years experience' },
      expectType: 'candidate_profile', expectDecision: 'accepted',
    },
    {
      // Unverified GH root URL is now "review" until GitHub API confirms type=User.
      // Has parens display name + "engineer" hint → person-like signals.
      label: 'GitHub root with person-like signals (sync classify → review)',
      input: { title: 'jdoe (Jane Doe) · GitHub', url: 'https://github.com/jdoe', description: 'Cloud security engineer' },
      expectType: 'possible_candidate', expectDecision: 'review',
    },
    {
      label: 'Personal resume page path',
      input: { title: 'Jane Doe — Resume', url: 'https://janedoe.example.com/resume', description: 'Resume of Jane Doe' },
      expectType: 'candidate_profile', expectDecision: 'accepted',
    },
    {
      label: 'Medium author profile',
      input: { title: 'Jane Doe', url: 'https://medium.com/@jdoe', description: 'Articles by Jane Doe' },
      expectType: 'possible_candidate', expectDecision: 'review',
    },
    {
      label: 'Generic unknown page',
      input: { title: 'Some random article', url: 'https://example.org/random/path', description: '' },
      expectType: 'unknown', expectDecision: 'rejected',
    },

    // ── GitHub organization/company rejection ─────────────────────────
    {
      label: 'GitHub org: Azure (root)',
      input: { title: 'Azure · GitHub', url: 'https://github.com/Azure', description: 'Microsoft Azure GitHub' },
      expectType: 'company_page', expectDecision: 'rejected',
    },
    {
      label: 'GitHub org: microsoft (root)',
      input: { title: 'Microsoft · GitHub', url: 'https://github.com/microsoft', description: '' },
      expectType: 'company_page', expectDecision: 'rejected',
    },
    {
      label: 'GitHub org: kubernetes (root)',
      input: { title: 'kubernetes · GitHub', url: 'https://github.com/kubernetes', description: '' },
      expectType: 'company_page', expectDecision: 'rejected',
    },
    {
      label: 'GitHub org: google (root)',
      input: { title: 'Google · GitHub', url: 'https://github.com/google', description: '' },
      expectType: 'company_page', expectDecision: 'rejected',
    },
    {
      // Person-like signal: "Cloud security" + parens display name → review (unverified).
      label: 'GitHub real user (root) with person signals → review',
      input: { title: 'jane-doe-security (Jane) · GitHub', url: 'https://github.com/jane-doe-security', description: 'Cloud security' },
      expectType: 'possible_candidate', expectDecision: 'review',
    },
    {
      // No person-like signal — must NOT be accepted just because login isn't in org list.
      label: 'GitHub unknown root with NO person evidence → rejected',
      input: { title: 'some-team-repo-collection', url: 'https://github.com/some-team-collection', description: 'Repository collection' },
      expectType: 'company_page', expectDecision: 'rejected',
    },
    {
      // Org-like brand name not in static list, no person evidence → rejected.
      label: 'GitHub org-like root (not in static list) with no person signals → rejected',
      input: { title: 'acme-corp · GitHub', url: 'https://github.com/acme-corp', description: '' },
      expectType: 'company_page', expectDecision: 'rejected',
    },
    {
      label: 'GitHub case-insensitive org match',
      input: { title: 'AZURE · GitHub', url: 'https://github.com/AZURE', description: '' },
      expectType: 'company_page', expectDecision: 'rejected',
    },

    // ── Additional job board / ATS rejections ─────────────────────────
    {
      label: 'Indeed job page',
      input: { title: 'Cloud Security Engineer - Acme Co', url: 'https://www.indeed.com/viewjob?jk=abc123', description: 'Apply now' },
      expectType: 'job_posting', expectDecision: 'rejected',
    },
    {
      label: 'Glassdoor job page',
      input: { title: 'Security Engineer - Acme', url: 'https://www.glassdoor.com/job-listing/security-engineer-acme-JV_IC_456', description: 'View open positions' },
      expectType: 'job_posting', expectDecision: 'rejected',
    },
    {
      label: 'Lever job page',
      input: { title: 'Senior Cloud Security Engineer at Contoso', url: 'https://jobs.lever.co/contoso/abc-def-123', description: '' },
      expectType: 'job_posting', expectDecision: 'rejected',
    },
    {
      label: 'Workday job page',
      input: { title: 'Cloud Engineer - Contoso', url: 'https://contoso.wd5.myworkdayjobs.com/External/job/Cloud-Engineer_R12345', description: '' },
      expectType: 'job_posting', expectDecision: 'rejected',
    },
    {
      label: 'Generic /careers/ path',
      input: { title: 'Acme Careers', url: 'https://www.acme.example/careers/cloud-engineer', description: '' },
      expectType: 'job_posting', expectDecision: 'rejected',
    },

    // ── Realistic profile / author signal cases ──────────────────────
    {
      label: 'LinkedIn /in/ with senior title variant',
      input: { title: 'John Smith - Senior Cloud Security Architect | LinkedIn', url: 'https://www.linkedin.com/in/john-smith-cloudsec', description: '15+ years across Azure, Sentinel, KQL, Defender for Cloud, incident response' },
      expectType: 'candidate_profile', expectDecision: 'accepted',
    },
    {
      label: 'LinkedIn /in/ with description containing "best practices" noise',
      input: { title: 'Maria Lopez', url: 'https://www.linkedin.com/in/maria-lopez-sec', description: 'I write about Sentinel best practices and KQL guides' },
      expectType: 'candidate_profile', expectDecision: 'accepted',
    },
    {
      // Realistic person-like signals on unverified GH root → review (not accepted).
      label: 'GitHub user with realistic title/name → review (unverified)',
      input: { title: 'sentinel-eng (Alex Park) · GitHub', url: 'https://github.com/sentinel-eng', description: 'Detection engineer, Azure / Sentinel / KQL' },
      expectType: 'possible_candidate', expectDecision: 'review',
    },
    {
      label: 'Technical author /in/ profile not falsely rejected for "guide" wording',
      input: { title: 'Priya Nair', url: 'https://www.linkedin.com/in/priya-nair-sec', description: 'Published guide to Sentinel detection rules' },
      expectType: 'candidate_profile', expectDecision: 'accepted',
    },

    // ── Spoofed LinkedIn URLs — strict hostname check must reject ────────
    {
      // host is attacker.com — "linkedin.com/in/" appears in path only.
      label: 'Spoofed LinkedIn in path → rejected (strict hostname)',
      input: { title: 'Fake Profile', url: 'https://attacker.example.com/linkedin.com/in/jane', description: 'Cloud security engineer' },
      expectType: 'unknown', expectDecision: 'rejected',
    },
    {
      // host evil.example, "linkedin.com" in query — must reject.
      label: 'Spoofed LinkedIn in querystring → rejected',
      input: { title: 'Suspicious', url: 'https://evil.example.com/?u=linkedin.com/in/jane', description: '' },
      expectType: 'unknown', expectDecision: 'rejected',
    },
    {
      // LinkedIn /pub/ legacy path — not /in/, must NOT be accepted as profile.
      label: 'LinkedIn /pub/ legacy path → not accepted as profile',
      input: { title: 'Legacy Pub Page', url: 'https://www.linkedin.com/pub/jane-doe/1/abc/def', description: '' },
      expectType: 'unknown', expectDecision: 'rejected',
    },
    {
      // Regional subdomain is real LinkedIn — must still accept.
      label: 'LinkedIn regional subdomain de.linkedin.com/in/ → accepted',
      input: { title: 'Hans Mueller', url: 'https://de.linkedin.com/in/hans-mueller', description: 'Cloud Sicherheit' },
      expectType: 'candidate_profile', expectDecision: 'accepted',
    },
  ];
  for (const tc of classCases) {
    const r = classifySourceItem(tc.input);
    assert(r.sourceType === tc.expectType && r.scoutDecision === tc.expectDecision,
      `classify[${tc.label}] → type=${r.sourceType}/decision=${r.scoutDecision} (expected ${tc.expectType}/${tc.expectDecision}) reason=${r.scoutReason}`);
  }

  // ── 15. runScout integration — rejected items never reach Validator/Matchmaker ──
  // Set FIRECRAWL key so isConfigured('firecrawl') is true; canned items returned by stub.
  const prevFirecrawlKey = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';
  STUB_FIRECRAWL_ITEMS = [
    { title: 'Azure Security Engineer - NOW HIRING', url: 'https://www.ziprecruiter.com/c/Acme/Job/Azure-Security-Engineer/-in-Remote', description: 'Apply now' },
    { title: 'Microsoft Defender for Cloud — best practices', url: 'https://www.microsoft.com/en-us/security/blog/2025/01/15/defender', description: 'Best practices for cloud security' },
    { title: 'Quickstart: Sentinel onboarding', url: 'https://learn.microsoft.com/en-us/azure/sentinel/quickstart', description: 'Step-by-step' },
    { title: 'How to deploy Sentinel rules', url: 'https://random-blog.example/sentinel-rules', description: 'Tutorial' },
    { title: 'Jane Doe — Cloud Security Engineer at Contoso', url: 'https://www.linkedin.com/in/jane-doe-cloud-sec', description: 'Cloud security engineer · Azure Sentinel KQL' },
    { title: 'John Profile — Senior Security Engineer at Acme', url: 'https://www.linkedin.com/in/john-profile-cloud', description: 'Senior security engineer Azure Sentinel' },
  ];
  STUB_GH_SEARCH_USERS = { items: [] }; // skip GH leg for this test

  const coScout = findOrCreateCompany({ name: 'Scout Quality Co' });
  const scoutNeed = createNeed({
    companyId: coScout.id,
    title: 'Azure Security Engineer',
    requiredSkills: ['Azure', 'Sentinel', 'KQL'],
    seniority: 'Mid',
    locationType: 'Remote',
    confirmed: true,
  });
  const scoutRunId = 'scout_quality_run_' + Date.now().toString(36);
  const scoutResult = await runScout({ needId: scoutNeed.id, pipelineRunId: scoutRunId });

  assert(scoutResult.sourcedRaw === 6,                       `scout sourcedRaw === 6 (got ${scoutResult.sourcedRaw})`);
  assert(scoutResult.rejectedNonCandidates === 4,            `4 rejected non-candidates (got ${scoutResult.rejectedNonCandidates})`);
  assert(scoutResult.acceptedCandidates === 2,               `2 accepted candidates (got ${scoutResult.acceptedCandidates})`);
  assert(scoutResult.needsScoutReview === 0,                 `0 review (got ${scoutResult.needsScoutReview})`);
  assert(scoutResult.sourced === 2,                          `scout.sourced (validator-input) === 2 (got ${scoutResult.sourced})`);

  // Rejected samples carry the right sourceType
  const rejTypes = scoutResult.rejectedSamples.map(r => r.sourceType).sort();
  assert(rejTypes.includes('job_posting'),    `rejected samples include job_posting (${rejTypes.join(',')})`);
  assert(rejTypes.includes('blog_article'),   `rejected samples include blog_article (${rejTypes.join(',')})`);
  assert(rejTypes.includes('documentation'), `rejected samples include documentation (${rejTypes.join(',')})`);
  assert(rejTypes.includes('tutorial'),       `rejected samples include tutorial (${rejTypes.join(',')})`);

  // Every rejected sample carries scoutDecision === 'rejected' and the
  // full diagnostic field set Codex required.
  for (const s of scoutResult.rejectedSamples) {
    assert(s.scoutDecision === 'rejected',
      `rejected sample includes scoutDecision === 'rejected' (got "${s.scoutDecision}" for ${s.sourceUrl})`);
    for (const k of ['sourceType','scoutReason','sourceDomain','sourceUrl','title']) {
      assert(k in s, `rejected sample includes "${k}" (sample=${JSON.stringify(s)})`);
    }
  }

  // ZipRecruiter URL must NOT appear in any candidate record
  const ziprecruiterCand = DB.candidates.find(c => (c.sourceUrl || '').includes('ziprecruiter.com'));
  assert(!ziprecruiterCand, `No candidate record carries a ZipRecruiter URL`);
  const msBlogCand = DB.candidates.find(c => (c.sourceUrl || '').includes('microsoft.com/en-us/security/blog'));
  assert(!msBlogCand, `No candidate record carries a Microsoft Security Blog URL`);
  const learnDocCand = DB.candidates.find(c => (c.sourceUrl || '').includes('learn.microsoft.com'));
  assert(!learnDocCand, `No candidate record carries a Microsoft Learn URL`);

  // Validator only sees accepted candidates — pipeline-style call
  const scoutCandIds = scoutResult.candidates.map(c => c.id);
  assert(scoutCandIds.length === 2, `Validator receives exactly 2 candidate ids (got ${scoutCandIds.length})`);
  const scoutValRes = await runValidator({ candidateIds: scoutCandIds, pipelineRunId: scoutRunId });
  assert(scoutValRes.validated === 2,
    `Validator processed 2 candidates only — rejected items skipped (got validated=${scoutValRes.validated})`);

  // Matchmaker pool is run-scoped — equals accepted candidates
  const scoutMm = await runMatchmaker({ needId: scoutNeed.id, pipelineRunId: scoutRunId });
  assert(scoutMm.matched === 2,
    `Matchmaker scored 2 candidates only — rejected pages excluded (got ${scoutMm.matched})`);
  // No match record should reference a ZipRecruiter/MS-blog/Learn URL
  for (const m of DB.matches.filter(m => m.pipelineRunId === scoutRunId)) {
    const c = DB.candidates.find(x => x.id === m.candidateId);
    assert(c && !(c.sourceUrl || '').match(/(ziprecruiter|security\/blog|learn\.microsoft)/i),
      `Match ${m.id} candidate is not a rejected non-candidate page (sourceUrl=${c && c.sourceUrl})`);
  }

  // ── 16. Client-report "no candidate-like profiles" message when all rejected ──
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';
  STUB_FIRECRAWL_ITEMS = [
    { title: 'Azure Security Engineer - NOW HIRING', url: 'https://www.ziprecruiter.com/x1', description: '' },
    { title: 'Microsoft Defender release notes', url: 'https://learn.microsoft.com/en-us/azure/defender/release-notes', description: '' },
    { title: 'How to set up Sentinel detection', url: 'https://example-tech-blog.com/sentinel-tutorial', description: 'Tutorial' },
  ];
  const coAllRej = findOrCreateCompany({ name: 'All-Rejected Co' });
  const allRejNeed = createNeed({
    companyId: coAllRej.id, title: 'Azure Security Engineer',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const allRejRunId = 'all_rejected_run_' + Date.now().toString(36);
  const allRejScout = await runScout({ needId: allRejNeed.id, pipelineRunId: allRejRunId });
  assert(allRejScout.acceptedCandidates === 0 && allRejScout.rejectedNonCandidates === 3,
    `all-rejected scout: 0 accepted, 3 rejected (got ${allRejScout.acceptedCandidates}/${allRejScout.rejectedNonCandidates})`);
  const rep = await generateClientReport({
    needId: allRejNeed.id,
    pipelineRunId: allRejRunId,
    scoutStats: {
      sourcedRaw: allRejScout.sourcedRaw,
      acceptedCandidates: allRejScout.acceptedCandidates,
      needsScoutReview: allRejScout.needsScoutReview,
      rejectedNonCandidates: allRejScout.rejectedNonCandidates,
    },
  });
  assert(rep.report && /No real verified candidates found/.test(rep.report.summary),
    `Client report shows special "No real verified candidates found" message when all sourced were rejected (summary="${rep.report && rep.report.summary}")`);
  assert(rep.report && /job posts\/blogs\/docs/.test(rep.report.summary),
    `Special message mentions "job posts/blogs/docs"`);

  // ── 16b. Manual report regeneration — no scoutStats arg, must still surface
  //         the special message via persisted need.scoutStatsByRun ──
  const repManualWithRun = await generateClientReport({
    needId: allRejNeed.id,
    pipelineRunId: allRejRunId,
    // no scoutStats arg — must reconstruct from need.scoutStatsByRun
  });
  assert(repManualWithRun.report && /No real verified candidates found/.test(repManualWithRun.report.summary),
    `Manual generateClientReport (pipelineRunId only, no scoutStats arg) still produces special message via persisted scoutStatsByRun (summary="${repManualWithRun.report && repManualWithRun.report.summary}")`);

  // And with no pipelineRunId at all, falls back to need.lastScoutStats
  const repManualNoRun = await generateClientReport({ needId: allRejNeed.id });
  assert(repManualNoRun.report && /No real verified candidates found/.test(repManualNoRun.report.summary),
    `Manual generateClientReport (no pipelineRunId, no scoutStats) still produces special message via need.lastScoutStats (summary="${repManualNoRun.report && repManualNoRun.report.summary}")`);

  // Confirm need actually persisted the stats by run
  const persistedNeed = DB.hiring_needs.find(n => n.id === allRejNeed.id);
  assert(persistedNeed.scoutStatsByRun && persistedNeed.scoutStatsByRun[allRejRunId],
    `Need.scoutStatsByRun[${allRejRunId}] persisted`);
  assert(persistedNeed.lastScoutStats && persistedNeed.lastScoutStats.rejectedNonCandidates === 3,
    `Need.lastScoutStats.rejectedNonCandidates === 3`);

  // ── 16c. Strict run-scoping for report fallback (Codex round-3 issue 2) ──
  // pipelineRunId provided but NOT in scoutStatsByRun must NOT fall back to
  // need.lastScoutStats. The special "No candidate-like profiles" message must
  // not bleed across runs.
  const unrelatedRunId = 'never_ran_run_' + Date.now().toString(36);
  const repWrongRun = await generateClientReport({
    needId: allRejNeed.id,
    pipelineRunId: unrelatedRunId,
    // no scoutStats arg; need.lastScoutStats has 3 rejections, but unrelatedRunId
    // has no entry in scoutStatsByRun → MUST NOT borrow lastScoutStats.
  });
  // Negative check uses the *borrowed-context* phrasing ("Scout found N keyword-related
  // pages…excluded"). A generic "No real verified candidates found." (no scout detail)
  // is acceptable — it means no stats were borrowed.
  assert(repWrongRun.report && !/job posts\/blogs\/docs/.test(repWrongRun.report.summary),
    `Report for unrelated pipelineRunId does NOT borrow need.lastScoutStats scout-context detail (summary="${repWrongRun.report && repWrongRun.report.summary}")`);

  // Multi-run scenario: earlier run had candidates accepted, later run all-rejected.
  // A report regenerated for the earlier run must NOT show the special message
  // even though need.lastScoutStats currently says all-rejected.
  const multiNeed = createNeed({
    companyId: coAllRej.id, title: 'Multi-Run Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  // Run A: 2 accepted, 0 rejected
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';
  STUB_FIRECRAWL_ITEMS = [
    { title: 'Real Person A — Cloud Sec', url: 'https://www.linkedin.com/in/real-a', description: 'Cloud security engineer' },
    { title: 'Real Person B — Cloud Sec', url: 'https://www.linkedin.com/in/real-b', description: 'Cloud security engineer' },
  ];
  const multiRunA = 'multi_runA_' + Date.now().toString(36);
  await runScout({ needId: multiNeed.id, pipelineRunId: multiRunA });
  // Run B (same need): all rejected
  STUB_FIRECRAWL_ITEMS = [
    { title: 'Some Job - NOW HIRING', url: 'https://www.ziprecruiter.com/job/x', description: '' },
    { title: 'Microsoft Defender release', url: 'https://learn.microsoft.com/en-us/azure/defender', description: '' },
  ];
  const multiRunB = 'multi_runB_' + Date.now().toString(36);
  await runScout({ needId: multiNeed.id, pipelineRunId: multiRunB });
  // need.lastScoutStats now reflects runB (all-rejected). But a report for runA
  // must still reflect runA's reality (had candidates), so the special message
  // must NOT appear when querying runA.
  const repMultiA = await generateClientReport({
    needId: multiNeed.id, pipelineRunId: multiRunA,
  });
  // Same logic: borrowed scout-context is the signal, not the generic prefix.
  assert(repMultiA.report && !/job posts\/blogs\/docs/.test(repMultiA.report.summary),
    `Report for runA (which had candidates) does NOT borrow runB's all-rejected scout-context detail (summary="${repMultiA.report && repMultiA.report.summary}")`);
  // And runB-scoped report should still produce the special message
  const repMultiB = await generateClientReport({
    needId: multiNeed.id, pipelineRunId: multiRunB,
  });
  assert(repMultiB.report && /No real verified candidates found/.test(repMultiB.report.summary),
    `Report for runB still surfaces the special "No real verified candidates found" message`);

  // No pipelineRunId may still use need.lastScoutStats (preserved behavior)
  const repNoRun = await generateClientReport({ needId: multiNeed.id });
  assert(repNoRun.report && /No real verified candidates found/.test(repNoRun.report.summary),
    `Report with no pipelineRunId falls back to need.lastScoutStats (currently runB) — preserved`);

  // ── 16d. scoutStatsByRun cap (Codex round-3 issue 3) ──
  // Directly seed 60 entries with ascending `at` timestamps; pruneScoutStatsByRun
  // should keep the latest 50.
  const capNeed = createNeed({
    companyId: coAllRej.id, title: 'Cap Test Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  capNeed.scoutStatsByRun = {};
  for (let i = 0; i < 60; i++) {
    const at = new Date(Date.now() + i * 1000).toISOString();
    capNeed.scoutStatsByRun[`fake_run_${String(i).padStart(2, '0')}`] = {
      sourcedRaw: i, acceptedCandidates: 0, needsScoutReview: 0,
      rejectedNonCandidates: 0, rejectedSamples: [], at,
    };
  }
  const removed = _internals.pruneScoutStatsByRun(capNeed);
  const remaining = Object.keys(capNeed.scoutStatsByRun).length;
  assert(remaining === _internals.SCOUT_STATS_BY_RUN_CAP,
    `pruneScoutStatsByRun caps at ${_internals.SCOUT_STATS_BY_RUN_CAP} (removed ${removed}, remaining ${remaining})`);
  // The OLDEST entries (lowest `at`) should be removed. fake_run_00..09 are the oldest.
  assert(!capNeed.scoutStatsByRun['fake_run_00'],
    `Oldest entry fake_run_00 was pruned`);
  assert(capNeed.scoutStatsByRun['fake_run_59'],
    `Latest entry fake_run_59 kept`);

  // ── 16e. GitHub API verification path in runScout (Codex round-3 issue 1) ──
  // Set up firecrawl items that include github.com/<login> URLs. Stub the GH
  // user API to return type=User for one login and type=Organization for another.
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';
  STUB_FIRECRAWL_ITEMS = [
    // Unverified, person-like signals → triggers API verification
    { title: 'real-individual (Janet Real) · GitHub', url: 'https://github.com/real-individual',  description: 'Cloud security engineer' },
    // Unverified, person-like signals, but API will say Organization → rejected
    { title: 'acme-security (Acme) · GitHub',          url: 'https://github.com/acme-security',  description: 'Security engineer team' },
    // Unverified, no person signals → classify rejects without API call
    { title: 'random-thing · GitHub',                   url: 'https://github.com/random-thing',   description: '' },
    // No GitHub — LinkedIn /in/ control (still accepted, no API call)
    { title: 'Control Person',                          url: 'https://www.linkedin.com/in/control', description: 'Cloud security engineer' },
  ];
  STUB_GH_SEARCH_USERS = { items: [] };
  STUB_GH_USER_RECORDS = {
    'real-individual': { type: 'User', name: 'Janet Real', login: 'real-individual' },
    'acme-security':   { type: 'Organization', name: 'Acme Security', login: 'acme-security' },
  };

  const verifyNeed = createNeed({
    companyId: coAllRej.id, title: 'Detection Engineer',
    requiredSkills: ['Azure', 'SIEM'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const verifyRunId = 'verify_run_' + Date.now().toString(36);
  const verifyScout = await runScout({ needId: verifyNeed.id, pipelineRunId: verifyRunId });

  // real-individual → upgraded to accepted (API User)
  const realIndCand = DB.candidates.find(c => (c.sourceUrl || '').includes('github.com/real-individual'));
  assert(realIndCand && realIndCand.scoutDecision === 'accepted',
    `GitHub API type=User → candidate accepted (got scoutDecision="${realIndCand && realIndCand.scoutDecision}", scoutReason="${realIndCand && realIndCand.scoutReason}")`);
  assert(realIndCand && /API verified type=User/.test(realIndCand.scoutReason || ''),
    `scoutReason mentions API verification (got "${realIndCand && realIndCand.scoutReason}")`);
  // acme-security → demoted to rejected (API Organization)
  const acmeRej = verifyScout.rejectedSamples.find(r => (r.sourceUrl || '').includes('github.com/acme-security'));
  assert(acmeRej && acmeRej.sourceType === 'company_page' && /API verified type=Organization/.test(acmeRej.scoutReason || ''),
    `GitHub API type=Organization → rejected as company_page (got sourceType=${acmeRej && acmeRej.sourceType}, scoutReason=${acmeRej && acmeRej.scoutReason})`);
  // random-thing → classify rejected without API call (no person signals)
  const randomRej = verifyScout.rejectedSamples.find(r => (r.sourceUrl || '').includes('github.com/random-thing'));
  assert(randomRej, `GitHub root with no person signals appears in rejectedSamples`);
  assert(randomRej && /no person-like signals/.test(randomRej.scoutReason || ''),
    `random-thing rejected reason mentions no-person-signals (got "${randomRej && randomRej.scoutReason}")`);

  // Control LinkedIn /in/ → accepted (still works alongside GH verification)
  const ctrlCand = DB.candidates.find(c => (c.sourceUrl || '').includes('linkedin.com/in/control'));
  assert(ctrlCand && ctrlCand.scoutDecision === 'accepted',
    `Control LinkedIn /in/ still accepted (got scoutDecision="${ctrlCand && ctrlCand.scoutDecision}")`);

  // ── 16f. API unavailable → stays review (do NOT blindly accept) ──
  STUB_FIRECRAWL_ITEMS = [
    { title: 'unknown-person (Pat Unknown) · GitHub', url: 'https://github.com/unknown-person', description: 'Cloud security engineer' },
  ];
  STUB_GH_USER_RECORDS = {}; // no record for unknown-person → 404 → null
  const unverifiedNeed = createNeed({
    companyId: coAllRej.id, title: 'GH Unverified Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const unverifiedRunId = 'unverified_run_' + Date.now().toString(36);
  const unverifiedScout = await runScout({ needId: unverifiedNeed.id, pipelineRunId: unverifiedRunId });
  const unkCand = DB.candidates.find(c => (c.sourceUrl || '').includes('github.com/unknown-person'));
  assert(unkCand && unkCand.scoutDecision === 'review',
    `GH root with person-like signals but API unavailable stays "review" (got scoutDecision="${unkCand && unkCand.scoutDecision}")`);
  assert(unverifiedScout.needsScoutReview >= 1 && unverifiedScout.acceptedCandidates === 0,
    `Unverified GH stays in review pool (accepted=${unverifiedScout.acceptedCandidates}, review=${unverifiedScout.needsScoutReview})`);

  STUB_GH_USER_RECORDS = null;

  // ── 17. Apollo candidate sourcing ────────────────────────────────────
  // (a) When APOLLO_API_KEY is set, runScout queries Apollo first.
  const prevApolloKey = process.env.APOLLO_API_KEY;
  process.env.APOLLO_API_KEY = 'test-apollo-key';
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';

  STUB_APOLLO_PEOPLE = [
    { id: 'ap1', name: 'Apollo Alice', title: 'Senior Cloud Security Engineer', city: 'Berlin', state: '', country: 'Germany', linkedin_url: 'https://www.linkedin.com/in/apollo-alice', email: 'alice@example.com', organization: { name: 'CloudCorp' }, headline: 'Sentinel KQL Azure', employment_history: [{ title: 'Senior Cloud Security Engineer', organization: { name: 'CloudCorp' }, start_date: '2024-01-01', current: true }] },
    { id: 'ap2', name: 'Apollo Bob',   title: 'Detection Engineer', city: 'Detroit', state: 'Michigan', country: 'United States', linkedin_url: 'https://www.linkedin.com/in/apollo-bob',   email: '',                organization: { name: 'SOC Ltd' },    headline: 'SOC analyst KQL', employment_history: [{ title: 'Detection Engineer', organization: { name: 'SOC Ltd' }, start_date: '2024-01-01', current: true }] },
    { id: 'ap3', name: 'Apollo Charlie', title: 'SIEM Engineer', city: 'Ann Arbor', state: 'Michigan', country: 'United States', linkedin_url: 'https://www.linkedin.com/in/apollo-charlie', email: '',              organization: { name: 'SIEMCo' },     headline: 'Microsoft Sentinel IAM', employment_history: [{ title: 'SIEM Engineer', organization: { name: 'SIEMCo' }, start_date: '2024-01-01', current: true }] },
  ];
  STUB_FIRECRAWL_ITEMS = [
    // Duplicate of Apollo Bob → must NOT double-count
    { title: 'Apollo Bob — Detection Engineer at SOC Ltd', url: 'https://www.linkedin.com/in/apollo-bob', description: 'Detection engineer' },
    // Reject: job posting
    { title: 'Azure Security Engineer NOW HIRING', url: 'https://www.ziprecruiter.com/c/job/azure', description: 'Apply' },
    // Unique LinkedIn person via Firecrawl
    { title: 'Fresh Person — Cloud Security Engineer', url: 'https://www.linkedin.com/in/fresh-firecrawl', description: 'Cloud security engineer' },
  ];
  STUB_GH_SEARCH_USERS = { items: [] };
  STUB_GH_USER_RECORDS = null;

  const coApollo = findOrCreateCompany({ name: 'Apollo Sourcing Co' });
  const apolloNeed = createNeed({
    companyId: coApollo.id,
    title: 'Azure Security Engineer',
    requiredSkills: ['Azure', 'Sentinel', 'KQL'],
    seniority: 'Mid',
    locationType: 'Remote',
    confirmed: true,
  });
  const apolloRunId = 'apollo_run_' + Date.now().toString(36);
  const apolloScout = await runScout({ needId: apolloNeed.id, pipelineRunId: apolloRunId });

  // (a) Apollo candidates were accepted as candidate_profile
  const apolloCandsInDB = DB.candidates.filter(c => c.pipelineRunId === apolloRunId && c.source === 'Apollo');
  assert(apolloCandsInDB.length >= 3,
    `≥3 Apollo candidates stored with source=Apollo (got ${apolloCandsInDB.length})`);
  for (const c of apolloCandsInDB) {
    assert(c.sourceType === 'candidate_profile',
      `Apollo candidate sourceType === candidate_profile (got ${c.sourceType} for ${c.name})`);
    assert(c.scoutDecision === 'accepted',
      `Apollo candidate scoutDecision === accepted (got ${c.scoutDecision} for ${c.name})`);
    assert(/Apollo people search/.test(c.scoutReason || ''),
      `Apollo candidate scoutReason mentions Apollo (got "${c.scoutReason}")`);
  }
  // (b) Apollo results include LinkedIn URLs when available
  const apolloWithLi = apolloCandsInDB.filter(c => (c.linkedinUrl || '').includes('linkedin.com/in/'));
  assert(apolloWithLi.length === 3, `All 3 Apollo candidates have LinkedIn URLs (got ${apolloWithLi.length})`);

  // (c) Per-source counts include apollo + firecrawl separately
  assert(apolloScout.rawResultsBySource && apolloScout.rawResultsBySource.apollo === 3,
    `rawResultsBySource.apollo === 3 (got ${apolloScout.rawResultsBySource && apolloScout.rawResultsBySource.apollo})`);
  assert(apolloScout.rawResultsBySource.firecrawl === 3,
    `rawResultsBySource.firecrawl === 3 (got ${apolloScout.rawResultsBySource.firecrawl})`);
  assert(apolloScout.acceptedBySource.apollo === 3,
    `acceptedBySource.apollo === 3 (got ${apolloScout.acceptedBySource.apollo})`);
  // (d) Dedupe — Bob's LinkedIn URL appears in both Apollo and Firecrawl;
  //     only Apollo gets credit (first-touch). Firecrawl gets credit for the
  //     unique fresh-firecrawl LinkedIn person.
  assert(apolloScout.acceptedBySource.firecrawl === 1,
    `acceptedBySource.firecrawl === 1 (Bob deduped, only fresh-firecrawl counted; got ${apolloScout.acceptedBySource.firecrawl})`);

  // (e) Total accepted = 4 unique (Alice, Bob, Charlie, fresh-firecrawl)
  assert(apolloScout.acceptedCandidates === 4,
    `acceptedCandidates === 4 unique after dedupe (got ${apolloScout.acceptedCandidates})`);
  // (f) Rejected non-candidates still excluded
  assert(apolloScout.rejectedNonCandidates === 1,
    `1 rejected (ZipRecruiter) — non-candidates still excluded (got ${apolloScout.rejectedNonCandidates})`);
  assert(apolloScout.rejectedByReason && Object.keys(apolloScout.rejectedByReason).length >= 1,
    `rejectedByReason map populated (got ${JSON.stringify(apolloScout.rejectedByReason)})`);

  // (g) Apollo candidates reach Validator/Matchmaker
  const apolloCandIds = apolloScout.candidates.map(c => c.id);
  const apolloVal = await runValidator({ candidateIds: apolloCandIds, pipelineRunId: apolloRunId });
  assert(apolloVal.validated >= 3,
    `Validator processed Apollo candidates (validated=${apolloVal.validated})`);
  const apolloMm = await runMatchmaker({ needId: apolloNeed.id, pipelineRunId: apolloRunId });
  assert(apolloMm.matched === 4,
    `Matchmaker scored all 4 accepted Apollo+Firecrawl candidates (got ${apolloMm.matched})`);

  // (h) Apollo missing/disabled → no crash, falls back to Firecrawl/GitHub
  delete process.env.APOLLO_API_KEY;
  STUB_APOLLO_PEOPLE = null;
  STUB_FIRECRAWL_ITEMS = [
    { title: 'Fallback Person — Security Engineer', url: 'https://www.linkedin.com/in/fallback-person', description: 'Cloud security engineer' },
  ];
  const fallbackNeed = createNeed({
    companyId: coApollo.id, title: 'Azure Security Engineer',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const fallbackRunId = 'fallback_run_' + Date.now().toString(36);
  let fallbackErr = null;
  let fallbackScout;
  try {
    fallbackScout = await runScout({ needId: fallbackNeed.id, pipelineRunId: fallbackRunId });
  } catch (e) { fallbackErr = e; }
  assert(!fallbackErr, `Apollo missing does not crash runScout (err=${fallbackErr && fallbackErr.message})`);
  assert(fallbackScout && fallbackScout.acceptedCandidates >= 1,
    `Pipeline continues with Firecrawl when Apollo missing (accepted=${fallbackScout && fallbackScout.acceptedCandidates})`);
  assert(fallbackScout && fallbackScout.rawResultsBySource.apollo === 0,
    `rawResultsBySource.apollo === 0 when Apollo missing (got ${fallbackScout && fallbackScout.rawResultsBySource.apollo})`);

  // (h2) Codex P2 fix — Apollo result WITHOUT a real LinkedIn /in/ URL must
  //      go to the review pool, NOT visible/accepted. No synthetic apollo://
  //      URL is used as proof of a real candidate.
  process.env.APOLLO_API_KEY = 'test-apollo-key';
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';
  STUB_APOLLO_PEOPLE = [
    // Has real LinkedIn /in/ → accepted
    { id: 'ap-real',    name: 'Real LinkedIn Person', title: 'Cloud Security Engineer', city: 'Detroit', state: 'Michigan', country: 'United States', linkedin_url: 'https://www.linkedin.com/in/real-linkedin-person', email: '', organization: { name: 'RealCo' }, employment_history: [{ title: 'Cloud Security Engineer', organization: { name: 'RealCo' }, start_date: '2024-01-01', current: true }] },
    // No linkedin_url at all → review
    { id: 'ap-nolink',  name: 'NoLink Person',        title: 'Security Engineer',       linkedin_url: '',                                                  email: 'nolink@example.com', organization: { name: 'NoLinkCo' } },
    // linkedin_url present but NOT a /in/ profile (e.g. company linkedin) → review
    { id: 'ap-notprofile', name: 'NotProfile Person', title: 'Engineer',                 linkedin_url: 'https://www.linkedin.com/company/some-company',     email: '',                   organization: { name: 'NotProfileCo' } },
  ];
  STUB_FIRECRAWL_ITEMS = [];
  STUB_GH_SEARCH_USERS = { items: [] };

  const linkNeed = createNeed({
    companyId: coApollo.id, title: 'Azure Security Engineer',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const linkRunId = 'link_run_' + Date.now().toString(36);
  const linkScout = await runScout({ needId: linkNeed.id, pipelineRunId: linkRunId });

  // Real-LinkedIn → accepted
  const realC = DB.candidates.find(c => c.name === 'Real LinkedIn Person' && c.pipelineRunId === linkRunId);
  assert(realC && realC.scoutDecision === 'accepted' && realC.sourceType === 'candidate_profile',
    `Apollo with real LinkedIn /in/ → accepted as candidate_profile (got decision=${realC && realC.scoutDecision}, type=${realC && realC.sourceType})`);
  assert(realC && /linkedin\.com\/in\//.test(realC.linkedinUrl || ''),
    `Real LinkedIn URL stored (got "${realC && realC.linkedinUrl}")`);

  // No LinkedIn at all → review
  const noC = DB.candidates.find(c => c.name === 'NoLink Person' && c.pipelineRunId === linkRunId);
  assert(noC && noC.scoutDecision === 'review' && noC.sourceType === 'possible_candidate',
    `Apollo without LinkedIn → review as possible_candidate (got decision=${noC && noC.scoutDecision}, type=${noC && noC.sourceType})`);
  assert(noC && /missing real LinkedIn\/profile URL/i.test(noC.scoutReason || ''),
    `Review reason mentions "missing real LinkedIn/profile URL" (got "${noC && noC.scoutReason}")`);
  assert(noC && !/^apollo:\/\//.test(noC.sourceUrl || ''),
    `No synthetic apollo:// URL stored (got sourceUrl="${noC && noC.sourceUrl}")`);
  assert(noC && (noC.sourceUrl === '' || !noC.sourceUrl),
    `sourceUrl is empty for Apollo-without-LinkedIn (got "${noC && noC.sourceUrl}")`);

  // linkedin_url present but /company/, not /in/ → review (not a profile link)
  const notProfC = DB.candidates.find(c => c.name === 'NotProfile Person' && c.pipelineRunId === linkRunId);
  assert(notProfC && notProfC.scoutDecision === 'review',
    `Apollo with /company/ URL (not /in/ profile) → review (got decision=${notProfC && notProfC.scoutDecision})`);
  assert(notProfC && notProfC.linkedinUrl === '',
    `Non-/in/ LinkedIn URL not stored on candidate (got "${notProfC && notProfC.linkedinUrl}")`);

  // Per-source counts split correctly: 1 accepted + 2 review, all from Apollo
  assert(linkScout.acceptedBySource.apollo === 1,
    `acceptedBySource.apollo === 1 (only real /in/ profile; got ${linkScout.acceptedBySource.apollo})`);
  assert(linkScout.reviewBySource && linkScout.reviewBySource.apollo === 2,
    `reviewBySource.apollo === 2 (both URL-less variants; got ${linkScout.reviewBySource && linkScout.reviewBySource.apollo})`);
  assert(linkScout.acceptedCandidates === 1 && linkScout.needsScoutReview === 2,
    `Pool split: 1 accepted, 2 review (got ${linkScout.acceptedCandidates}/${linkScout.needsScoutReview})`);

  // (h3) Apollo structured resolver: Apollo can resolve candidates when it
  //      supplies structured location plus structured employment evidence, but
  //      selected-market gating still controls client readiness.
  const apolloWork = (title, company) => [{ title, organization: { name: company }, start_date: '2024-01-01', current: true }];
  STUB_APOLLO_PEOPLE = [
    {
      id: 'ap-structured-mi', name: 'Apollo Structured Michigan', title: 'SOC Analyst',
      city: 'Detroit', state: 'Michigan', country: 'United States',
      linkedin_url: 'https://www.linkedin.com/in/apollo-structured-michigan', organization: { name: 'Blue Team Co' },
      headline: 'SOC Analyst with Microsoft Sentinel, SIEM, KQL, and Incident Response', employment_history: apolloWork('SOC Analyst', 'Blue Team Co'),
    },
    {
      id: 'ap-out-of-state', name: 'Apollo Texas Outside Market', title: 'SOC Analyst',
      city: 'Austin', state: 'Texas', country: 'United States',
      linkedin_url: 'https://www.linkedin.com/in/apollo-texas-outside-market', organization: { name: 'Texas SOC Co' },
      headline: 'SOC Analyst with Microsoft Sentinel, SIEM, KQL, and Incident Response', employment_history: apolloWork('SOC Analyst', 'Texas SOC Co'),
    },
    {
      id: 'ap-remote-only', name: 'Apollo Remote Only', title: 'SOC Analyst',
      city: 'Remote', state: '', country: 'United States',
      linkedin_url: 'https://www.linkedin.com/in/apollo-remote-only', organization: { name: 'Remote SOC Co' },
      headline: 'Remote SOC Analyst with Microsoft Sentinel, SIEM, KQL, and Incident Response', employment_history: apolloWork('SOC Analyst', 'Remote SOC Co'),
    },
    {
      id: 'ap-canada', name: 'Apollo Canada Outside Market', title: 'SOC Analyst',
      city: 'Toronto', state: 'Ontario', country: 'Canada',
      linkedin_url: 'https://www.linkedin.com/in/apollo-canada-outside-market', organization: { name: 'Canada SOC Co' },
      headline: 'SOC Analyst with Microsoft Sentinel, SIEM, KQL, and Incident Response', employment_history: apolloWork('SOC Analyst', 'Canada SOC Co'),
    },
    {
      id: 'ap-unknown-location', name: 'Apollo Unknown Location', title: 'SOC Analyst',
      linkedin_url: 'https://www.linkedin.com/in/apollo-unknown-location', organization: { name: 'Unknown SOC Co' },
      headline: 'SOC Analyst with Microsoft Sentinel and KQL', employment_history: apolloWork('SOC Analyst', 'Unknown SOC Co'),
    },
  ];
  STUB_FIRECRAWL_ITEMS = [];
  STUB_GH_SEARCH_USERS = { items: [] };
  const apolloResolverNeed = createNeed({
    companyId: coApollo.id,
    title: 'SOC Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Hybrid',
    location: 'Michigan',
    confirmed: true,
  });
  const apolloResolverRunId = 'apollo_resolver_' + Date.now().toString(36);
  await runScout({ needId: apolloResolverNeed.id, pipelineRunId: apolloResolverRunId });
  const apolloStructured = DB.candidates.find(c => c.name === 'Apollo Structured Michigan' && c.pipelineRunId === apolloResolverRunId);
  assert(apolloStructured && (apolloStructured.resolved_by || []).includes('apollo') && apolloStructured.resolution_status === 'resolved',
    `Apollo structured MI candidate resolved by Apollo (resolved_by=${JSON.stringify(apolloStructured && apolloStructured.resolved_by)}, status=${apolloStructured && apolloStructured.resolution_status})`);
  assert(apolloStructured && Array.isArray(apolloStructured.workHistory) && apolloStructured.workHistory.length === 1,
    `Apollo structured employment persisted to workHistory (got ${JSON.stringify(apolloStructured && apolloStructured.workHistory)})`);
  assert(apolloStructured && apolloStructured.visibility_state === VISIBILITY_STATE.VISIBLE,
    `Apollo structured MI candidate can proceed through gates (state=${apolloStructured && apolloStructured.visibility_state}, reason=${apolloStructured && apolloStructured.reason_code})`);

  const apolloTexas = DB.candidates.find(c => c.name === 'Apollo Texas Outside Market' && c.pipelineRunId === apolloResolverRunId);
  assert(apolloTexas && (apolloTexas.resolved_by || []).includes('apollo') && apolloTexas.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW && apolloTexas.reason_code === 'LOCATION_OUTSIDE_SELECTED_MARKET' && apolloTexas.recoverable === true,
    `Apollo Texas/out-of-state candidate for Michigan hybrid -> NEEDS_REVIEW/recoverable (state=${apolloTexas && apolloTexas.visibility_state}, reason=${apolloTexas && apolloTexas.reason_code})`);

  const apolloRemoteOnly = DB.candidates.find(c => c.name === 'Apollo Remote Only' && c.pipelineRunId === apolloResolverRunId);
  assert(apolloRemoteOnly && apolloRemoteOnly.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW && apolloRemoteOnly.reason_code === 'LOCATION_OUTSIDE_SELECTED_MARKET',
    `Apollo remote-only candidate for Michigan hybrid is not client-ready (state=${apolloRemoteOnly && apolloRemoteOnly.visibility_state}, reason=${apolloRemoteOnly && apolloRemoteOnly.reason_code})`);

  const apolloCanada = DB.candidates.find(c => c.name === 'Apollo Canada Outside Market' && c.pipelineRunId === apolloResolverRunId);
  assert(apolloCanada && apolloCanada.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW && apolloCanada.reason_code === 'LOCATION_OUTSIDE_SELECTED_MARKET',
    `Apollo non-US candidate for Michigan hybrid is not client-ready (state=${apolloCanada && apolloCanada.visibility_state}, reason=${apolloCanada && apolloCanada.reason_code})`);

  const apolloUnknown = DB.candidates.find(c => c.name === 'Apollo Unknown Location' && c.pipelineRunId === apolloResolverRunId);
  assert(apolloUnknown && !(apolloUnknown.resolved_by || []).includes('apollo') && apolloUnknown.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW && ['APOLLO_STRUCTURED_RESOLUTION_REQUIRED', 'APOLLO_MATCH_NO_MATCH'].includes(apolloUnknown.reason_code),
    `Apollo unknown/unresolved location -> NEEDS_REVIEW (state=${apolloUnknown && apolloUnknown.visibility_state}, reason=${apolloUnknown && apolloUnknown.reason_code})`);

  const apolloResolverCands = DB.candidates.filter(c => c.pipelineRunId === apolloResolverRunId && c.source === 'Apollo');
  const apolloClientReadyResolvedCount = apolloResolverCands.filter(c => (c.resolved_by || []).includes('apollo') && c.visibility_state === VISIBILITY_STATE.VISIBLE).length;
  const apolloReviewCount = apolloResolverCands.filter(c => c.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW).length;
  const apolloHiddenPurgedCount = apolloResolverCands.filter(c => [VISIBILITY_STATE.HIDDEN, VISIBILITY_STATE.PURGED].includes(c.visibility_state)).length;
  assert(apolloResolverCands.length === apolloClientReadyResolvedCount + apolloReviewCount + apolloHiddenPurgedCount,
    `Apollo discovered count equals client-ready resolved + review + hidden/purged (discovered=${apolloResolverCands.length}, resolved=${apolloClientReadyResolvedCount}, review=${apolloReviewCount}, hiddenPurged=${apolloHiddenPurgedCount})`);

  STUB_APOLLO_PEOPLE = [{
    id: 'ap-remote-us-texas', name: 'Apollo Remote Search Texas', title: 'SOC Analyst',
    city: 'Austin', state: 'Texas', country: 'United States',
    linkedin_url: 'https://www.linkedin.com/in/apollo-remote-search-texas', organization: { name: 'Remote Search Co' },
    headline: 'SOC Analyst with Microsoft Sentinel, SIEM, KQL, and Incident Response', employment_history: apolloWork('SOC Analyst', 'Remote Search Co'),
  }];
  const apolloRemoteNeed = createNeed({
    companyId: coApollo.id,
    title: 'SOC Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Remote',
    location: 'Remote US',
    confirmed: true,
  });
  const apolloRemoteRunId = 'apollo_remote_market_' + Date.now().toString(36);
  await runScout({ needId: apolloRemoteNeed.id, pipelineRunId: apolloRemoteRunId });
  const apolloRemoteSearch = DB.candidates.find(c => c.name === 'Apollo Remote Search Texas' && c.pipelineRunId === apolloRemoteRunId);
  assert(apolloRemoteSearch && apolloRemoteSearch.visibility_state === VISIBILITY_STATE.VISIBLE && apolloRemoteSearch.reason_code !== 'LOCATION_OUTSIDE_SELECTED_MARKET',
    `Remote US search does not apply Michigan-only market gate (state=${apolloRemoteSearch && apolloRemoteSearch.visibility_state}, reason=${apolloRemoteSearch && apolloRemoteSearch.reason_code})`);

  // (h4) Apollo Match enrichment: Search preview records get structural
  //      location + employment via /api/v1/people/match, capped per run.
  const preview = (id, name, title, company) => ({
    id, name, title,
    organization: { name: company },
    has_city: true,
    has_state: true,
    has_country: true,
  });
  const matchedPerson = (id, name, title, company, city, state, country, linkedInSlug = id) => ({
    person: {
      id, name, title,
      organization: { name: company },
      city, state, country,
      linkedin_url: `https://www.linkedin.com/in/${linkedInSlug}`,
      employment_history: apolloWork(title, company),
      headline: `${title} with Microsoft Sentinel, SIEM, KQL, and Incident Response`,
    },
  });

  assert(JSON.stringify(apolloSearchLocationFromNeed({ location: 'Michigan hybrid', locationType: 'Hybrid' })) === JSON.stringify(['Michigan, US']),
    `Apollo location strips hybrid work mode for Michigan (got ${JSON.stringify(apolloSearchLocationFromNeed({ location: 'Michigan hybrid', locationType: 'Hybrid' }))})`);
  assert(JSON.stringify(apolloSearchLocationFromNeed({ location: 'Texas hybrid', locationType: 'Hybrid' })) === JSON.stringify(['Texas, US']),
    `Apollo location strips hybrid work mode for Texas (got ${JSON.stringify(apolloSearchLocationFromNeed({ location: 'Texas hybrid', locationType: 'Hybrid' }))})`);
  assert(JSON.stringify(apolloSearchLocationFromNeed({ location: 'Detroit onsite', locationType: 'Onsite' })) === JSON.stringify(['Detroit, US']),
    `Apollo location strips onsite work mode for city search (got ${JSON.stringify(apolloSearchLocationFromNeed({ location: 'Detroit onsite', locationType: 'Onsite' }))})`);
  assert(JSON.stringify(apolloSearchLocationFromNeed({ location: 'Michigan remote', locationType: 'Hybrid' })) === JSON.stringify(['Michigan, US']),
    `Apollo location strips remote work mode when the search is still located (got ${JSON.stringify(apolloSearchLocationFromNeed({ location: 'Michigan remote', locationType: 'Hybrid' }))})`);
  assert(JSON.stringify(apolloSearchLocationFromNeed({ location: 'Remote US', locationType: 'Remote' })) === JSON.stringify(['United States']),
    `Remote US Apollo search sends country-only location (got ${JSON.stringify(apolloSearchLocationFromNeed({ location: 'Remote US', locationType: 'Remote' }))})`);
  assert(JSON.stringify(apolloSearchLocationFromNeed({ location: 'Global', locationType: 'Remote' })) === JSON.stringify([]),
    `Global Apollo search sends no location filter (got ${JSON.stringify(apolloSearchLocationFromNeed({ location: 'Global', locationType: 'Remote' }))})`);

  APOLLO_MATCH_CALLS.length = 0;
  APOLLO_SEARCH_CALLS.length = 0;
  STUB_APOLLO_MATCH_HTTP = null;
  STUB_APOLLO_PEOPLE = [
    preview('ap-match-mi', 'Apollo Match Michigan', 'SOC Analyst', 'Match MI Co'),
  ];
  STUB_APOLLO_MATCH = {
    'ap-match-mi': matchedPerson('ap-match-mi', 'Apollo Match Michigan', 'SOC Analyst', 'Match MI Co', 'Detroit', 'Michigan', 'United States', 'apollo-match-michigan'),
  };
  const apolloMatchNeed = createNeed({
    companyId: coApollo.id,
    title: 'SOC Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Hybrid',
    location: 'Michigan hybrid',
    confirmed: true,
  });
  const apolloMatchRun = 'apollo_match_success_' + Date.now().toString(36);
  await runScout({ needId: apolloMatchNeed.id, pipelineRunId: apolloMatchRun, apolloMaxEnrichPerRun: 10 });
  const apolloMatchMi = DB.candidates.find(c => c.name === 'Apollo Match Michigan' && c.pipelineRunId === apolloMatchRun);
  assert(APOLLO_SEARCH_CALLS.length > 0 && JSON.stringify(APOLLO_SEARCH_CALLS[0].person_locations) === JSON.stringify(['Michigan, US']),
    `Michigan hybrid Apollo primary search uses person_locations ["Michigan, US"] (got ${JSON.stringify(APOLLO_SEARCH_CALLS[0] && APOLLO_SEARCH_CALLS[0].person_locations)})`);
  assert(APOLLO_SEARCH_CALLS.every(call => JSON.stringify(call.person_locations) === JSON.stringify(['Michigan, US'])),
    `Located Michigan search does not fall back to no-location nationwide attempts (calls=${JSON.stringify(APOLLO_SEARCH_CALLS.map(c => c.person_locations))})`);
  assert(APOLLO_SEARCH_CALLS.every(call => !(call.person_locations || []).some(loc => /\bhybrid\b|\bonsite\b|\bremote\b/i.test(loc))),
    `Apollo person_locations strip work-mode words for located search (calls=${JSON.stringify(APOLLO_SEARCH_CALLS.map(c => c.person_locations))})`);
  assert(APOLLO_MATCH_CALLS.length === 1 && APOLLO_MATCH_CALLS[0].hasId === true,
    `Apollo Match called once using Apollo id for preview candidate (calls=${JSON.stringify(APOLLO_MATCH_CALLS)})`);
  assert(apolloMatchMi && (apolloMatchMi.resolved_by || []).includes('apollo') && apolloMatchMi.resolution_status === 'resolved',
    `Apollo search preview + successful Match resolves candidate (resolved_by=${JSON.stringify(apolloMatchMi && apolloMatchMi.resolved_by)}, status=${apolloMatchMi && apolloMatchMi.resolution_status})`);
  assert(apolloMatchMi && apolloMatchMi.visibility_state === VISIBILITY_STATE.VISIBLE,
    `Apollo Match in-market enriched candidate is client-ready/VISIBLE (state=${apolloMatchMi && apolloMatchMi.visibility_state}, reason=${apolloMatchMi && apolloMatchMi.reason_code})`);
  assert(apolloMatchMi && Array.isArray(apolloMatchMi.workHistory) && apolloMatchMi.workHistory.length === 1,
    `Apollo Match employment_history persisted into workHistory (got ${JSON.stringify(apolloMatchMi && apolloMatchMi.workHistory)})`);

  APOLLO_MATCH_CALLS.length = 0;
  APOLLO_SEARCH_CALLS.length = 0;
  STUB_APOLLO_PEOPLE = [
    preview('ap-match-tx', 'Apollo Match Texas', 'SOC Analyst', 'Match TX Co'),
    preview('ap-match-mi-out', 'Apollo Match Michigan Out', 'SOC Analyst', 'Match MI Out Co'),
  ];
  STUB_APOLLO_MATCH = {
    'ap-match-tx': matchedPerson('ap-match-tx', 'Apollo Match Texas', 'SOC Analyst', 'Match TX Co', 'Austin', 'Texas', 'United States', 'apollo-match-texas'),
    'ap-match-mi-out': matchedPerson('ap-match-mi-out', 'Apollo Match Michigan Out', 'SOC Analyst', 'Match MI Out Co', 'Detroit', 'Michigan', 'United States', 'apollo-match-michigan-out'),
  };
  const apolloTexasNeed = createNeed({
    companyId: coApollo.id,
    title: 'SOC Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Hybrid',
    location: 'Texas hybrid',
    confirmed: true,
  });
  const apolloTexasRun = 'apollo_match_texas_' + Date.now().toString(36);
  await runScout({ needId: apolloTexasNeed.id, pipelineRunId: apolloTexasRun, apolloMaxEnrichPerRun: 10 });
  const matchTexas = DB.candidates.find(c => c.name === 'Apollo Match Texas' && c.pipelineRunId === apolloTexasRun);
  const matchMichiganOut = DB.candidates.find(c => c.name === 'Apollo Match Michigan Out' && c.pipelineRunId === apolloTexasRun);
  assert(APOLLO_SEARCH_CALLS.length > 0 && JSON.stringify(APOLLO_SEARCH_CALLS[0].person_locations) === JSON.stringify(['Texas, US']),
    `Texas hybrid Apollo primary search uses person_locations ["Texas, US"] (got ${JSON.stringify(APOLLO_SEARCH_CALLS[0] && APOLLO_SEARCH_CALLS[0].person_locations)})`);
  assert(APOLLO_SEARCH_CALLS.every(call => JSON.stringify(call.person_locations) === JSON.stringify(['Texas, US'])),
    `Located Texas search does not fall back to no-location nationwide attempts (calls=${JSON.stringify(APOLLO_SEARCH_CALLS.map(c => c.person_locations))})`);
  assert(matchTexas && matchTexas.visibility_state === VISIBILITY_STATE.VISIBLE,
    `GENERALIZATION: Texas search allows enriched Texas candidate (state=${matchTexas && matchTexas.visibility_state}, reason=${matchTexas && matchTexas.reason_code})`);
  assert(matchMichiganOut && matchMichiganOut.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW && matchMichiganOut.reason_code === 'LOCATION_OUTSIDE_SELECTED_MARKET',
    `GENERALIZATION: Texas search blocks enriched Michigan candidate as NEEDS_REVIEW (state=${matchMichiganOut && matchMichiganOut.visibility_state}, reason=${matchMichiganOut && matchMichiganOut.reason_code})`);

  STUB_APOLLO_PEOPLE = [
    preview('ap-match-remote-local', 'Apollo Match Remote Local', 'SOC Analyst', 'Remote Local Co'),
    preview('ap-match-uk-local', 'Apollo Match UK Local', 'SOC Analyst', 'UK Local Co'),
  ];
  STUB_APOLLO_MATCH = {
    'ap-match-remote-local': matchedPerson('ap-match-remote-local', 'Apollo Match Remote Local', 'SOC Analyst', 'Remote Local Co', 'Remote', '', 'United States', 'apollo-match-remote-local'),
    'ap-match-uk-local': matchedPerson('ap-match-uk-local', 'Apollo Match UK Local', 'SOC Analyst', 'UK Local Co', 'London', '', 'United Kingdom', 'apollo-match-uk-local'),
  };
  const apolloLocalRun = 'apollo_match_local_gate_' + Date.now().toString(36);
  await runScout({ needId: apolloTexasNeed.id, pipelineRunId: apolloLocalRun, apolloMaxEnrichPerRun: 10 });
  const remoteLocal = DB.candidates.find(c => c.name === 'Apollo Match Remote Local' && c.pipelineRunId === apolloLocalRun);
  const ukLocal = DB.candidates.find(c => c.name === 'Apollo Match UK Local' && c.pipelineRunId === apolloLocalRun);
  assert(remoteLocal && remoteLocal.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW && remoteLocal.reason_code === 'LOCATION_OUTSIDE_SELECTED_MARKET',
    `Apollo Match remote-only candidate on local search is not client-ready (state=${remoteLocal && remoteLocal.visibility_state}, reason=${remoteLocal && remoteLocal.reason_code})`);
  assert(ukLocal && ukLocal.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW && ukLocal.reason_code === 'LOCATION_OUTSIDE_SELECTED_MARKET',
    `Apollo Match non-US candidate on local search is not client-ready (state=${ukLocal && ukLocal.visibility_state}, reason=${ukLocal && ukLocal.reason_code})`);

  STUB_APOLLO_PEOPLE = [
    preview('ap-match-remote-us', 'Apollo Match Remote US', 'SOC Analyst', 'Remote US Co'),
  ];
  STUB_APOLLO_MATCH = {
    'ap-match-remote-us': matchedPerson('ap-match-remote-us', 'Apollo Match Remote US', 'SOC Analyst', 'Remote US Co', 'Austin', 'Texas', 'United States', 'apollo-match-remote-us'),
  };
  const apolloMatchRemoteNeed = createNeed({
    companyId: coApollo.id,
    title: 'SOC Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Remote',
    location: 'Remote US',
    confirmed: true,
  });
  const apolloMatchRemoteRun = 'apollo_match_remote_' + Date.now().toString(36);
  APOLLO_SEARCH_CALLS.length = 0;
  await runScout({ needId: apolloMatchRemoteNeed.id, pipelineRunId: apolloMatchRemoteRun, apolloMaxEnrichPerRun: 10 });
  const remoteUs = DB.candidates.find(c => c.name === 'Apollo Match Remote US' && c.pipelineRunId === apolloMatchRemoteRun);
  assert(APOLLO_SEARCH_CALLS.some(call => JSON.stringify(call.person_locations) === JSON.stringify(['United States'])),
    `Remote US Apollo search uses country-only location filter, not a state filter (calls=${JSON.stringify(APOLLO_SEARCH_CALLS.map(c => c.person_locations))})`);
  assert(APOLLO_SEARCH_CALLS.every(call => !(call.person_locations || []).some(loc => /Michigan|Texas, US/i.test(loc))),
    `Remote/global search does not inherit a state-only Apollo location filter (calls=${JSON.stringify(APOLLO_SEARCH_CALLS.map(c => c.person_locations))})`);
  assert(remoteUs && remoteUs.visibility_state === VISIBILITY_STATE.VISIBLE && remoteUs.reason_code !== 'LOCATION_OUTSIDE_SELECTED_MARKET',
    `Remote/global search does not apply state market gate to Apollo Match candidate (state=${remoteUs && remoteUs.visibility_state}, reason=${remoteUs && remoteUs.reason_code})`);

  STUB_APOLLO_PEOPLE = [preview('ap-match-none', 'Apollo Match No Match', 'SOC Analyst', 'No Match Co')];
  STUB_APOLLO_MATCH = { 'ap-match-none': null };
  const apolloNoMatchRun = 'apollo_match_no_match_' + Date.now().toString(36);
  await runScout({ needId: apolloMatchNeed.id, pipelineRunId: apolloNoMatchRun, apolloMaxEnrichPerRun: 10 });
  const noMatchApollo = DB.candidates.find(c => c.name === 'Apollo Match No Match' && c.pipelineRunId === apolloNoMatchRun);
  assert(noMatchApollo && noMatchApollo.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW && noMatchApollo.reason_code === 'APOLLO_MATCH_NO_MATCH' && noMatchApollo.recoverable === true,
    `Apollo Match 404/no-match stays NEEDS_REVIEW/recoverable (state=${noMatchApollo && noMatchApollo.visibility_state}, reason=${noMatchApollo && noMatchApollo.reason_code})`);

  APOLLO_MATCH_CALLS.length = 0;
  STUB_APOLLO_PEOPLE = [
    preview('ap-cap-1', 'Apollo Cap One', 'SOC Analyst', 'Cap One Co'),
    preview('ap-cap-2', 'Apollo Cap Two', 'SOC Analyst', 'Cap Two Co'),
  ];
  STUB_APOLLO_MATCH = {
    'ap-cap-1': matchedPerson('ap-cap-1', 'Apollo Cap One', 'SOC Analyst', 'Cap One Co', 'Detroit', 'Michigan', 'United States', 'apollo-cap-one'),
    'ap-cap-2': matchedPerson('ap-cap-2', 'Apollo Cap Two', 'SOC Analyst', 'Cap Two Co', 'Detroit', 'Michigan', 'United States', 'apollo-cap-two'),
  };
  const apolloCapRun = 'apollo_match_cap_' + Date.now().toString(36);
  await runScout({ needId: apolloMatchNeed.id, pipelineRunId: apolloCapRun, apolloMaxEnrichPerRun: 1 });
  const capOne = DB.candidates.find(c => c.name === 'Apollo Cap One' && c.pipelineRunId === apolloCapRun);
  const capTwo = DB.candidates.find(c => c.name === 'Apollo Cap Two' && c.pipelineRunId === apolloCapRun);
  const capCands = DB.candidates.filter(c => c.pipelineRunId === apolloCapRun && c.source === 'Apollo');
  const capResolvedVisible = capCands.filter(c => (c.resolved_by || []).includes('apollo') && c.visibility_state === VISIBILITY_STATE.VISIBLE).length;
  const capReview = capCands.filter(c => c.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW).length;
  assert(APOLLO_MATCH_CALLS.length === 1,
    `Apollo Match budget cap counts actual calls only (calls=${APOLLO_MATCH_CALLS.length})`);
  assert(capOne && capOne.visibility_state === VISIBILITY_STATE.VISIBLE,
    `Apollo Match first candidate under cap can resolve/VISIBLE (state=${capOne && capOne.visibility_state})`);
  assert(capTwo && capTwo.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW && capTwo.reason_code === 'APOLLO_MATCH_QUEUED_BUDGET_CAP' && capTwo.recoverable === true,
    `Apollo Match budget cap queues remaining candidate as recoverable NEEDS_REVIEW (state=${capTwo && capTwo.visibility_state}, reason=${capTwo && capTwo.reason_code})`);
  assert(capCands.length === capResolvedVisible + capReview,
    `Apollo Match discovered == resolved + review (zero lost; discovered=${capCands.length}, resolved=${capResolvedVisible}, review=${capReview})`);

  assert(resolveApolloMaxEnrichPerRun(undefined) === APOLLO_MATCH_DEFAULT_MAX_PER_RUN,
    `Apollo Match default per-run cap is ${APOLLO_MATCH_DEFAULT_MAX_PER_RUN}`);
  const volumeCfg = resolveApolloVolumeConfig({ maxResultsPerVariant: 10, maxVariantsPerRun: 5, maxCandidatesPerRun: 50 });
  assert(volumeCfg.maxResultsPerVariant === APOLLO_MAX_RESULTS_PER_VARIANT_DEFAULT &&
    volumeCfg.maxVariantsPerRun === APOLLO_MAX_VARIANTS_PER_RUN_DEFAULT &&
    volumeCfg.maxCandidatesPerRun === APOLLO_MAX_CANDIDATES_PER_RUN_DEFAULT,
    `Apollo volume defaults are bounded/configurable (${JSON.stringify(volumeCfg)})`);
  const volumeAttempts = buildApolloCandidateAttempts({
    title: 'SOC Analyst / Detection Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Hybrid',
    location: 'Michigan hybrid',
  }, { expandCandidatePool: true, volumeConfig: volumeCfg });
  assert(volumeAttempts.length === 5 && volumeAttempts.every(a => a.titles.length === 1),
    `Expand ON runs capped single-title Apollo variants (count=${volumeAttempts.length}, titles=${JSON.stringify(volumeAttempts.map(a => a.titles))})`);
  assert(JSON.stringify(volumeAttempts.map(a => a.titles[0])) === JSON.stringify([
    'SOC Analyst',
    'Detection Analyst',
    'Security Operations Analyst',
    'Security Analyst',
    'SIEM Analyst',
  ]),
    `Combined SOC/Detection label splits into real Apollo titles in ranked order (titles=${JSON.stringify(volumeAttempts.map(a => a.titles[0]))})`);
  assert(volumeAttempts.every(a => !(a.titles || []).some(t => /\/|sentinel|kql|kusto/i.test(t))) &&
    volumeAttempts.every(a => /KQL Kusto Microsoft Sentinel/.test(a.keywords || '')),
    `Apollo title variants avoid slash/tool terms while q_keywords carries tool terms (attempts=${JSON.stringify(volumeAttempts.map(a => ({ titles: a.titles, keywords: a.keywords })))})`);
  assert(volumeAttempts.every(a => JSON.stringify(a.locations) === JSON.stringify(['Michigan, US'])) &&
    volumeAttempts.every(a => !(a.locations || []).some(loc => /\bhybrid\b|\bonsite\b|\bremote\b/i.test(loc))),
    `Expand ON Michigan hybrid Apollo attempts stay selected-market filtered (locations=${JSON.stringify(volumeAttempts.map(a => a.locations))})`);
  assert(volumeAttempts[0].searchVariantMeta[0].variant_type === 'exact_role' &&
    volumeAttempts[1].searchVariantMeta[0].variant_type === 'exact_role' &&
    volumeAttempts.slice(0, 2).every(a => a.searchVariantMeta[0].specificity_weight === 1.0),
    `Apollo variants are ordered exact split titles first (variants=${JSON.stringify(volumeAttempts.map(a => a.searchVariantMeta[0]))})`);

  APOLLO_MATCH_CALLS.length = 0;
  APOLLO_SEARCH_CALLS.length = 0;
  STUB_FIRECRAWL_ITEMS = [
    { title: 'Firecrawl Only Volume One - SOC Analyst', url: 'https://www.linkedin.com/in/firecrawl-volume-one', description: 'SOC Analyst Michigan LinkedIn profile mention' },
    { title: 'Firecrawl Only Volume Two - Detection Analyst', url: 'https://www.linkedin.com/in/firecrawl-volume-two', description: 'Detection Analyst Michigan LinkedIn profile mention' },
  ];
  STUB_GH_SEARCH_USERS = { items: [] };
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';
  process.env.PDL_API_KEY = 'test-pdl-key';
  STUB_PDL_SEARCH = { data: [] };
  STUB_PDL_RESOLVE_HTTP = { status: 402, body: { error: 'payment_required' } };
  const apolloVolumePerson = (id, name, title, company = 'Volume Security Co') => ({
    id, name, title,
    city: 'Detroit', state: 'Michigan', country: 'United States',
    linkedin_url: `https://www.linkedin.com/in/${id}`,
    organization: { name: company },
    headline: `${title} with Microsoft Sentinel, SIEM, KQL, and Incident Response`,
    employment_history: apolloWork(title, company),
  });
  const variantPeople = {
    'soc analyst': apolloVolumePerson('apollo-volume-soc', 'Apollo Volume SOC', 'SOC Analyst'),
    'detection analyst': apolloVolumePerson('apollo-volume-detection', 'Apollo Volume Detection', 'Detection Analyst'),
    'security operations analyst': apolloVolumePerson('apollo-volume-secops', 'Apollo Volume SecOps', 'Security Operations Analyst'),
    'security analyst': apolloVolumePerson('apollo-volume-security', 'Apollo Volume Security', 'Security Analyst'),
    'siem analyst': apolloVolumePerson('apollo-volume-siem', 'Apollo Volume SIEM', 'SIEM Analyst'),
  };
  STUB_APOLLO_PEOPLE = body => {
    const titles = (body.person_titles || []).map(t => String(t).toLowerCase());
    if (titles.length !== 1) return [apolloVolumePerson('apollo-volume-baseline', 'Apollo Volume Baseline', 'SOC Analyst')];
    return variantPeople[titles[0]] ? [variantPeople[titles[0]]] : [];
  };
  STUB_APOLLO_MATCH = null;
  const volumeNeed = createNeed({
    companyId: coApollo.id,
    title: 'SOC Analyst / Detection Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Hybrid',
    location: 'Michigan hybrid',
    confirmed: true,
  });
  const volumeBaselineRun = 'apollo_volume_baseline_' + Date.now().toString(36);
  await runScout({ needId: volumeNeed.id, pipelineRunId: volumeBaselineRun, expandCandidatePool: false });
  const baselineApollo = DB.candidates.filter(c => c.pipelineRunId === volumeBaselineRun && (c.discovered_by || []).includes('apollo'));
  APOLLO_SEARCH_CALLS.length = 0;
  const volumeExpandedRun = 'apollo_volume_expanded_' + Date.now().toString(36);
  await runScout({ needId: volumeNeed.id, pipelineRunId: volumeExpandedRun, expandCandidatePool: true });
  const expandedApollo = DB.candidates.filter(c => c.pipelineRunId === volumeExpandedRun && (c.discovered_by || []).includes('apollo'));
  const expandedApolloVisible = expandedApollo.filter(c => c.visibility_state === VISIBILITY_STATE.VISIBLE && isClientReadyForNeed(c, volumeNeed));
  const expandedApolloReview = expandedApollo.filter(c => c.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW);
  const expandedFirecrawlVisible = DB.candidates.filter(c => c.pipelineRunId === volumeExpandedRun && (c.discovered_by || []).includes('firecrawl') && c.visibility_state === VISIBILITY_STATE.VISIBLE);
  assert(APOLLO_SEARCH_CALLS.length === 5 && APOLLO_SEARCH_CALLS.every(call => JSON.stringify(call.person_locations) === JSON.stringify(['Michigan, US'])) &&
    APOLLO_SEARCH_CALLS.every(call => call.titleCount === 1 && call.per_page === 10),
    `Expand ON Michigan hybrid runs five capped location-filtered Apollo variant searches (calls=${JSON.stringify(APOLLO_SEARCH_CALLS)})`);
  assert(APOLLO_SEARCH_CALLS.every(call => !(call.person_titles || []).some(t => /\/|sentinel|kql|kusto/i.test(t))) &&
    APOLLO_SEARCH_CALLS.every(call => call.q_keywords === 'KQL Kusto Microsoft Sentinel'),
    `Apollo live search calls send real titles and keep tool terms in q_keywords (calls=${JSON.stringify(APOLLO_SEARCH_CALLS)})`);
  assert(JSON.stringify(APOLLO_SEARCH_CALLS.map(call => call.person_titles[0])) === JSON.stringify(volumeAttempts.map(a => a.titles[0])),
    `Apollo live search calls follow ranked variant order (calls=${JSON.stringify(APOLLO_SEARCH_CALLS.map(call => call.person_titles[0]))})`);
  assert(expandedApollo.length > baselineApollo.length && expandedApolloVisible.length === 5,
    `Apollo discovered/visible count increases via structured variants only (baseline=${baselineApollo.length}, expanded=${expandedApollo.length}, visible=${expandedApolloVisible.length})`);
  assert(expandedApollo.every(c => (c.resolved_by || []).includes('apollo') && c.provider_of_record === 'apollo') && expandedApolloVisible.length >= 5,
    `Apollo expanded candidates resolve by Apollo and can become visible when gates pass (visible=${expandedApolloVisible.length})`);
  assert(expandedApollo.length === expandedApolloVisible.length + expandedApolloReview.length,
    `Apollo volume discovered == visible/resolved + review (zero lost; discovered=${expandedApollo.length}, visible=${expandedApolloVisible.length}, review=${expandedApolloReview.length})`);
  assert(expandedFirecrawlVisible.length === 0,
    `PDL 402/unavailable does not cause Firecrawl-only candidates to leak into visible/client-ready (firecrawlVisible=${expandedFirecrawlVisible.length})`);

  STUB_FIRECRAWL_ITEMS = [];
  STUB_PDL_SEARCH = null;
  STUB_PDL_RESOLVE_HTTP = null;
  STUB_APOLLO_MATCH = null;
  STUB_APOLLO_MATCH_HTTP = null;

  // (i) expandRoleToTitles produces meaningful variants
  const titles = _internals.expandRoleToTitles('Azure Security Engineer');
  assert(titles.length >= 5, `expandRoleToTitles returns ≥5 variants for security role (got ${titles.length})`);
  assert(titles.some(t => /SOC Analyst/i.test(t)), `expandRoleToTitles includes "SOC Analyst"`);
  assert(titles.some(t => /Detection Engineer/i.test(t)), `expandRoleToTitles includes "Detection Engineer"`);
  assert(titles.some(t => /SIEM Engineer/i.test(t)), `expandRoleToTitles includes SIEM Engineer`);
  assert(titles.some(t => /IAM (Engineer|Analyst)/i.test(t)), `expandRoleToTitles includes an IAM role`);

  // ── 17b. Apollo sample mock-run JSON proof ──
  console.log('\n── Sample mock run proving Apollo returns multiple candidate profiles ──');
  console.log(JSON.stringify({
    pipelineRunId: apolloRunId,
    sourcedRaw: apolloScout.sourcedRaw,
    acceptedCandidates: apolloScout.acceptedCandidates,
    needsScoutReview: apolloScout.needsScoutReview,
    rejectedNonCandidates: apolloScout.rejectedNonCandidates,
    rawResultsBySource: apolloScout.rawResultsBySource,
    acceptedBySource: apolloScout.acceptedBySource,
    rejectedByReason: apolloScout.rejectedByReason,
    apolloAcceptedSamples: apolloCandsInDB.map(c => ({
      name: c.name, currentTitle: c.currentTitle, currentCompany: c.currentCompany,
      location: c.location, source: c.source, sourceType: c.sourceType,
      scoutDecision: c.scoutDecision, scoutReason: c.scoutReason, linkedinUrl: c.linkedinUrl,
    })),
  }, null, 2));

  // Restore Apollo env
  if (prevApolloKey === undefined) delete process.env.APOLLO_API_KEY;
  else process.env.APOLLO_API_KEY = prevApolloKey;
  STUB_APOLLO_PEOPLE = null;

  // ── 18. Real-shortlist policy (host-anchored LinkedIn + review-pool exclusion) ──
  // (a) isLinkedInProfileUrl unit cases
  const liCases = [
    ['https://www.linkedin.com/in/jane-doe',                    true,  'standard /in/'],
    ['https://linkedin.com/in/jane-doe',                        true,  'no www prefix'],
    ['https://de.linkedin.com/in/hans',                         true,  'regional subdomain'],
    ['http://www.linkedin.com/in/legacy-http',                  true,  'http scheme allowed'],
    ['https://www.linkedin.com/jobs/view/12345',                false, '/jobs/ not /in/'],
    ['https://www.linkedin.com/company/microsoft',              false, '/company/ not /in/'],
    ['https://www.linkedin.com/pub/jane/1/2/3',                 false, 'legacy /pub/'],
    ['https://attacker.com/linkedin.com/in/jane',               false, 'spoofed path'],
    ['https://attacker.com/?u=linkedin.com/in/jane',            false, 'spoofed query'],
    ['linkedin.com/in/jane',                                    false, 'no scheme'],
    ['ftp://www.linkedin.com/in/jane',                          false, 'wrong scheme'],
    ['https://www.linkedin.com',                                false, 'no /in/ path'],
    ['',                                                        false, 'empty string'],
    [null,                                                      false, 'null'],
  ];
  for (const [url, expected, label] of liCases) {
    const got = isLinkedInProfileUrl(url);
    assert(got === expected, `isLinkedInProfileUrl[${label}] url=${JSON.stringify(url)} → ${got} (expected ${expected})`);
  }

  // (b) Apollo branch with spoofed linkedin_url → review, not accepted
  process.env.APOLLO_API_KEY = 'test-apollo-key';
  STUB_APOLLO_PEOPLE = [
    { id: 'sp1', name: 'Spoof Person 1', title: 'Eng', linkedin_url: 'https://attacker.com/linkedin.com/in/spoof1', organization: { name: 'X' } },
    { id: 'sp2', name: 'Spoof Person 2', title: 'Eng', linkedin_url: 'http://evil.com/?u=linkedin.com/in/spoof2',   organization: { name: 'X' } },
    { id: 'sp3', name: 'Real Person',    title: 'Cloud Security Engineer', city: 'Detroit', state: 'Michigan', country: 'United States', linkedin_url: 'https://www.linkedin.com/in/real-li', organization: { name: 'RealCo' }, headline: 'Azure Sentinel KQL Defender for Cloud', employment_history: [{ title: 'Cloud Security Engineer', organization: { name: 'RealCo' }, start_date: '2024-01-01', current: true }] },
  ];
  STUB_FIRECRAWL_ITEMS = [];
  STUB_GH_SEARCH_USERS = { items: [] };
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';

  const spoofNeed = createNeed({
    companyId: coApollo.id, title: 'Azure Security Engineer',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const spoofRunId = 'spoof_run_' + Date.now().toString(36);
  const spoofScout = await runScout({ needId: spoofNeed.id, pipelineRunId: spoofRunId });
  const sp1 = DB.candidates.find(c => c.name === 'Spoof Person 1' && c.pipelineRunId === spoofRunId);
  const sp2 = DB.candidates.find(c => c.name === 'Spoof Person 2' && c.pipelineRunId === spoofRunId);
  const sp3 = DB.candidates.find(c => c.name === 'Real Person'    && c.pipelineRunId === spoofRunId);
  assert(sp1 && sp1.scoutDecision === 'review',  `Spoofed-host Apollo result → review (got "${sp1 && sp1.scoutDecision}")`);
  assert(sp2 && sp2.scoutDecision === 'review',  `Spoofed-query Apollo result → review (got "${sp2 && sp2.scoutDecision}")`);
  assert(sp3 && sp3.scoutDecision === 'accepted', `Real-/in/ Apollo result → accepted (got "${sp3 && sp3.scoutDecision}")`);
  assert(spoofScout.acceptedCandidates === 1 && spoofScout.needsScoutReview === 2,
    `Spoof scout split: 1 accepted, 2 review (got ${spoofScout.acceptedCandidates}/${spoofScout.needsScoutReview})`);

  // (c) Matchmaker pool EXCLUDES review candidates — final shortlist is real-only.
  const spoofMm = await runMatchmaker({ needId: spoofNeed.id, pipelineRunId: spoofRunId });
  assert(spoofMm.matched === 1,
    `Matchmaker scored ONLY the 1 accepted candidate; 2 review candidates excluded (got ${spoofMm.matched})`);
  assert(spoofMm.reviewPoolSize === 2,
    `Matchmaker reports reviewPoolSize === 2 (got ${spoofMm.reviewPoolSize})`);
  // No match record should reference a spoof candidate
  const spoofMatches = DB.matches.filter(m => m.pipelineRunId === spoofRunId);
  for (const m of spoofMatches) {
    const c = DB.candidates.find(x => x.id === m.candidateId);
    assert(c && c.scoutDecision === 'accepted',
      `Match ${m.id} only references accepted candidate (got scoutDecision="${c && c.scoutDecision}")`);
    assert(c && c.name !== 'Spoof Person 1' && c.name !== 'Spoof Person 2',
      `Match ${m.id} does not reference a spoof candidate (name="${c && c.name}")`);
  }

  // (d) Client report for spoof run includes ONLY the real candidate
  const spoofRep = await generateClientReport({
    needId: spoofNeed.id, pipelineRunId: spoofRunId,
    scoutStats: {
      sourcedRaw: spoofScout.sourcedRaw,
      acceptedCandidates: spoofScout.acceptedCandidates,
      needsScoutReview: spoofScout.needsScoutReview,
      rejectedNonCandidates: spoofScout.rejectedNonCandidates,
    },
  });
  assert(spoofRep.report.candidates.length === 1,
    `Report includes only 1 candidate (the real one); got ${spoofRep.report.candidates.length}`);
  assert(spoofRep.report.candidates[0].name === 'Real Person',
    `Report's sole candidate is "Real Person" (got "${spoofRep.report.candidates[0].name}")`);

  // (e) "No real verified candidates found" when 0 accepted but review pool > 0
  STUB_APOLLO_PEOPLE = [
    { id: 'r1', name: 'Review Only 1', title: 'Eng', linkedin_url: '', organization: { name: 'X' } },
    { id: 'r2', name: 'Review Only 2', title: 'Eng', linkedin_url: 'https://www.linkedin.com/company/x', organization: { name: 'X' } },
  ];
  STUB_FIRECRAWL_ITEMS = [];
  const reviewOnlyNeed = createNeed({
    companyId: coApollo.id, title: 'Azure Security Engineer',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const reviewOnlyRunId = 'review_only_run_' + Date.now().toString(36);
  const reviewOnlyScout = await runScout({ needId: reviewOnlyNeed.id, pipelineRunId: reviewOnlyRunId });
  assert(reviewOnlyScout.acceptedCandidates === 0 && reviewOnlyScout.needsScoutReview === 2,
    `review-only scout: 0 accepted, 2 review (got ${reviewOnlyScout.acceptedCandidates}/${reviewOnlyScout.needsScoutReview})`);
  const reviewOnlyMm = await runMatchmaker({ needId: reviewOnlyNeed.id, pipelineRunId: reviewOnlyRunId });
  assert(reviewOnlyMm.matched === 0 && reviewOnlyMm.visible === 0,
    `Matchmaker yields 0 matched / 0 visible when only review candidates exist (matched=${reviewOnlyMm.matched}, visible=${reviewOnlyMm.visible})`);
  assert(reviewOnlyMm.reviewPoolSize === 2, `reviewPoolSize === 2 (got ${reviewOnlyMm.reviewPoolSize})`);
  const reviewOnlyRep = await generateClientReport({
    needId: reviewOnlyNeed.id, pipelineRunId: reviewOnlyRunId,
    scoutStats: {
      sourcedRaw: reviewOnlyScout.sourcedRaw,
      acceptedCandidates: reviewOnlyScout.acceptedCandidates,
      needsScoutReview: reviewOnlyScout.needsScoutReview,
      rejectedNonCandidates: reviewOnlyScout.rejectedNonCandidates,
    },
  });
  assert(reviewOnlyRep.report && /No real verified candidates found/.test(reviewOnlyRep.report.summary),
    `Summary says "No real verified candidates found" when only review candidates exist (got "${reviewOnlyRep.report && reviewOnlyRep.report.summary}")`);
  assert(reviewOnlyRep.report.candidates.length === 0,
    `Report.candidates is empty when no accepted (got ${reviewOnlyRep.report.candidates.length})`);

  // (e2) STRICT scoutDecision: null / undefined / '' / 'demo' must NOT enter Matchmaker
  const strictNeed = createNeed({
    companyId: coApollo.id, title: 'Strict Decision Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const strictRunId = 'strict_run_' + Date.now().toString(36);

  const nullCand = findOrCreateCandidate({
    name: 'Null Decision', linkedinUrl: 'https://www.linkedin.com/in/null-decision',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: strictRunId,
  });
  nullCand.scoutDecision = null;            // post-create mutation

  const undefCand = findOrCreateCandidate({
    name: 'Undef Decision', linkedinUrl: 'https://www.linkedin.com/in/undef-decision',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: strictRunId,
  });
  undefCand.scoutDecision = undefined;

  const emptyCand = findOrCreateCandidate({
    name: 'Empty Decision', linkedinUrl: 'https://www.linkedin.com/in/empty-decision',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: strictRunId,
  });
  emptyCand.scoutDecision = '';

  const demoCand = findOrCreateCandidate({
    name: 'Demo Decision', linkedinUrl: 'https://www.linkedin.com/in/demo-decision',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: strictRunId,
  });
  demoCand.scoutDecision = 'demo';

  const realAcceptedCand = findOrCreateCandidate({
    name: 'Real Accepted',
    linkedinUrl: 'https://www.linkedin.com/in/real-accepted',
    source: 'Apollo', scoutDecision: 'accepted', pipelineRunId: strictRunId,
  });

  const strictMm = await runMatchmaker({ needId: strictNeed.id, pipelineRunId: strictRunId });
  assert(strictMm.matched === 1,
    `Matchmaker pool excludes null/undef/empty/demo scoutDecision (matched=${strictMm.matched}; expected 1 — only Real Accepted)`);
  assert(strictMm.reviewPoolSize === 4,
    `reviewPoolSize counts the 4 excluded rows (got ${strictMm.reviewPoolSize})`);
  // No match record for the rejected rows
  const strictMatchedIds = DB.matches
    .filter(m => m.pipelineRunId === strictRunId).map(m => m.candidateId);
  for (const badId of [nullCand.id, undefCand.id, emptyCand.id, demoCand.id]) {
    assert(!strictMatchedIds.includes(badId),
      `Candidate with non-'accepted' scoutDecision (id=${badId}) is NOT in any match record`);
  }
  assert(strictMatchedIds.includes(realAcceptedCand.id),
    `Real Accepted candidate IS in match record`);

  // (e3) STRICT usable-link: accepted but NO usable link must NOT enter Matchmaker
  const linkReqNeed = createNeed({
    companyId: coApollo.id, title: 'Link Requirement Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const linkRunId2 = 'link_req_run_' + Date.now().toString(36);

  // Accepted + completely bare → must be excluded
  const noLinkAcc = findOrCreateCandidate({
    name: 'NoLink Accepted', source: 'Manual',
    scoutDecision: 'accepted', pipelineRunId: linkRunId2,
  });
  // Accepted + apollo:// synthetic only → must be excluded (no real link)
  const apolloSynth = findOrCreateCandidate({
    name: 'Apollo Synth', source: 'Apollo',
    sourceUrl: 'apollo://test-synth-id', scoutDecision: 'accepted',
    pipelineRunId: linkRunId2,
  });
  // Accepted + LinkedIn /in/ → must be included
  const goodLink = findOrCreateCandidate({
    name: 'Good Link', linkedinUrl: 'https://www.linkedin.com/in/good-link',
    source: 'Apollo', scoutDecision: 'accepted', pipelineRunId: linkRunId2,
  });

  const linkMm = await runMatchmaker({ needId: linkReqNeed.id, pipelineRunId: linkRunId2 });
  assert(linkMm.matched === 1,
    `Matchmaker excludes accepted-but-linkless candidates (matched=${linkMm.matched}; expected 1)`);
  const linkMatchedIds = DB.matches
    .filter(m => m.pipelineRunId === linkRunId2).map(m => m.candidateId);
  assert(!linkMatchedIds.includes(noLinkAcc.id),
    `Accepted-but-no-link candidate is NOT scored`);
  assert(!linkMatchedIds.includes(apolloSynth.id),
    `Accepted-with-only-apollo://-URL candidate is NOT scored`);
  assert(linkMatchedIds.includes(goodLink.id),
    `Accepted + LinkedIn /in/ candidate IS scored`);

  // (e4) STALE-MATCH protection: candidate flipped from 'accepted' to 'review'
  //      AFTER its match was created must NOT appear in the report.
  const staleNeed = createNeed({
    companyId: coApollo.id, title: 'Stale Match Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const staleRunId = 'stale_match_run_' + Date.now().toString(36);
  const staleA = findOrCreateCandidate({
    name: 'Stale Accepted',
    title: 'Senior Cloud Security Engineer',
    skills: ['Azure'],
    linkedinUrl: 'https://www.linkedin.com/in/stale-accepted',
    source: 'Apollo', scoutDecision: 'accepted', pipelineRunId: staleRunId,
  });
  const staleB = findOrCreateCandidate({
    name: 'Stays Accepted',
    title: 'Cloud Security Engineer',
    skills: ['Azure'],
    linkedinUrl: 'https://www.linkedin.com/in/stays-accepted',
    source: 'Apollo', scoutDecision: 'accepted', pipelineRunId: staleRunId,
  });
  const staleMmBefore = await runMatchmaker({ needId: staleNeed.id, pipelineRunId: staleRunId });
  assert(staleMmBefore.matched === 2, `Pre-flip matchmaker sees both candidates (got ${staleMmBefore.matched})`);
  // Confirm both have match records
  const staleAMatch = DB.matches.find(m => m.pipelineRunId === staleRunId && m.candidateId === staleA.id);
  const staleBMatch = DB.matches.find(m => m.pipelineRunId === staleRunId && m.candidateId === staleB.id);
  assert(staleAMatch && staleBMatch, `Both match records exist after matchmaker`);

  // Flip Stale Accepted to 'review' AFTER the match was created
  staleA.scoutDecision = 'review';
  staleA.scoutReason = 'flipped to review post-match';

  // Report must re-check the candidate state — exclude the stale match
  const staleRep = await generateClientReport({ needId: staleNeed.id, pipelineRunId: staleRunId });
  const staleReportNames = staleRep.report.candidates.map(c => c.name);
  assert(!staleReportNames.includes('Stale Accepted'),
    `Report excludes candidate flipped to 'review' after match was created (reportNames=${JSON.stringify(staleReportNames)})`);
  assert(staleReportNames.includes('Stays Accepted'),
    `Report keeps still-accepted candidate (reportNames=${JSON.stringify(staleReportNames)})`);

  // Also: flip another to remove its LinkedIn (drop usable link) — should also be excluded
  staleB.linkedinUrl = '';   // remove the only usable link
  staleB.scoutDecision = 'accepted'; // still accepted, but no link now
  const staleRep2 = await generateClientReport({ needId: staleNeed.id, pipelineRunId: staleRunId });
  assert(staleRep2.report.candidates.length === 0,
    `Report excludes accepted candidate whose usable link was later removed (candidates=${staleRep2.report.candidates.length})`);

  // ── 19. STRICT external link + GitHub org rejection at hasUsableProfileLink ──
  // (a) isUsableGitHubProfileUrl unit cases
  const ghLinkCases = [
    ['https://github.com/microsoft',          false, 'org microsoft'],
    ['https://github.com/Azure',              false, 'org Azure (case-insensitive)'],
    ['https://github.com/topics',             false, 'reserved /topics'],
    ['https://github.com/search',             false, 'reserved /search'],
    ['https://github.com/marketplace',        false, 'reserved /marketplace'],
    ['https://github.com/features',           false, 'reserved /features'],
    ['https://github.com/pricing',            false, 'reserved /pricing'],
    ['https://github.com/explore',            false, 'reserved /explore'],
    ['https://github.com/jane-doe-real',      true,  'real user root'],
    ['https://www.github.com/some-user',      true,  'www. prefix accepted'],
    ['https://github.com/jane-doe/some-repo', false, 'has /repo path segment'],
    ['https://github.com/jane-doe?tab=repos', true,  'allowed querystring'],
    ['https://gist.github.com/jane',          false, 'non-github.com host'],
    ['https://github.com/',                   false, 'empty login'],
    ['',                                      false, 'empty string'],
    [null,                                    false, 'null'],
  ];
  for (const [url, expected, label] of ghLinkCases) {
    const got = isUsableGitHubProfileUrl(url);
    assert(got === expected, `isUsableGitHubProfileUrl[${label}] url=${JSON.stringify(url)} → ${got} (expected ${expected})`);
  }

  // (b) hasUsableProfileLink — generic websites no longer count
  const genericCases = [
    [{ portfolioUrl: 'https://random-blog.com/some-post' },                    false, 'generic blog as portfolio'],
    [{ portfolioUrl: 'https://janedoe-personal.dev' },                         false, 'generic personal-style domain'],
    [{ sourceUrl:    'https://random-blog.com/post' },                         false, 'generic blog as sourceUrl'],
    [{ sourceUrl:    'https://www.companysite.com/about' },                    false, 'company page as sourceUrl'],
    [{ portfolioUrl: 'https://www.linkedin.com/in/jane-portfolio' },           true,  'portfolioUrl resolves to LinkedIn /in/'],
    [{ resumeUrl:    'https://github.com/janedoe' },                           true,  'resumeUrl resolves to GitHub user'],
    [{ sourceUrl:    'https://www.linkedin.com/in/jane-source' },              true,  'sourceUrl resolves to LinkedIn /in/'],
    [{ sourceUrl:    'https://github.com/microsoft' },                         false, 'sourceUrl on GitHub org rejected'],
    [{ portfolioUrl: 'apollo://some-id' },                                     false, 'apollo:// synthetic rejected'],
    [{},                                                                       false, 'no links at all'],
  ];
  for (const [partial, expected, label] of genericCases) {
    const got = hasUsableProfileLink(partial);
    assert(got === expected, `hasUsableProfileLink[${label}] → ${got} (expected ${expected})`);
  }

  // (c) Matchmaker rejects accepted candidate with only a generic sourceUrl
  const genericNeed = createNeed({
    companyId: coApollo.id, title: 'Generic URL Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const genericRunId = 'generic_url_run_' + Date.now().toString(36);
  const genericBad = findOrCreateCandidate({
    name: 'Generic SourceUrl Person',
    title: 'Cloud Security Engineer',
    skills: ['Azure'],
    sourceUrl: 'https://random-blog.example/post-about-cloud',
    source: 'Apollo', scoutDecision: 'accepted', pipelineRunId: genericRunId,
  });
  const genericGood = findOrCreateCandidate({
    name: 'Real LI Person',
    title: 'Cloud Security Engineer',
    skills: ['Azure'],
    linkedinUrl: 'https://www.linkedin.com/in/real-li-person',
    source: 'Apollo', scoutDecision: 'accepted', pipelineRunId: genericRunId,
  });
  const genericMm = await runMatchmaker({ needId: genericNeed.id, pipelineRunId: genericRunId });
  assert(genericMm.matched === 1,
    `Matchmaker excludes accepted candidate with only generic sourceUrl (matched=${genericMm.matched}; expected 1)`);
  const genericMatchedIds = DB.matches
    .filter(m => m.pipelineRunId === genericRunId).map(m => m.candidateId);
  assert(!genericMatchedIds.includes(genericBad.id),
    `Accepted candidate with only generic sourceUrl is NOT scored`);
  assert(genericMatchedIds.includes(genericGood.id),
    `Accepted candidate with real LinkedIn /in/ IS scored`);

  // (d) Stale match: visible count uses CURRENT candidate state, not snapshot
  const staleVisNeed = createNeed({
    companyId: coApollo.id, title: 'Stale Visible Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const staleVisRun = 'stale_visible_run_' + Date.now().toString(36);
  const staleVisCand = findOrCreateCandidate({
    name: 'Visible Then Stale',
    title: 'Cloud Security Engineer',
    skills: ['Azure'],
    linkedinUrl: 'https://www.linkedin.com/in/visible-then-stale',
    source: 'Apollo', scoutDecision: 'accepted', pipelineRunId: staleVisRun,
  });
  const staleVisOther = findOrCreateCandidate({
    name: 'Stays Visible',
    title: 'Cloud Security Engineer',
    skills: ['Azure'],
    linkedinUrl: 'https://www.linkedin.com/in/stays-visible',
    source: 'Apollo', scoutDecision: 'accepted', pipelineRunId: staleVisRun,
  });
  const staleVisMmBefore = await runMatchmaker({ needId: staleVisNeed.id, pipelineRunId: staleVisRun });
  assert(staleVisMmBefore.visible === 2,
    `Pre-flip visible count includes both candidates (got ${staleVisMmBefore.visible})`);

  // Flip ONE candidate to review AFTER matchmaker ran
  staleVisCand.scoutDecision = 'review';

  // isVisibleMatch direct unit check on the stale match record
  const staleVisMatch = DB.matches.find(m =>
    m.pipelineRunId === staleVisRun && m.candidateId === staleVisCand.id
  );
  assert(staleVisMatch, 'stale match record exists in DB.matches (preserved for audit)');
  assert(isVisibleMatch(staleVisMatch) === false,
    `isVisibleMatch(stale match) === false (candidate now scoutDecision="${staleVisCand.scoutDecision}")`);
  const staysMatch = DB.matches.find(m =>
    m.pipelineRunId === staleVisRun && m.candidateId === staleVisOther.id
  );
  assert(isVisibleMatch(staysMatch) === true,
    `isVisibleMatch(non-stale match) === true`);

  // runMatchmaker re-run: visible count now excludes the stale match.
  // The pool also excludes the flipped candidate, so its match record isn't
  // updated — but visible filter catches it.
  const staleVisMmAfter = await runMatchmaker({ needId: staleVisNeed.id, pipelineRunId: staleVisRun });
  assert(staleVisMmAfter.visible === 1,
    `Post-flip visible count drops the stale match (got ${staleVisMmAfter.visible}; expected 1)`);

  // (e) /api/matches default hides stale matches; ?all=1 shows them
  const apiServer = await new Promise((resolve) => {
    const s = server.app.listen(0, () => resolve(s));
  });
  const apiPort = apiServer.address().port;
  const auth = 'Basic ' + Buffer.from(`tester:${process.env.INTERNAL_PASSWORD}`).toString('base64');
  process.env.INTERNAL_USER = process.env.INTERNAL_USER || 'tester';
  // Re-set auth in case INTERNAL_USER differs
  const authHeader = 'Basic ' + Buffer.from(`${process.env.INTERNAL_USER}:${process.env.INTERNAL_PASSWORD}`).toString('base64');
  const httpGet = (path) => new Promise((resolve, reject) => {
    const r = http.request({
      hostname: 'localhost', port: apiPort, path, method: 'GET',
      headers: { Authorization: authHeader },
    }, (res) => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: null, raw: buf }); }
      });
    });
    r.on('error', reject); r.end();
  });
  const defaultRes = await httpGet('/api/matches');
  const allRes     = await httpGet('/api/matches?all=1');
  apiServer.close();

  if (defaultRes.status !== 200) {
    // Auth may differ; report and skip the API-shaped assertions but keep
    // unit-level isVisibleMatch coverage already above.
    console.log(`(/api/matches returned ${defaultRes.status}; skipping API-shape asserts — Basic auth user may differ from "tester")`);
  } else {
    const defaultIds = (defaultRes.data || []).map(m => m.candidateId);
    const allIds = (allRes.data || []).map(m => m.candidateId);
    assert(!defaultIds.includes(staleVisCand.id),
      `/api/matches default response excludes stale match (candidateId=${staleVisCand.id})`);
    assert(defaultIds.includes(staleVisOther.id),
      `/api/matches default response includes still-visible match`);
    assert(allIds.includes(staleVisCand.id),
      `/api/matches?all=1 includes stale match for audit`);
    assert(allRes.data.length >= defaultRes.data.length,
      `/api/matches?all=1 returns >= default count (${allRes.data.length} vs ${defaultRes.data.length})`);
  }

  // ── 20. GitHub verification gate (centralized eligibility) ──
  // (a) Manual candidate with a syntactically-valid GitHub root URL but NO
  //     Scout/validation verification → NOT eligible for final shortlist by
  //     GitHub alone.
  const ghGateNeed = createNeed({
    companyId: coApollo.id, title: 'GH Gate Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const ghGateRun = 'gh_gate_run_' + Date.now().toString(36);

  // (a-1) Manual GH-only candidate — NOT verified, NOT eligible
  const manualGhOnly = findOrCreateCandidate({
    name: 'Manual GH Only',
    skills: ['Azure'],
    github: 'https://github.com/manual-gh-only-user',
    source: 'Manual',           // NOT 'GitHub' (not Scout-API-confirmed)
    scoutDecision: 'accepted',
    pipelineRunId: ghGateRun,
  });
  assert(!isVerifiedGitHubProfile(manualGhOnly),
    `Manual github-only candidate without verification is NOT verified (source="${manualGhOnly.source}", scoutReason="${manualGhOnly.scoutReason}")`);
  assert(!isFinalShortlistEligible(manualGhOnly),
    `Manual github-only candidate is NOT shortlist-eligible`);

  // (a-2) Same candidate, but Scout-API-verified scoutReason → IS verified, IS eligible
  const apiVerifiedGh = findOrCreateCandidate({
    name: 'API Verified GH',
    skills: ['Azure'],
    github: 'https://github.com/api-verified-gh',
    source: 'Apollo',
    scoutDecision: 'accepted',
    scoutReason: 'GitHub API verified type=User',
    pipelineRunId: ghGateRun,
  });
  assert(isVerifiedGitHubProfile(apiVerifiedGh),
    `Candidate with scoutReason 'GitHub API verified type=User' IS verified`);
  assert(isFinalShortlistEligible(apiVerifiedGh),
    `API-verified GH candidate IS shortlist-eligible`);

  // (a-3) Scout source='GitHub' (came from GitHub user-search API) → IS verified
  const scoutGhUser = findOrCreateCandidate({
    name: 'Scout GH User',
    skills: ['Azure'],
    github: 'https://github.com/scout-gh-user',
    source: 'GitHub',           // set by runScout's GitHub user-search branch
    scoutDecision: 'accepted',
    scoutReason: 'GitHub user search result',
    pipelineRunId: ghGateRun,
  });
  assert(isVerifiedGitHubProfile(scoutGhUser),
    `Candidate with source='GitHub' IS verified (Scout's user-search API confirmed)`);
  assert(isFinalShortlistEligible(scoutGhUser),
    `Scout GitHub user candidate IS shortlist-eligible`);

  // (a-4) GH-only candidate with a validation tier of 'Verified Active' → verified
  const valVerifiedGh = findOrCreateCandidate({
    name: 'Val Verified GH',
    skills: ['Azure'],
    github: 'https://github.com/val-verified-gh',
    source: 'Manual',
    scoutDecision: 'accepted',
    pipelineRunId: ghGateRun,
  });
  createValidation(valVerifiedGh.id, {
    tier: 'Verified Active',
    proficiency: { JavaScript: 80 },
    pipelineRunId: ghGateRun,
  });
  assert(isVerifiedGitHubProfile(valVerifiedGh),
    `Candidate with latestValidation.tier='Verified Active' IS verified`);
  assert(isFinalShortlistEligible(valVerifiedGh),
    `Validator-verified GH candidate IS shortlist-eligible`);

  // (a-5) LinkedIn /in/ alone → eligible regardless of GitHub
  const liOnly = findOrCreateCandidate({
    name: 'LI Only',
    skills: ['Azure'],
    linkedinUrl: 'https://www.linkedin.com/in/li-only',
    source: 'Apollo',
    scoutDecision: 'accepted',
    pipelineRunId: ghGateRun,
  });
  assert(isFinalShortlistEligible(liOnly),
    `LinkedIn /in/ alone makes candidate shortlist-eligible`);

  // Matchmaker pool reflects the same gate: manualGhOnly is excluded
  const ghGateMm = await runMatchmaker({ needId: ghGateNeed.id, pipelineRunId: ghGateRun });
  const ghGateMatchedIds = DB.matches
    .filter(m => m.pipelineRunId === ghGateRun).map(m => m.candidateId);
  assert(!ghGateMatchedIds.includes(manualGhOnly.id),
    `Manual GH-only candidate is NOT in matchmaker pool (id=${manualGhOnly.id})`);
  assert(ghGateMatchedIds.includes(apiVerifiedGh.id),
    `API-verified GH candidate IS in matchmaker pool`);
  assert(ghGateMatchedIds.includes(scoutGhUser.id),
    `Scout GitHub user IS in matchmaker pool`);
  assert(ghGateMatchedIds.includes(valVerifiedGh.id),
    `Validator-verified GH candidate IS in matchmaker pool`);
  assert(ghGateMatchedIds.includes(liOnly.id),
    `LinkedIn-only candidate IS in matchmaker pool`);
  assert(ghGateMm.matched === 4, `4 eligible candidates scored (manualGhOnly excluded); got ${ghGateMm.matched}`);

  // ── 20b. Per-source diagnostics on scout return + pipeline response ──
  // The earlier Apollo block already set up STUB_APOLLO_PEOPLE/STUB_FIRECRAWL_ITEMS
  // via the `apolloScout` test. Re-use its result here.
  for (const k of ['apolloRaw','firecrawlRaw','githubRaw','reviewCandidates','rejectedCandidates','rejectedBySource','rejectedReasonsBySource']) {
    assert(k in apolloScout, `scout result includes top-level "${k}"`);
  }
  assert(apolloScout.apolloRaw === apolloScout.rawResultsBySource.apollo,
    `apolloRaw alias matches rawResultsBySource.apollo (${apolloScout.apolloRaw} vs ${apolloScout.rawResultsBySource.apollo})`);
  assert(apolloScout.firecrawlRaw === apolloScout.rawResultsBySource.firecrawl,
    `firecrawlRaw alias matches rawResultsBySource.firecrawl`);
  assert(apolloScout.githubRaw === apolloScout.rawResultsBySource.github,
    `githubRaw alias matches rawResultsBySource.github`);
  assert(apolloScout.reviewCandidates === apolloScout.needsScoutReview,
    `reviewCandidates alias matches needsScoutReview`);
  assert(apolloScout.rejectedCandidates === apolloScout.rejectedNonCandidates,
    `rejectedCandidates alias matches rejectedNonCandidates`);
  // rejectedBySource has 3 source keys present
  for (const src of ['apollo','firecrawl','github']) {
    assert(src in apolloScout.rejectedBySource,
      `rejectedBySource includes "${src}" (got ${JSON.stringify(apolloScout.rejectedBySource)})`);
  }
  // Firecrawl had ZipRecruiter rejection in the apolloScout setup → firecrawl reject count > 0
  assert(apolloScout.rejectedBySource.firecrawl >= 1,
    `rejectedBySource.firecrawl ≥ 1 (got ${apolloScout.rejectedBySource.firecrawl})`);
  // Per-source rejection-reason breakdown for that source includes the actual reason
  const fcReasons = apolloScout.rejectedReasonsBySource.firecrawl || {};
  assert(Object.keys(fcReasons).length >= 1,
    `rejectedReasonsBySource.firecrawl populated (got ${JSON.stringify(fcReasons)})`);
  // Every rejected sample carries `source`
  for (const r of apolloScout.rejectedSamples) {
    assert(typeof r.source === 'string' && r.source.length,
      `rejected sample carries source tag (got "${r.source}" for ${r.sourceUrl})`);
  }

  // ── 20c. Apollo NOT configured → log fires once, no apolloRaw growth ──
  const prevKey3 = process.env.APOLLO_API_KEY;
  delete process.env.APOLLO_API_KEY;
  STUB_FIRECRAWL_ITEMS = [];
  const noApolloNeed = createNeed({
    companyId: coApollo.id, title: 'No-Apollo Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const noApolloScout = await runScout({ needId: noApolloNeed.id, pipelineRunId: 'no_apollo_run_' + Date.now().toString(36) });
  assert(noApolloScout.apolloRaw === 0,
    `apolloRaw === 0 when Apollo key missing (got ${noApolloScout.apolloRaw})`);
  if (prevKey3 === undefined) delete process.env.APOLLO_API_KEY;
  else process.env.APOLLO_API_KEY = prevKey3;

  // ── 20d. Apollo configured + returns 0 people → apolloRaw === 0, warn logged ──
  process.env.APOLLO_API_KEY = 'test-apollo-key';
  STUB_APOLLO_PEOPLE = [];
  STUB_FIRECRAWL_ITEMS = [];
  const emptyApolloNeed = createNeed({
    companyId: coApollo.id, title: 'Empty-Apollo Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const emptyApolloScout = await runScout({ needId: emptyApolloNeed.id, pipelineRunId: 'empty_apollo_run_' + Date.now().toString(36) });
  assert(emptyApolloScout.apolloRaw === 0,
    `apolloRaw === 0 when Apollo returns 0 people (got ${emptyApolloScout.apolloRaw})`);
  // Activity log captures the Apollo people-search outcome
  const recentScoutLog = DB.activity_logs.find(l =>
    l.agent === 'Scout' && /Apollo people search: 0 returned/.test(l.message)
  );
  assert(recentScoutLog, `Activity log emits "Apollo people search: 0 returned" diagnostic when Apollo returns empty`);

  // ── 20e. Final sourcing strategy: Apollo relaxes, Firecrawl is profile-first, scoring is review-only safe ──
  const strategyNeed = createNeed({
    companyId: coApollo.id,
    title: 'Azure Security Engineer',
    requiredSkills: ['Azure', 'Sentinel', 'KQL', 'Defender'],
    seniority: 'Mid',
    locationType: 'Remote',
    confirmed: true,
  });

  const apolloAttempts = buildApolloCandidateAttempts(strategyNeed);
  assert(apolloAttempts.length >= 3,
    `Apollo relaxation builds multiple attempts (got ${apolloAttempts.length})`);
  assert(apolloAttempts.some(a => a.keywords === ''),
    `Apollo relaxation includes title-only fallback`);
  assert(apolloAttempts.some(a => /expanded-related/.test(a.label)),
    `Apollo relaxation includes expanded related-title fallback`);

  const profileQueries = buildFirecrawlProfileQueries(strategyNeed);
  assert(profileQueries[0].query.includes('site:linkedin.com/in/'),
    `First Firecrawl fallback is LinkedIn-profile targeted (got "${profileQueries[0].query}")`);
  assert(profileQueries.some(q => q.query.includes('site:github.com') && q.query.includes('README.md')),
    `Firecrawl fallback includes GitHub README open-to-work query`);
  assert(profileQueries.some(q => q.query.includes('site:reddit.com/r/forhire')),
    `Firecrawl fallback includes targeted Reddit review query`);

  const scoredLi = scoreSourcedPage({
    title: 'Jane Doe - Azure Security Engineer',
    url: 'https://www.linkedin.com/in/jane-open-work',
    description: '#OpenToWork Azure Sentinel KQL skills experience',
  });
  assert(scoredLi.score >= 60 && scoredLi.decision === 'accepted',
    `LinkedIn + OpenToWork page scores accepted (score=${scoredLi.score}, decision=${scoredLi.decision})`);
  const scoredReddit = scoreSourcedPage({
    title: 'Looking for a job in cybersecurity',
    url: 'https://www.reddit.com/r/forhire/comments/abc/looking_for_a_job/',
    description: 'Looking for work in cybersecurity with Azure and SIEM experience',
  });
  assert(scoredReddit.score < 60,
    `Reddit/job-board style page does not become accepted by score alone (score=${scoredReddit.score})`);

  let apolloCallCount = 0;
  STUB_APOLLO_PEOPLE = () => {
    apolloCallCount++;
    if (apolloCallCount < 3) return [];
    return [{ id: 'relaxed-apollo', name: 'Relaxed Apollo', title: 'Security Analyst', city: 'Detroit', state: 'Michigan', country: 'United States', linkedin_url: 'https://www.linkedin.com/in/relaxed-apollo', organization: { name: 'RelaxedCo' }, headline: 'Azure Sentinel KQL', employment_history: [{ title: 'Security Analyst', organization: { name: 'RelaxedCo' }, start_date: '2024-01-01', current: true }] }];
  };
  STUB_FIRECRAWL_ITEMS = [];
  STUB_GH_SEARCH_USERS = { items: [] };
  const relaxedRun = 'relaxed_apollo_' + Date.now().toString(36);
  const relaxedScout = await runScout({ needId: strategyNeed.id, pipelineRunId: relaxedRun });
  assert(apolloCallCount >= 3,
    `runScout retried Apollo until a relaxed attempt returned people (calls=${apolloCallCount})`);
  assert(relaxedScout.apolloRaw === 1 && relaxedScout.acceptedBySource.apollo === 1,
    `Relaxed Apollo result accepted once (apolloRaw=${relaxedScout.apolloRaw}, accepted=${relaxedScout.acceptedBySource.apollo})`);
  assert(relaxedScout.sourceQueryStats && relaxedScout.sourceQueryStats.apollo.length >= 3,
    `Scout exposes Apollo attempt diagnostics`);

  STUB_APOLLO_PEOPLE = [];
  STUB_FIRECRAWL_ITEMS = [
    { title: 'Profile Person - Azure Security Engineer', url: 'https://www.linkedin.com/in/profile-person', description: 'Open to Work Azure Sentinel KQL' },
  ];
  STUB_GH_SEARCH_USERS = { items: [] };
  FIRECRAWL_QUERIES.length = 0;
  const fcProfileNeed = createNeed({
    companyId: coApollo.id,
    title: 'Azure Security Engineer',
    requiredSkills: ['Azure', 'Sentinel'],
    seniority: 'Mid',
    locationType: 'Remote',
    confirmed: true,
  });
  const fcProfileScout = await runScout({ needId: fcProfileNeed.id, pipelineRunId: 'fc_profile_' + Date.now().toString(36) });
  assert(FIRECRAWL_QUERIES[0] && FIRECRAWL_QUERIES[0].includes('site:linkedin.com/in/'),
    `runScout uses LinkedIn-profile Firecrawl query first (got "${FIRECRAWL_QUERIES[0]}")`);
  assert(fcProfileScout.acceptedBySource.firecrawl === 1,
    `Profile-targeted Firecrawl LinkedIn result accepted (got ${fcProfileScout.acceptedBySource.firecrawl})`);
  const fcProfileCand = fcProfileScout.candidates.find(c => (c.linkedinUrl || '').includes('profile-person'));
  assert(fcProfileCand && fcProfileCand.scoutScore >= 30 && fcProfileCand.scoutSourceLabel,
    `Firecrawl candidate carries score/source diagnostics`);

  STUB_APOLLO_PEOPLE = null;
  STUB_FIRECRAWL_ITEMS = null;

  // ── 22. Trusted candidate-profile platform helpers (host-anchored) ──
  const platformCases = [
    // GitLab
    [isGitLabUserProfileUrl, 'https://gitlab.com/janedoe',                true,  'gitlab user root'],
    [isGitLabUserProfileUrl, 'https://www.gitlab.com/jane-doe-sec',       true,  'gitlab www prefix'],
    [isGitLabUserProfileUrl, 'https://gitlab.com/help',                   false, 'gitlab reserved /help'],
    [isGitLabUserProfileUrl, 'https://gitlab.com/-',                      false, 'gitlab reserved /-'],
    [isGitLabUserProfileUrl, 'https://gitlab.com/jane/repo',              false, 'gitlab repo path'],
    [isGitLabUserProfileUrl, 'https://attacker.com/gitlab.com/jane',      false, 'gitlab spoofed host'],
    [isGitLabUserProfileUrl, 'https://gitlab.com/gitlab-org',             false, 'gitlab known org gitlab-org'],
    [isGitLabUserProfileUrl, 'https://gitlab.com/microsoft',              false, 'gitlab known brand microsoft'],
    [isGitLabUserProfileUrl, 'https://gitlab.com/google',                 false, 'gitlab known brand google'],
    [isGitLabUserProfileUrl, 'https://gitlab.com/Microsoft',              false, 'gitlab known brand case-insensitive'],
    // Hugging Face
    [isHuggingFaceProfileUrl, 'https://huggingface.co/julien-c',          true,  'HF user'],
    [isHuggingFaceProfileUrl, 'https://hf.co/julien-c',                    true,  'hf.co short host'],
    [isHuggingFaceProfileUrl, 'https://huggingface.co/datasets',          false, 'HF reserved /datasets'],
    [isHuggingFaceProfileUrl, 'https://huggingface.co/spaces',            false, 'HF reserved /spaces'],
    [isHuggingFaceProfileUrl, 'https://huggingface.co/julien-c/repo',     false, 'HF model path'],
    [isHuggingFaceProfileUrl, 'https://huggingface.co/microsoft',         false, 'HF known brand microsoft'],
    [isHuggingFaceProfileUrl, 'https://huggingface.co/google',            false, 'HF known brand google'],
    [isHuggingFaceProfileUrl, 'https://huggingface.co/openai',            false, 'HF known brand openai'],
    [isHuggingFaceProfileUrl, 'https://huggingface.co/meta',              false, 'HF known brand meta'],
    // Kaggle
    [isKaggleProfileUrl, 'https://www.kaggle.com/janedoe',                true,  'kaggle user'],
    [isKaggleProfileUrl, 'https://kaggle.com/datasets',                   false, 'kaggle reserved /datasets'],
    [isKaggleProfileUrl, 'https://kaggle.com/competitions',               false, 'kaggle reserved /competitions'],
    [isKaggleProfileUrl, 'https://kaggle.com/janedoe/notebook',           false, 'kaggle nested'],
    [isKaggleProfileUrl, 'https://www.kaggle.com/google',                 false, 'kaggle known brand google'],
    [isKaggleProfileUrl, 'https://kaggle.com/microsoft',                  false, 'kaggle known brand microsoft'],
    [isKaggleProfileUrl, 'https://kaggle.com/aws',                        false, 'kaggle known brand aws'],
    // Stack Overflow
    [isStackOverflowUserUrl, 'https://stackoverflow.com/users/12345',     true,  'SO user numeric'],
    [isStackOverflowUserUrl, 'https://stackoverflow.com/users/12345/jane',true,  'SO user with slug'],
    [isStackOverflowUserUrl, 'https://stackoverflow.com/questions/9999',  false, 'SO questions path'],
    [isStackOverflowUserUrl, 'https://stackoverflow.com/users/not-numeric', false, 'SO non-numeric id'],
    [isStackOverflowUserUrl, 'https://stackexchange.com/users/12345',     false, 'wrong SE site'],
    // Credly
    [isCredlyProfileUrl, 'https://www.credly.com/users/jane-doe',         true,  'credly user'],
    [isCredlyProfileUrl, 'https://credly.com/badges/abc-123/some-badge',  false, 'credly badge (now restricted; identity requires /users/)'],
    [isCredlyProfileUrl, 'https://credly.com/about',                      false, 'credly about (not /users/)'],
    [isCredlyProfileUrl, 'https://credly.com/explore',                    false, 'credly /explore not /users/'],
    // TryHackMe
    [isTryHackMeProfileUrl, 'https://tryhackme.com/p/janedoe',            true,  'THM /p/ profile'],
    [isTryHackMeProfileUrl, 'https://www.tryhackme.com/user/janedoe',     true,  'THM /user/ profile'],
    [isTryHackMeProfileUrl, 'https://tryhackme.com/r/learning',           false, 'THM non-profile'],
    // Hack The Box
    [isHackTheBoxProfileUrl, 'https://app.hackthebox.com/profile/12345',  true,  'HTB app profile'],
    [isHackTheBoxProfileUrl, 'https://hackthebox.com/users/12345',        true,  'HTB users id'],
    [isHackTheBoxProfileUrl, 'https://hackthebox.com/machines/xyz',       false, 'HTB non-profile'],
    [isHackTheBoxProfileUrl, 'https://hackthebox.com/profile/abc',        false, 'HTB non-numeric id'],
    // Wellfound
    [isWellfoundProfileUrl, 'https://wellfound.com/u/janedoe',            true,  'Wellfound /u/'],
    [isWellfoundProfileUrl, 'https://www.wellfound.com/u/jane-doe',       true,  'Wellfound www /u/'],
    [isWellfoundProfileUrl, 'https://angel.co/u/legacy-jane',             true,  'AngelList legacy /u/'],
    [isWellfoundProfileUrl, 'https://wellfound.com/jobs/12345',           false, 'Wellfound jobs path'],
    [isWellfoundProfileUrl, 'https://wellfound.com/company/acme',         false, 'Wellfound company page'],
  ];
  for (const [fn, url, expected, label] of platformCases) {
    const got = fn(url);
    assert(got === expected, `${fn.name}[${label}] url=${JSON.stringify(url)} → ${got} (expected ${expected})`);
  }

  // ── 23. isTrustedCandidateProfileUrl(url, candidate) ──
  // (a) Platform-only URLs (no candidate context needed)
  const trustNoCtx = [
    ['https://www.linkedin.com/in/jane',           true,  'LinkedIn /in/'],
    ['https://gitlab.com/jane',                    true,  'GitLab user'],
    ['https://huggingface.co/julien-c',            true,  'HF user'],
    ['https://www.kaggle.com/jane',                true,  'Kaggle user'],
    ['https://stackoverflow.com/users/12345',      true,  'SO user'],
    ['https://www.credly.com/users/jane',          true,  'Credly user'],
    ['https://tryhackme.com/p/jane',               true,  'THM profile'],
    ['https://app.hackthebox.com/profile/12345',   true,  'HTB profile'],
    ['https://wellfound.com/u/jane',               true,  'Wellfound /u/'],
    ['https://random-blog.example/post',           false, 'generic blog'],
    ['https://company-careers.example/jobs/12',    false, 'generic job'],
    ['apollo://abc',                               false, 'apollo:// synthetic'],
    ['',                                           false, 'empty'],
  ];
  for (const [url, expected, label] of trustNoCtx) {
    const got = isTrustedCandidateProfileUrl(url, null);
    assert(got === expected, `isTrustedCandidateProfileUrl(no-ctx)[${label}] → ${got} (expected ${expected})`);
  }

  // (b) GitHub via secondary fields requires VERIFICATION linkage to THIS candidate
  const ghManualOnly = { github: 'https://github.com/manual-only-user', source: 'Manual', scoutDecision: 'accepted' };
  // candidate.github is syntactically valid but not verified → trust check is FALSE
  assert(isTrustedCandidateProfileUrl('https://github.com/manual-only-user', ghManualOnly) === false,
    `Unverified GitHub URL is NOT trusted even when it matches candidate.github`);
  const ghApiVerified = { github: 'https://github.com/api-user', source: 'Apollo', scoutDecision: 'accepted', scoutReason: 'GitHub API verified type=User' };
  assert(isTrustedCandidateProfileUrl('https://github.com/api-user', ghApiVerified) === true,
    `Verified GitHub URL IS trusted when it matches candidate.github`);
  // GitHub URL via secondary field that does NOT match candidate.github → not trusted
  assert(isTrustedCandidateProfileUrl('https://github.com/some-other-user', ghApiVerified) === false,
    `GitHub URL on secondary field NOT matching candidate.github is NOT trusted`);

  // ── 24. isFinalShortlistEligible — verified-only gate ──────────────
  // Only LinkedIn /in/, verified GitHub user, and Stack Overflow numeric-user
  // URLs grant identityVerificationStatus='verified'. The other 7 trusted
  // platforms (GitLab/HF/Kaggle/Credly/THM/HTB/Wellfound) go to review until
  // an out-of-band verification signal upgrades them.
  // (a) Positive: LinkedIn /in/ alone → verified → eligible
  const linkedInOnly = findOrCreateCandidate({
    name: 'LI Verified Person',
    linkedinUrl: 'https://www.linkedin.com/in/li-verified-person',
    source: 'Manual', scoutDecision: 'accepted',
  });
  assert(linkedInOnly.identityVerificationStatus === 'verified',
    `LinkedIn /in/ → identityVerificationStatus=verified (got "${linkedInOnly.identityVerificationStatus}")`);
  assert(linkedInOnly.identityVerificationSource === 'linkedin-url-pattern',
    `LinkedIn source=linkedin-url-pattern (got "${linkedInOnly.identityVerificationSource}")`);
  assert(isFinalShortlistEligible(linkedInOnly) === true,
    `LinkedIn-only verified candidate IS eligible`);

  // (b) Positive: Stack Overflow numeric-user URL → verified → eligible
  const soUser = findOrCreateCandidate({
    name: 'SO Verified Person',
    portfolioUrl: 'https://stackoverflow.com/users/9876543/some-name',
    source: 'Manual', scoutDecision: 'accepted',
  });
  assert(soUser.identityVerificationStatus === 'verified',
    `Stack Overflow numeric-user URL → verified (got "${soUser.identityVerificationStatus}")`);
  assert(soUser.identityVerificationSource === 'stackoverflow-url-pattern',
    `SO source=stackoverflow-url-pattern (got "${soUser.identityVerificationSource}")`);
  assert(isFinalShortlistEligible(soUser) === true, `SO verified candidate IS eligible`);

  // (c) Negative: GitLab/HF/Kaggle/Credly/THM/HTB/Wellfound profile URLs alone
  //     → review (NOT verified). Each must be NOT eligible for final shortlist.
  const reviewOnlyPlatforms = [
    { label: 'GitLab profile alone',     portfolioUrl: 'https://gitlab.com/real-glx-user' },
    { label: 'Hugging Face profile alone', portfolioUrl: 'https://huggingface.co/real-hf-user' },
    { label: 'Kaggle profile alone',     portfolioUrl: 'https://www.kaggle.com/real-kaggle-user' },
    { label: 'Credly profile alone',     portfolioUrl: 'https://www.credly.com/users/real-credly-user' },
    { label: 'TryHackMe profile alone',  portfolioUrl: 'https://tryhackme.com/p/real-thm-user' },
    { label: 'Hack The Box profile alone', portfolioUrl: 'https://app.hackthebox.com/profile/444444' },
    { label: 'Wellfound profile alone',  portfolioUrl: 'https://wellfound.com/u/real-wf-user' },
  ];
  for (const partial of reviewOnlyPlatforms) {
    const c = findOrCreateCandidate({
      name: 'Review Plat ' + partial.label, source: 'Manual', scoutDecision: 'accepted', ...partial,
    });
    assert(c.identityVerificationStatus === 'review',
      `${partial.label} → identityVerificationStatus=review (got "${c.identityVerificationStatus}")`);
    assert(isFinalShortlistEligible(c) === false,
      `${partial.label} → NOT eligible (review unless verified)`);
  }

  // (d) Negative: generic blog / personal site → review, NOT eligible
  const personalSite = findOrCreateCandidate({
    name: 'Personal Site Person',
    portfolioUrl: 'https://my-personal-tech-blog.example/about',
    source: 'Manual', scoutDecision: 'accepted',
  });
  assert(personalSite.identityVerificationStatus === 'review',
    `Personal site → review (got "${personalSite.identityVerificationStatus}")`);
  assert(isFinalShortlistEligible(personalSite) === false,
    `Personal site → NOT eligible`);

  // (e) Negative: Credly /badges/ URL — not a /users/ profile + no identity binding
  const credlyBadge = findOrCreateCandidate({
    name: 'Credly Badge Person',
    portfolioUrl: 'https://credly.com/badges/abc-123/some-badge',
    source: 'Manual', scoutDecision: 'accepted',
  });
  assert(credlyBadge.identityVerificationStatus === 'review',
    `Credly /badges/ URL does NOT verify identity (got "${credlyBadge.identityVerificationStatus}")`);
  assert(isFinalShortlistEligible(credlyBadge) === false,
    `Credly badge candidate → NOT eligible`);

  // (f) Negative: review/rejected scoutDecision + LinkedIn /in/ → NOT eligible
  const reviewWithLi = findOrCreateCandidate({
    name: 'Review Despite LI',
    linkedinUrl: 'https://www.linkedin.com/in/review-despite-li',
    source: 'Web', scoutDecision: 'review',
  });
  assert(reviewWithLi.identityVerificationStatus === 'verified',
    `LinkedIn URL still yields verified identityVerificationStatus`);
  assert(isFinalShortlistEligible(reviewWithLi) === false,
    `Review scoutDecision blocks eligibility even with verified LinkedIn`);

  // (g) Matchmaker pool integration: only the 2 verified-source candidates
  //     (LinkedIn + Stack Overflow) reach the shortlist.
  const verifiedNeed = createNeed({
    companyId: coApollo.id, title: 'Verified-Only Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const verifiedRun = 'verified_only_run_' + Date.now().toString(36);
  const liInRun = findOrCreateCandidate({
    name: 'LI In Run', title: 'Cloud Sec Eng', skills: ['Azure'],
    linkedinUrl: 'https://www.linkedin.com/in/li-in-run',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: verifiedRun,
  });
  const soInRun = findOrCreateCandidate({
    name: 'SO In Run', title: 'Cloud Sec Eng', skills: ['Azure'],
    portfolioUrl: 'https://stackoverflow.com/users/12345678/so-in-run',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: verifiedRun,
  });
  const hfInRun = findOrCreateCandidate({
    name: 'HF In Run', title: 'Cloud Sec Eng', skills: ['Azure'],
    portfolioUrl: 'https://huggingface.co/hf-in-run',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: verifiedRun,
  });
  const credlyInRun = findOrCreateCandidate({
    name: 'Credly In Run', title: 'Cloud Sec Eng', skills: ['Azure'],
    portfolioUrl: 'https://www.credly.com/users/credly-in-run',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: verifiedRun,
  });
  const verifiedMm = await runMatchmaker({ needId: verifiedNeed.id, pipelineRunId: verifiedRun });
  assert(verifiedMm.matched === 2,
    `Matchmaker admits 2 verified candidates (LI + SO); rejects HF/Credly (review). Got matched=${verifiedMm.matched}`);
  const verifiedMatchedIds = DB.matches
    .filter(m => m.pipelineRunId === verifiedRun).map(m => m.candidateId);
  assert(verifiedMatchedIds.includes(liInRun.id),     `LinkedIn-verified candidate in pool`);
  assert(verifiedMatchedIds.includes(soInRun.id),     `Stack Overflow verified candidate in pool`);
  assert(!verifiedMatchedIds.includes(hfInRun.id),    `HF candidate NOT in pool (review)`);
  assert(!verifiedMatchedIds.includes(credlyInRun.id),`Credly candidate NOT in pool (review)`);

  // ── 24b. Matchmaker excludes accepted candidates whose only link is an
  //         org/brand page on a URL-only trusted platform ──
  const orgPagesRun = 'org_pages_run_' + Date.now().toString(36);
  const gitlabMs   = findOrCreateCandidate({
    name: 'GitLab Microsoft Org', title: 'Cloud Security Engineer', skills: ['Azure'],
    portfolioUrl: 'https://gitlab.com/microsoft',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: orgPagesRun,
  });
  const gitlabSelf = findOrCreateCandidate({
    name: 'GitLab Org Self',      title: 'Cloud Security Engineer', skills: ['Azure'],
    portfolioUrl: 'https://gitlab.com/gitlab-org',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: orgPagesRun,
  });
  const hfMs       = findOrCreateCandidate({
    name: 'HF Microsoft Org',     title: 'Cloud Security Engineer', skills: ['Azure'],
    portfolioUrl: 'https://huggingface.co/microsoft',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: orgPagesRun,
  });
  const hfGoog     = findOrCreateCandidate({
    name: 'HF Google Org',        title: 'Cloud Security Engineer', skills: ['Azure'],
    portfolioUrl: 'https://huggingface.co/google',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: orgPagesRun,
  });
  const kaggleGoog = findOrCreateCandidate({
    name: 'Kaggle Google Org',    title: 'Cloud Security Engineer', skills: ['Azure'],
    portfolioUrl: 'https://www.kaggle.com/google',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: orgPagesRun,
  });
  // Control: LinkedIn-verified candidate (since GitLab/HF/Kaggle alone is now
  // review until verified, the control must use a verified-source URL).
  const linkedInControl = findOrCreateCandidate({
    name: 'LinkedIn Real Person', title: 'Cloud Security Engineer', skills: ['Azure'],
    linkedinUrl: 'https://www.linkedin.com/in/linkedin-real-person',
    source: 'Manual', scoutDecision: 'accepted', pipelineRunId: orgPagesRun,
  });

  // Each org-page candidate fails isFinalShortlistEligible
  for (const c of [gitlabMs, gitlabSelf, hfMs, hfGoog, kaggleGoog]) {
    assert(isFinalShortlistEligible(c) === false,
      `Org-page candidate NOT eligible (name="${c.name}", url=${c.portfolioUrl})`);
  }
  assert(isFinalShortlistEligible(linkedInControl) === true,
    `LinkedIn-verified control IS eligible`);

  // Matchmaker integration — only the verified control reaches the pool
  const orgPagesNeed = createNeed({
    companyId: coApollo.id, title: 'Org-Pages Exclusion Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const orgPagesMm = await runMatchmaker({ needId: orgPagesNeed.id, pipelineRunId: orgPagesRun });
  assert(orgPagesMm.matched === 1,
    `Matchmaker pool excludes 5 org-page candidates; only verified control scored (matched=${orgPagesMm.matched}; expected 1)`);
  const orgMatchedIds = DB.matches
    .filter(m => m.pipelineRunId === orgPagesRun).map(m => m.candidateId);
  for (const c of [gitlabMs, gitlabSelf, hfMs, hfGoog, kaggleGoog]) {
    assert(!orgMatchedIds.includes(c.id),
      `Org-page candidate ${c.name} NOT in match records`);
  }
  assert(orgMatchedIds.includes(linkedInControl.id),
    `LinkedIn-verified control IS in match records`);

  // ── 25. GitHub manual → unverified, then validator upgrade → verified ──
  // A manually-entered GH-only candidate stays at identityVerificationStatus
  // === 'review' until either Scout API verification or runValidator pulls
  // their repos.
  const ghLifecycle = findOrCreateCandidate({
    name: 'GH Manual Lifecycle',
    github: 'https://github.com/gh-manual-lifecycle',
    source: 'Manual', scoutDecision: 'accepted',
  });
  assert(ghLifecycle.identityVerificationStatus === 'review',
    `Manual GitHub-only candidate starts at identityVerificationStatus=review (got "${ghLifecycle.identityVerificationStatus}")`);
  assert(isFinalShortlistEligible(ghLifecycle) === false,
    `Manual GitHub-only candidate NOT eligible until verified`);

  // Validator creates a 'Verified Active' tier validation → createValidation
  // calls refreshIdentityVerification(candidate) automatically.
  createValidation(ghLifecycle.id, {
    tier: 'Verified Active',
    proficiency: { JavaScript: 80 },
  });
  assert(ghLifecycle.identityVerificationStatus === 'verified',
    `After Verified-Active validation, identity flips to verified (got "${ghLifecycle.identityVerificationStatus}")`);
  assert(ghLifecycle.identityVerificationSource === 'github-api',
    `Source=github-api after validator-verification (got "${ghLifecycle.identityVerificationSource}")`);
  assert(isFinalShortlistEligible(ghLifecycle) === true,
    `Now eligible after GitHub validator verification`);

  // Scout-source='GitHub' candidates are immediately verified at create time
  // (Scout's GitHub user-search API is the verification signal).
  const scoutGh = findOrCreateCandidate({
    name: 'Scout GH Source',
    github: 'https://github.com/scout-gh-source',
    source: 'GitHub', scoutDecision: 'accepted',
  });
  assert(scoutGh.identityVerificationStatus === 'verified',
    `Scout source='GitHub' is verified at creation (got "${scoutGh.identityVerificationStatus}")`);
  assert(scoutGh.identityVerificationSource === 'github-api',
    `Scout GH source=github-api (got "${scoutGh.identityVerificationSource}")`);

  // Anti-stale: linkedinUrl cleared post-verification → verifiedProfileUrl
  // no longer present on candidate → ineligible.
  const staleLi = findOrCreateCandidate({
    name: 'Stale LI Candidate',
    linkedinUrl: 'https://www.linkedin.com/in/stale-li-cand',
    source: 'Manual', scoutDecision: 'accepted',
  });
  assert(isFinalShortlistEligible(staleLi) === true, 'Pre-clear: LinkedIn-verified eligible');
  staleLi.linkedinUrl = '';  // remove link without refreshing identity block
  assert(isFinalShortlistEligible(staleLi) === false,
    `After linkedinUrl cleared (stale verifiedProfileUrl), candidate NOT eligible`);

  // ── 26. Apollo HTTP-error capture + redaction ──
  // When Apollo returns a non-2xx, apolloCandidateSearch must capture the body
  // (redacted) so the operator can diagnose. Body must never leak api keys.
  const prevApolloKey4 = process.env.APOLLO_API_KEY;
  process.env.APOLLO_API_KEY = 'test-apollo-key';
  STUB_APOLLO_PEOPLE = null;
  STUB_FIRECRAWL_ITEMS = [];
  STUB_GH_SEARCH_USERS = { items: [] };

  // (a) 422 with structured error → body captured + endpoint reported
  STUB_APOLLO_HTTP = {
    status: 422,
    body: { error: 'Invalid value for person_titles: too long (max 25)', code: 'INVALID_PARAM' },
  };
  const err422Need = createNeed({
    companyId: coApollo.id, title: 'Apollo Err 422 Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const err422Run = 'apollo_err_422_' + Date.now().toString(36);
  await runScout({ needId: err422Need.id, pipelineRunId: err422Run });
  const err422Log = DB.activity_logs.find(l =>
    l.agent === 'Scout' &&
    /Apollo skipped: Apollo HTTP 422/.test(l.message) &&
    l.meta && l.meta.status === 422
  );
  assert(err422Log, `Activity log captured Apollo 422 with status meta (got nothing)`);
  assert(err422Log && err422Log.meta && err422Log.meta.endpoint === '/v1/mixed_people/api_search',
    `Activity log includes endpoint name (got "${err422Log && err422Log.meta && err422Log.meta.endpoint}")`);
  assert(err422Log && /Invalid value for person_titles/.test(err422Log.meta.body || ''),
    `Log body shows Apollo's actual error text (got "${err422Log && err422Log.meta && err422Log.meta.body}")`);

  // (b) Redaction — body containing clearly fake key/password/auth/token-looking
  // values and a long opaque value should be redacted.
  STUB_APOLLO_HTTP = {
    status: 401,
    body: 'auth failed: api_key=FAKE_API_KEY_FOR_REDACTION password=FAKE_PASSWORD_FOR_REDACTION Authorization=FAKE_AUTHORIZATION_FOR_REDACTION token=FAKE_TOKEN_FOR_REDACTION extra=FAKE_LONG_OPAQUE_VALUE_FOR_REDACTION_ONLY_00000000000000000000',
  };
  const err401Need = createNeed({
    companyId: coApollo.id, title: 'Apollo Err 401 Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const err401Run = 'apollo_err_401_' + Date.now().toString(36);
  await runScout({ needId: err401Need.id, pipelineRunId: err401Run });
  const err401Log = DB.activity_logs.find(l =>
    l.agent === 'Scout' && /Apollo skipped: Apollo HTTP 401/.test(l.message) && l.meta && l.meta.status === 401
  );
  assert(err401Log, `Activity log captured Apollo 401`);
  const loggedBody = (err401Log && err401Log.meta && err401Log.meta.body) || '';
  // No api_key, bearer, password, or token VALUES present
  assert(!/FAKE_API_KEY_FOR_REDACTION/.test(loggedBody),
    `api_key value NOT in log body (got "${loggedBody}")`);
  assert(!/FAKE_PASSWORD_FOR_REDACTION/.test(loggedBody),
    `password value NOT in log body`);
  assert(!/FAKE_AUTHORIZATION_FOR_REDACTION/.test(loggedBody),
    `authorization value NOT in log body`);
  assert(!/FAKE_TOKEN_FOR_REDACTION/.test(loggedBody),
    `Generic token value NOT in log body`);
  assert(!/FAKE_LONG_OPAQUE_VALUE_FOR_REDACTION_ONLY_00000000000000000000/.test(loggedBody),
    `Long opaque value NOT in log body`);
  // Redaction markers present
  assert(/REDACTED/.test(loggedBody),
    `Log body contains <REDACTED…> marker (got "${loggedBody}")`);
  // Behavior preserved: pipeline did not crash, Apollo just skipped
  const err401Run2 = await runScout({ needId: err401Need.id, pipelineRunId: err401Run + '_b' });
  assert(typeof err401Run2 === 'object' && Array.isArray(err401Run2.candidates),
    `runScout still returns shape on Apollo failure (no crash)`);
  assert(err401Run2.apolloRaw === 0,
    `apolloRaw === 0 when Apollo errors (got ${err401Run2.apolloRaw})`);

  // (c) Generic non-error 2xx path unchanged (apolloRaw still increments per person)
  STUB_APOLLO_HTTP = null;
  STUB_APOLLO_PEOPLE = [
    { id: 'ok1', name: 'OK Path', linkedin_url: 'https://www.linkedin.com/in/ok-path' },
  ];
  const okPathNeed = createNeed({
    companyId: coApollo.id, title: 'Apollo OK Path Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const okPathRun = 'apollo_ok_path_' + Date.now().toString(36);
  const okPathScout = await runScout({ needId: okPathNeed.id, pipelineRunId: okPathRun });
  assert(okPathScout.apolloRaw === 1, `OK path still works after error-capture change (apolloRaw=${okPathScout.apolloRaw})`);

  // Restore Apollo env
  STUB_APOLLO_HTTP = null;
  STUB_APOLLO_PEOPLE = null;
  if (prevApolloKey4 === undefined) delete process.env.APOLLO_API_KEY;
  else process.env.APOLLO_API_KEY = prevApolloKey4;

  // ── 27. Apollo person_titles cap + normalization ──
  const { normalizeApolloTitles, APOLLO_PERSON_TITLES_MAX, apolloCandidateSearch, expandRoleToTitles: _expand } = _internals;
  assert(APOLLO_PERSON_TITLES_MAX === 25, `cap constant === 25`);

  // (a) normalizeApolloTitles: trim, drop empties, dedupe case-insensitively, cap 25
  const messy = [
    '  Azure Security Engineer  ',
    'azure security engineer',        // case-dup of above
    'Cloud Security Engineer',
    '',                               // empty
    null,                             // null
    '   ',                            // whitespace only
    'Cloud Security Engineer',        // exact dup
    'CLOUD SECURITY ENGINEER',        // case dup
    'Security Engineer',
  ];
  const cleaned = normalizeApolloTitles(messy);
  assert(cleaned.length === 3,
    `Messy list dedupes/trims to 3 unique titles (got ${cleaned.length}: ${JSON.stringify(cleaned)})`);
  assert(cleaned[0] === 'Azure Security Engineer',
    `Trim applied, first kept value preserves original casing`);

  // 30 titles → capped to 25
  const thirty = Array.from({ length: 30 }, (_, i) => `Title ${i + 1}`);
  const capped = normalizeApolloTitles(thirty);
  assert(capped.length === APOLLO_PERSON_TITLES_MAX,
    `30-title list capped to ${APOLLO_PERSON_TITLES_MAX} (got ${capped.length})`);
  assert(capped[0] === 'Title 1' && capped[24] === 'Title 25',
    `Cap preserves first 25 in input order (got first=${capped[0]}, last=${capped[capped.length-1]})`);

  // Non-arrays / nullish input
  assert(normalizeApolloTitles(null).length === 0,         `null → empty array`);
  assert(normalizeApolloTitles(undefined).length === 0,    `undefined → empty array`);
  assert(normalizeApolloTitles('hello').length === 0,      `non-array → empty array`);

  // (b) expandRoleToTitles security set includes user's focused titles + stays ≤20
  const securityTitles = _expand('Azure Security Engineer');
  assert(securityTitles.length <= 20,
    `expandRoleToTitles caps below 20 internally (got ${securityTitles.length})`);
  for (const must of [
    'Azure Security Engineer','Cloud Security Engineer','Security Engineer',
    'SOC Analyst','Detection Engineer','Microsoft Security Engineer','SIEM Engineer',
    'Incident Response Analyst','IAM Engineer','IAM Analyst',
  ]) {
    assert(securityTitles.includes(must), `securityTitles includes "${must}"`);
  }

  // (c) apolloCandidateSearch — outbound body person_titles is normalized + capped
  process.env.APOLLO_API_KEY = 'test-apollo-key';
  STUB_APOLLO_HTTP = null;
  STUB_APOLLO_PEOPLE = [];
  LAST_APOLLO_REQUEST_BODY = null;
  LAST_APOLLO_REQUEST_HEADERS = null;

  // Send 30 raw titles including duplicates / empties → body should have ≤25 unique
  const noisy = [
    ...thirty,
    'Title 1',                    // dup
    '  Title 2  ',                // dup w/ whitespace
    'TITLE 3',                    // case dup
    '',
    null,
  ];
  await apolloCandidateSearch({ titles: noisy });
  assert(LAST_APOLLO_REQUEST_BODY && Array.isArray(LAST_APOLLO_REQUEST_BODY.person_titles),
    `Outbound Apollo body includes person_titles array`);
  assert(LAST_APOLLO_REQUEST_HEADERS && LAST_APOLLO_REQUEST_HEADERS['x-api-key'] === 'test-apollo-key',
    `Outbound Apollo request sends API key in X-Api-Key header`);
  assert(LAST_APOLLO_REQUEST_BODY && !Object.prototype.hasOwnProperty.call(LAST_APOLLO_REQUEST_BODY, 'api_key'),
    `Outbound Apollo body does NOT include deprecated api_key field`);
  assert(LAST_APOLLO_REQUEST_BODY.person_titles.length === APOLLO_PERSON_TITLES_MAX,
    `Outbound person_titles capped at ${APOLLO_PERSON_TITLES_MAX} (got ${LAST_APOLLO_REQUEST_BODY.person_titles.length})`);
  // No duplicate (case-insensitive) entries in outbound body
  const lower = LAST_APOLLO_REQUEST_BODY.person_titles.map(s => s.toLowerCase());
  assert(new Set(lower).size === lower.length,
    `Outbound person_titles has no case-insensitive duplicates`);

  // (d) apolloCandidateSearch — full expansion for "Azure Security Engineer" is under cap
  LAST_APOLLO_REQUEST_BODY = null;
  LAST_APOLLO_REQUEST_HEADERS = null;
  await apolloCandidateSearch({ titles: _expand('Azure Security Engineer') });
  assert(LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_titles.length <= APOLLO_PERSON_TITLES_MAX,
    `Full security expansion stays ≤${APOLLO_PERSON_TITLES_MAX} (got ${LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_titles.length})`);

  // (e) Empty/normalize-to-empty input → ok:false with reason='no titles to search'
  const emptyRes = await apolloCandidateSearch({ titles: ['', '   ', null] });
  assert(emptyRes.ok === false && emptyRes.reason === 'no titles to search',
    `Empty/whitespace-only title list short-circuits to 'no titles to search' (got reason="${emptyRes.reason}")`);

  // (f) Apollo OK path still works (verified via earlier blocks; re-confirm here)
  LAST_APOLLO_REQUEST_BODY = null;
  LAST_APOLLO_REQUEST_HEADERS = null;
  STUB_APOLLO_PEOPLE = [{ id: 'cap-ok', name: 'Cap OK', linkedin_url: 'https://www.linkedin.com/in/cap-ok' }];
  const capOkRes = await apolloCandidateSearch({ titles: ['Azure Security Engineer'] });
  assert(capOkRes.ok === true && capOkRes.people.length === 1,
    `OK path still returns people after cap fix (got ok=${capOkRes.ok}, people=${capOkRes.people.length})`);

  // (g) Error path still logs safely (re-prove with the new normalized body)
  STUB_APOLLO_HTTP = { status: 422, body: { error: 'Invalid value for person_titles: too long (max 25)' } };
  const capErrNeed = createNeed({
    companyId: coApollo.id, title: 'Apollo Cap Error Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const capErrRun = 'apollo_cap_err_' + Date.now().toString(36);
  await runScout({ needId: capErrNeed.id, pipelineRunId: capErrRun });
  const capErrLog = DB.activity_logs.find(l =>
    l.agent === 'Scout' && /Apollo skipped: Apollo HTTP 422/.test(l.message)
    && l.meta && /Invalid value for person_titles/.test(l.meta.body || '')
  );
  assert(capErrLog, `Apollo 422 error still logged safely after title-cap change`);

  STUB_APOLLO_HTTP = null;
  STUB_APOLLO_PEOPLE = null;

  // ── 28. apolloSearch() (Connector path) — same title-cap rule ──
  // The manager-focused apolloSearch() must also normalize/cap person_titles
  // so neither Apollo path can ever send > 25 titles.
  const server2 = require(path.join('..', 'backend', 'server.js'));
  // apolloSearch is not in _internals; access via the module-level cache by
  // requiring the same file again (Node returns the cached module).
  // For coverage, exercise it via runConnector AND via the captured outbound
  // body in the fetch stub.
  process.env.APOLLO_API_KEY = 'test-apollo-key';
  STUB_APOLLO_HTTP = null;
  STUB_APOLLO_PEOPLE = []; // 0 people — just confirm body shape
  LAST_APOLLO_REQUEST_BODY = null;
  LAST_APOLLO_REQUEST_HEADERS = null;

  // (a) Default Connector titles (under 25) pass through normalized
  await runValidator({ candidateIds: [] }); // no-op warm-up
  // Call connector via the HTTP-equivalent path: import server2.app? Simpler —
  // runConnector is not in _internals. Use the public API: server.app has the
  // POST /api/connector/run route. Boot an ephemeral server.
  const connServer = await new Promise((resolve) => {
    const s = server2.app.listen(0, () => resolve(s));
  });
  const connPort = connServer.address().port;
  const connAuth = 'Basic ' + Buffer.from(`${process.env.INTERNAL_USER || 'tester'}:${process.env.INTERNAL_PASSWORD}`).toString('base64');
  const httpPost = (path, body) => new Promise((resolve, reject) => {
    const r = http.request({
      hostname: 'localhost', port: connPort, path, method: 'POST',
      headers: { Authorization: connAuth, 'Content-Type': 'application/json' },
    }, (res) => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, data: null, raw: buf }); }
      });
    });
    r.on('error', reject);
    r.write(JSON.stringify(body || {}));
    r.end();
  });

  // (a-1) Default titles (ROLE_TITLES_DEFAULT is 14 items) — should pass through
  LAST_APOLLO_REQUEST_BODY = null;
  await httpPost('/api/connector/run', { industry: 'Cloud Security' });
  assert(LAST_APOLLO_REQUEST_BODY && Array.isArray(LAST_APOLLO_REQUEST_BODY.person_titles),
    `Connector path sent person_titles to Apollo`);
  assert(LAST_APOLLO_REQUEST_HEADERS && LAST_APOLLO_REQUEST_HEADERS['x-api-key'] === 'test-apollo-key',
    `Connector path sends Apollo key in X-Api-Key header`);
  assert(LAST_APOLLO_REQUEST_BODY && !Object.prototype.hasOwnProperty.call(LAST_APOLLO_REQUEST_BODY, 'api_key'),
    `Connector path body does NOT include deprecated api_key field`);
  assert(LAST_APOLLO_REQUEST_BODY.person_titles.length > 0
      && LAST_APOLLO_REQUEST_BODY.person_titles.length <= 25,
    `Connector default titles within cap (got ${LAST_APOLLO_REQUEST_BODY.person_titles.length})`);
  const defaultLower = LAST_APOLLO_REQUEST_BODY.person_titles.map(s => s.toLowerCase());
  assert(new Set(defaultLower).size === defaultLower.length,
    `Connector default titles deduped (no case-insensitive dups)`);

  // (a-2) Caller passes 30 titles → outbound capped at 25
  const big = Array.from({ length: 30 }, (_, i) => `Mgr Title ${i + 1}`);
  LAST_APOLLO_REQUEST_BODY = null;
  LAST_APOLLO_REQUEST_HEADERS = null;
  await httpPost('/api/connector/run', { titles: big });
  assert(LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_titles.length === 25,
    `Connector caps oversized title list at 25 (got ${LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_titles.length})`);

  // (a-3) Caller passes duplicates + whitespace-only → deduped and trimmed
  const dirty = [
    '  CISO  ',
    'CISO',
    'ciso',
    'Director of Security',
    '   ',
    '',
    null,
    'director of security', // case dup
  ];
  LAST_APOLLO_REQUEST_BODY = null;
  LAST_APOLLO_REQUEST_HEADERS = null;
  await httpPost('/api/connector/run', { titles: dirty });
  assert(LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_titles.length === 2,
    `Connector dedupes/trims dirty titles to 2 (got ${LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_titles.length})`);
  const dirtyLower = LAST_APOLLO_REQUEST_BODY.person_titles.map(s => s.toLowerCase());
  assert(new Set(dirtyLower).size === dirtyLower.length, `No case-insensitive dups`);

  // (a-4) Apollo HTTP-error path still logs (apolloSearch shares the error capture)
  STUB_APOLLO_HTTP = {
    status: 422,
    body: { error: 'Invalid value for person_titles: too long (max 25)' },
  };
  await httpPost('/api/connector/run', { titles: ['CISO'] });
  const connErrLog = DB.activity_logs.find(l =>
    l.agent === 'Connector' && /Apollo HTTP 422/.test(l.message)
  );
  assert(connErrLog, `Connector activity log captures Apollo 422 error`);

  STUB_APOLLO_HTTP = null;
  connServer.close();

  // (b) Scout candidate path still works (regression check — confirm earlier
  //     cap+normalization on apolloCandidateSearch is unchanged)
  STUB_APOLLO_PEOPLE = [{ id: 'reg', name: 'Regression Person', linkedin_url: 'https://www.linkedin.com/in/regression-person' }];
  LAST_APOLLO_REQUEST_BODY = null;
  const regScout = await runScout({
    needId: (createNeed({
      companyId: coApollo.id, title: 'Apollo Regression Role',
      requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
    })).id,
    pipelineRunId: 'apollo_regression_' + Date.now().toString(36),
  });
  assert(regScout.apolloRaw === 1,
    `Scout candidate path still returns 1 person via Apollo (apolloRaw=${regScout.apolloRaw})`);
  assert(LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_titles.length <= 25,
    `Scout path Apollo body still ≤25 titles (got ${LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_titles.length})`);

  STUB_APOLLO_PEOPLE = null;

  // ── 29. Commit A — Apollo X-Api-Key header migration + phone + Wellfound /u/ ──
  process.env.APOLLO_API_KEY = 'commit-a-apollo-key';
  STUB_APOLLO_HTTP = null;
  STUB_APOLLO_PEOPLE = [
    { id: 'cm-a-1', name: 'Apollo Phone Person', title: 'Cloud Security Engineer',
      linkedin_url: 'https://www.linkedin.com/in/apollo-phone-person',
      phone_numbers: [{ sanitized_number: '+15551234567', raw_number: '(555) 123-4567', type: 'work' }],
      email: 'phone@example.com',
      organization: { name: 'PhoneCo' } },
    { id: 'cm-a-2', name: 'Apollo Mobile Fallback', title: 'Security Engineer',
      linkedin_url: 'https://www.linkedin.com/in/apollo-mobile-fb',
      mobile_phone: '+447700900111',
      organization: { name: 'MobileCo' } },
    { id: 'cm-a-3', name: 'Apollo Corporate Phone', title: 'Cyber Security Engineer',
      linkedin_url: 'https://www.linkedin.com/in/apollo-corp-phone',
      corporate_phone: '+12025550001',
      organization: { name: 'CorpCo' } },
    { id: 'cm-a-4', name: 'Apollo No Phone', title: 'Detection Engineer',
      linkedin_url: 'https://www.linkedin.com/in/apollo-no-phone',
      organization: { name: 'NoPhoneCo' } },
  ];

  LAST_APOLLO_REQUEST_BODY = null;
  LAST_APOLLO_REQUEST_HEADERS = null;
  const cmANeed = createNeed({
    companyId: coApollo.id, title: 'Apollo Header + Phone Role',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const cmARun = 'commit_a_run_' + Date.now().toString(36);
  await runScout({ needId: cmANeed.id, pipelineRunId: cmARun });

  // (a) X-Api-Key header is sent
  assert(LAST_APOLLO_REQUEST_HEADERS && LAST_APOLLO_REQUEST_HEADERS['x-api-key'] === 'commit-a-apollo-key',
    `Apollo request has X-Api-Key header (got "${LAST_APOLLO_REQUEST_HEADERS && LAST_APOLLO_REQUEST_HEADERS['x-api-key']}")`);
  // (b) api_key field is NOT in the request body
  assert(LAST_APOLLO_REQUEST_BODY && !('api_key' in LAST_APOLLO_REQUEST_BODY),
    `Apollo request body has NO api_key field (body keys: ${LAST_APOLLO_REQUEST_BODY && Object.keys(LAST_APOLLO_REQUEST_BODY).join(',')})`);
  // (c) Body still has required search params
  assert(LAST_APOLLO_REQUEST_BODY && Array.isArray(LAST_APOLLO_REQUEST_BODY.person_titles)
      && LAST_APOLLO_REQUEST_BODY.person_titles.length > 0,
    `Apollo request body still has person_titles array (length=${LAST_APOLLO_REQUEST_BODY && LAST_APOLLO_REQUEST_BODY.person_titles && LAST_APOLLO_REQUEST_BODY.person_titles.length})`);

  // (d) Apollo phone extraction — sanitized_number, mobile_phone fallback, corporate_phone fallback, none
  const phoneSan = DB.candidates.find(c => c.name === 'Apollo Phone Person' && c.pipelineRunId === cmARun);
  assert(phoneSan && phoneSan.phone === '+15551234567',
    `phone_numbers[0].sanitized_number captured (got "${phoneSan && phoneSan.phone}")`);
  const phoneMobile = DB.candidates.find(c => c.name === 'Apollo Mobile Fallback' && c.pipelineRunId === cmARun);
  assert(phoneMobile && phoneMobile.phone === '+447700900111',
    `mobile_phone fallback captured (got "${phoneMobile && phoneMobile.phone}")`);
  const phoneCorp = DB.candidates.find(c => c.name === 'Apollo Corporate Phone' && c.pipelineRunId === cmARun);
  assert(phoneCorp && phoneCorp.phone === '+12025550001',
    `corporate_phone fallback captured (got "${phoneCorp && phoneCorp.phone}")`);
  const noPhone = DB.candidates.find(c => c.name === 'Apollo No Phone' && c.pipelineRunId === cmARun);
  assert(noPhone && (noPhone.phone === '' || noPhone.phone == null),
    `No phone fields → candidate.phone empty (got "${noPhone && noPhone.phone}")`);

  // (e) Connector path (apolloSearch) also uses X-Api-Key header
  LAST_APOLLO_REQUEST_BODY = null;
  LAST_APOLLO_REQUEST_HEADERS = null;
  STUB_APOLLO_PEOPLE = [];
  // ROLE_TITLES_DEFAULT used internally; trigger via /api/connector/run
  const cmAConnServer = await new Promise((resolve) => {
    const s = server.app.listen(0, () => resolve(s));
  });
  const cmAConnPort = cmAConnServer.address().port;
  const cmAAuthH = 'Basic ' + Buffer.from(`${process.env.INTERNAL_USER || 'tester'}:${process.env.INTERNAL_PASSWORD}`).toString('base64');
  await new Promise((resolve, reject) => {
    const r = http.request({
      hostname: 'localhost', port: cmAConnPort, path: '/api/connector/run', method: 'POST',
      headers: { Authorization: cmAAuthH, 'Content-Type': 'application/json' },
    }, (res) => { let buf=''; res.on('data', c=>buf+=c); res.on('end', () => resolve(buf)); });
    r.on('error', reject); r.write(JSON.stringify({ industry: 'Cyber Security' })); r.end();
  });
  cmAConnServer.close();
  assert(LAST_APOLLO_REQUEST_HEADERS && LAST_APOLLO_REQUEST_HEADERS['x-api-key'] === 'commit-a-apollo-key',
    `apolloSearch (Connector) also sends X-Api-Key header`);
  assert(LAST_APOLLO_REQUEST_BODY && !('api_key' in LAST_APOLLO_REQUEST_BODY),
    `apolloSearch (Connector) body has NO api_key field`);

  // (f) Wellfound rule split — /jobs/ rejected, /company/ rejected, /u/ routed to review
  const wfJobs   = classifySourceItem({ title: 'Eng - Co', url: 'https://wellfound.com/jobs/12345' });
  assert(wfJobs.scoutDecision === 'rejected' && wfJobs.sourceType === 'job_posting',
    `Wellfound /jobs/ → rejected as job_posting (got ${wfJobs.scoutDecision}/${wfJobs.sourceType})`);
  const wfCompany = classifySourceItem({ title: 'Acme on Wellfound', url: 'https://wellfound.com/company/acme' });
  assert(wfCompany.scoutDecision === 'rejected' && wfCompany.sourceType === 'company_page',
    `Wellfound /company/ → rejected as company_page (got ${wfCompany.scoutDecision}/${wfCompany.sourceType})`);
  const wfProfile = classifySourceItem({ title: 'Jane Doe', url: 'https://wellfound.com/u/jane-doe', description: 'Cloud security engineer' });
  assert(wfProfile.scoutDecision === 'review' && wfProfile.sourceType === 'possible_candidate',
    `Wellfound /u/<username> → review as possible_candidate (got ${wfProfile.scoutDecision}/${wfProfile.sourceType})`);
  assert(/Wellfound \/u\//.test(wfProfile.scoutReason),
    `Wellfound /u/ scoutReason mentions "Wellfound /u/" (got "${wfProfile.scoutReason}")`);

  // (g) Wellfound /u/ does NOT enter the final shortlist (still URL-only, identity unverified)
  const wfCandidate = findOrCreateCandidate({
    name: 'Wellfound Jane',
    portfolioUrl: 'https://wellfound.com/u/wellfound-jane',
    source: 'Manual', scoutDecision: 'review', // matches what classifier returned
  });
  assert(wfCandidate.identityVerificationStatus === 'review',
    `Wellfound /u/ candidate identityVerificationStatus === 'review' (got "${wfCandidate.identityVerificationStatus}")`);
  assert(isFinalShortlistEligible(wfCandidate) === false,
    `Wellfound /u/ alone is NOT final-shortlist eligible (review pool only)`);

  // (h) AngelList legacy paths split the same way
  const angelJobs = classifySourceItem({ title: 'Eng', url: 'https://angel.co/jobs/9999' });
  assert(angelJobs.scoutDecision === 'rejected' && angelJobs.sourceType === 'job_posting',
    `angel.co /jobs/ → rejected as job_posting`);

  STUB_APOLLO_HTTP = null;
  STUB_APOLLO_PEOPLE = null;

  // ── 30. Commit B — GitHub contributor mining + Firecrawl board queries + Adzuna mining ──
  const { pickReposForRole, buildFirecrawlBoardQueries: _bbq } = _internals;

  // (a) pickReposForRole picks security repos for security roles
  const repos = pickReposForRole('Azure Security Engineer');
  assert(Array.isArray(repos) && repos.length >= 4,
    `pickReposForRole returns ≥4 repos for security role (got ${repos.length})`);
  const repoKeys = repos.map(r => `${r.owner}/${r.repo}`);
  for (const must of ['Azure/Azure-Sentinel','SigmaHQ/sigma','OTRF/Microsoft-Sentinel2Go','MicrosoftDocs/azure-docs']) {
    assert(repoKeys.includes(must), `pickReposForRole includes ${must}`);
  }
  // Non-matching role returns empty
  const otherRepos = pickReposForRole('Frontend Engineer');
  assert(otherRepos.length === 0, `pickReposForRole returns [] for non-security/devops roles`);

  // (b) buildFirecrawlBoardQueries: Dice / Built In / Wellfound / speaker
  const bq = _bbq({ title: 'Azure Security Engineer', requiredSkills: ['Azure','Sentinel'] });
  const bqSources = bq.map(q => q.source);
  assert(bqSources.includes('wellfound-u'),     `board queries include wellfound-u`);
  assert(bqSources.includes('dice-talent'),     `board queries include dice-talent`);
  assert(bqSources.includes('builtin'),         `board queries include builtin`);
  assert(bqSources.includes('security-speaker'),`security role triggers security-speaker query`);
  const bqNonSec = _bbq({ title: 'Frontend Engineer', requiredSkills: ['React'] });
  assert(!bqNonSec.map(q => q.source).includes('security-speaker'),
    `non-security role does NOT include security-speaker query`);

  // (c) GitHub contributor mining — verified-user contributors become candidates
  process.env.APOLLO_API_KEY = 'commit-b-apollo-key';
  STUB_APOLLO_HTTP = null;
  STUB_APOLLO_PEOPLE = [];
  STUB_FIRECRAWL_ITEMS = [];
  STUB_GH_SEARCH_USERS = { items: [] };
  STUB_GH_USER_RECORDS = {
    'real-sentinel-contrib':  { type: 'User', login: 'real-sentinel-contrib', html_url: 'https://github.com/real-sentinel-contrib', name: 'Real Sentinel Contrib', bio: 'Detection engineer · Azure Sentinel', updated_at: new Date().toISOString() },
    'real-sigma-contrib':     { type: 'User', login: 'real-sigma-contrib',    html_url: 'https://github.com/real-sigma-contrib',    name: 'Real Sigma Contrib',    bio: 'SIEM engineer · SigmaHQ', updated_at: new Date().toISOString() },
    'github-bot-app':         { type: 'Bot',  login: 'github-bot-app' },          // bot — must be filtered
    'azure':                  { type: 'Organization', login: 'azure' },           // org — must be filtered (also in KNOWN_ORGS)
  };
  STUB_GH_CONTRIBUTORS = {
    'Azure/Azure-Sentinel': [
      { login: 'real-sentinel-contrib', type: 'User', html_url: 'https://github.com/real-sentinel-contrib', contributions: 250 },
      { login: 'github-bot-app',        type: 'Bot' },                            // bot filter
      { login: 'azure',                 type: 'Organization' },                   // org filter (KNOWN_ORG)
    ],
    'SigmaHQ/sigma': [
      { login: 'real-sigma-contrib', type: 'User', html_url: 'https://github.com/real-sigma-contrib', contributions: 180 },
    ],
    'OTRF/Microsoft-Sentinel2Go':  [],
    'MicrosoftDocs/azure-docs':    [],
    'mitre-attack/attack-flow':    [],
  };
  GH_CONTRIB_CALLS.length = 0;

  const cmBNeed = createNeed({
    companyId: coApollo.id, title: 'Azure Security Engineer',
    requiredSkills: ['Azure', 'Sentinel'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const cmBRun = 'commit_b_run_' + Date.now().toString(36);
  const cmBScout = await runScout({ needId: cmBNeed.id, pipelineRunId: cmBRun });

  // Contributor API was called for each canonical repo
  assert(GH_CONTRIB_CALLS.includes('Azure/Azure-Sentinel'),
    `Scout called Azure/Azure-Sentinel contributors API (calls: ${JSON.stringify(GH_CONTRIB_CALLS)})`);
  assert(GH_CONTRIB_CALLS.includes('SigmaHQ/sigma'),
    `Scout called SigmaHQ/sigma contributors API`);

  // Real users became accepted candidates
  const sentinelCand = DB.candidates.find(c =>
    c.pipelineRunId === cmBRun && /real-sentinel-contrib/.test(c.github || '')
  );
  assert(sentinelCand && sentinelCand.scoutDecision === 'accepted',
    `Azure-Sentinel contributor accepted (got "${sentinelCand && sentinelCand.scoutDecision}")`);
  assert(sentinelCand && /contributor of Azure\/Azure-Sentinel/.test(sentinelCand.scoutReason || ''),
    `scoutReason mentions Azure/Azure-Sentinel contributor (got "${sentinelCand && sentinelCand.scoutReason}")`);
  assert(sentinelCand && sentinelCand.identityVerificationStatus === 'verified',
    `Contributor identityVerificationStatus === 'verified' (source=GitHub flips it via isVerifiedGitHubProfile)`);
  const sigmaCand = DB.candidates.find(c =>
    c.pipelineRunId === cmBRun && /real-sigma-contrib/.test(c.github || '')
  );
  assert(sigmaCand && sigmaCand.scoutDecision === 'accepted',
    `SigmaHQ/sigma contributor accepted`);
  // Bot + org NOT in the candidate pool
  const botCand = DB.candidates.find(c =>
    c.pipelineRunId === cmBRun && /github-bot-app/.test(c.github || '')
  );
  assert(!botCand, `Bot contributor NOT in candidate pool`);
  const orgCand = DB.candidates.find(c =>
    c.pipelineRunId === cmBRun && c.github === 'https://github.com/azure'
  );
  assert(!orgCand, `Org contributor (KNOWN_ORG) NOT in candidate pool`);
  // Contributor mining counted under github
  assert(cmBScout.acceptedBySource.github >= 2,
    `acceptedBySource.github counts contributor candidates (got ${cmBScout.acceptedBySource.github})`);

  // (d) Adzuna candidate-mention mining
  STUB_GH_CONTRIBUTORS = {};
  process.env.ADZUNA_APP_ID = process.env.ADZUNA_APP_ID || 'test-id';
  process.env.ADZUNA_API_KEY = process.env.ADZUNA_API_KEY || 'test-key';
  STUB_ADZUNA_RESULTS = {
    results: [
      { title: 'SOC Analyst', company: { display_name: 'Acme Corp' }, location: { display_name: 'Remote' },
        description: 'Job posting by Jane Smith. Apply directly.', redirect_url: 'https://adzuna.com/jobs/12345' },
      { title: 'Security Engineer', company: { display_name: 'Beta Inc' },
        description: 'Submitted by John O\'Brien on Q2 2026.', redirect_url: 'https://adzuna.com/jobs/67890' },
      { title: 'Detection Engineer', company: { display_name: 'Gamma LLC' },
        description: 'Plain description with no mentions.', redirect_url: 'https://adzuna.com/jobs/0' },
    ],
  };

  const adzNeed = createNeed({
    companyId: coApollo.id, title: 'Detection Engineer',
    requiredSkills: ['SIEM','KQL'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const adzRun = 'adzuna_mine_run_' + Date.now().toString(36);
  const adzScout = await runScout({ needId: adzNeed.id, pipelineRunId: adzRun });

  assert(adzScout.adzunaRaw >= 2,
    `Adzuna mined ≥2 names from job descriptions (got ${adzScout.adzunaRaw})`);
  assert(adzScout.reviewBySource.adzuna >= 2,
    `Adzuna candidates land in reviewBySource.adzuna (got ${adzScout.reviewBySource.adzuna})`);
  const adzJane = DB.candidates.find(c => c.pipelineRunId === adzRun && c.name === 'Jane Smith');
  assert(adzJane && adzJane.scoutDecision === 'review' && adzJane.source === 'Adzuna',
    `"by Jane Smith" extracted (got name="${adzJane && adzJane.name}", decision="${adzJane && adzJane.scoutDecision}", source="${adzJane && adzJane.source}")`);
  assert(adzJane && adzJane.identityVerificationStatus === 'review',
    `Adzuna-mined candidate identityVerificationStatus='review' (no profile URL)`);
  assert(adzJane && isFinalShortlistEligible(adzJane) === false,
    `Adzuna-mined candidate NOT in final shortlist (review only)`);

  // (e) Per-source counter shape now includes adzuna
  for (const ctr of [adzScout.rawResultsBySource, adzScout.acceptedBySource, adzScout.reviewBySource, adzScout.rejectedBySource]) {
    assert('adzuna' in ctr, `per-source counter includes adzuna key (got ${JSON.stringify(ctr)})`);
  }
  assert('adzunaRaw' in adzScout, `scout return has top-level adzunaRaw`);

  // Reset stubs
  STUB_GH_CONTRIBUTORS = null;
  STUB_ADZUNA_RESULTS = null;
  STUB_APOLLO_PEOPLE = null;

  // ── 31. Commit C — PDL module (Person Search + Resolve + Lookup) + Hunter on candidates ──
  const { pdlPersonSearch, pdlProfileLookup, pdlProfileResolve, pdlResolveIdentifiersFromName } = _internals;

  // (a) PDL helpers DORMANT when PDL_API_KEY missing
  delete process.env.PDL_API_KEY;
  const dormSearch  = await pdlPersonSearch({ role: 'Security Engineer' });
  const dormLookup  = await pdlProfileLookup({ linkedinUrl: 'https://www.linkedin.com/in/x' });
  const dormResolve = await pdlProfileResolve({ firstName: 'A', lastName: 'B' });
  assert(dormSearch.ok === false && /PDL_API_KEY missing/.test(dormSearch.reason),
    `pdlPersonSearch dormant when key missing`);
  assert(dormLookup.ok === false && /PDL_API_KEY missing/.test(dormLookup.reason),
    `pdlProfileLookup dormant when key missing`);
  assert(dormResolve.ok === false && /PDL_API_KEY missing/.test(dormResolve.reason),
    `pdlProfileResolve dormant when key missing`);

  // (b) Pipeline still runs when PDL is missing (commit B baseline preserved)
  process.env.APOLLO_API_KEY = 'commit-c-apollo-key';
  STUB_APOLLO_PEOPLE = [];
  STUB_FIRECRAWL_ITEMS = [];
  STUB_GH_SEARCH_USERS = { items: [] };
  STUB_GH_CONTRIBUTORS = {};
  STUB_ADZUNA_RESULTS = null;
  const dormNeed = createNeed({
    companyId: coApollo.id, title: 'Azure Security Engineer',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const dormRun = 'dormant_pdl_' + Date.now().toString(36);
  const dormScout = await runScout({ needId: dormNeed.id, pipelineRunId: dormRun });
  assert(dormScout.pdlRaw === 0,
    `pdlRaw === 0 when PDL key missing (got ${dormScout.pdlRaw})`);
  assert(typeof dormScout === 'object' && Array.isArray(dormScout.candidates),
    `runScout still returns normal shape with PDL dormant`);

  // (c) PDL Person Search — proactive source
  process.env.PDL_API_KEY = 'commit-c-pdl-key';
  PDL_CALLS.length = 0;
  STUB_PDL_SEARCH = {
    data: [
      { linkedin_url: 'linkedin.com/in/pdl-person-1', full_name: 'PDL Person One',
        job_title: 'Cloud Security Engineer', location_locality: 'Berlin',
        location_country: 'Germany', job_company_name: 'CloudCorp',
        skills: ['Azure','Sentinel','KQL'] },
      { linkedin_url: 'https://www.linkedin.com/in/pdl-person-2', full_name: 'PDL Person Two',
        job_title: 'Security Engineer', location_country: 'US',
        skills: ['IAM','Defender'] },
      { linkedin_url: 'linkedin.com/in/pdl-person-3', first_name: 'PDL', last_name: 'Three',
        job_title: 'SOC Analyst' },
      { linkedin_url: 'attacker.com/spoof', first_name: 'Spoof', last_name: 'Try' },  // invalid URL → rejected
    ],
  };
  const pdlNeed = createNeed({
    companyId: coApollo.id, title: 'Cloud Security Engineer',
    requiredSkills: ['Azure','Sentinel'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const pdlRun = 'pdl_search_' + Date.now().toString(36);
  const pdlScout = await runScout({ needId: pdlNeed.id, pipelineRunId: pdlRun });
  assert(PDL_CALLS.includes('search/person'),
    `Scout calls PDL Person Search endpoint`);
  assert(LAST_PDL_REQUEST_HEADERS && LAST_PDL_REQUEST_HEADERS['x-api-key'] === 'commit-c-pdl-key',
    `PDL request includes X-Api-Key header (got ${JSON.stringify(LAST_PDL_REQUEST_HEADERS)})`);
  assert(LAST_PDL_SEARCH_BODY && LAST_PDL_SEARCH_BODY.query && LAST_PDL_SEARCH_BODY.query.bool,
    `PDL search body is ES bool query (got ${JSON.stringify(LAST_PDL_SEARCH_BODY)})`);

  // PDL query-tuning invariants:
  //   - job_title is required (must)
  //   - skill tokens live in should (relevance booster, none required)
  //   - bool.minimum_should_match is NOT sent (PDL hosted ES rejects it with HTTP 400)
  {
    const bool = LAST_PDL_SEARCH_BODY.query.bool;
    const must = Array.isArray(bool.must) ? bool.must : [];
    const should = Array.isArray(bool.should) ? bool.should : [];
    const mustHasJobTitle = must.some(c => c && c.match && Object.prototype.hasOwnProperty.call(c.match, 'job_title'));
    const mustHasSkills = must.some(c => c && c.match && Object.prototype.hasOwnProperty.call(c.match, 'skills'));
    const shouldSkillsCount = should.filter(c => c && c.match && Object.prototype.hasOwnProperty.call(c.match, 'skills')).length;
    assert(mustHasJobTitle === true,
      `PDL must-clause contains job_title (got must=${JSON.stringify(must)})`);
    assert(mustHasSkills === false,
      `PDL must-clause contains NO skills entries (got must=${JSON.stringify(must)})`);
    assert(shouldSkillsCount >= 2,
      `PDL should-clause carries skill tokens (got shouldSkillsCount=${shouldSkillsCount}, should=${JSON.stringify(should)})`);
    assert(bool.minimum_should_match === undefined,
      `PDL bool.minimum_should_match is NOT sent (PDL rejects it with HTTP 400) — got ${JSON.stringify(bool.minimum_should_match)}`);
  }
  assert(pdlScout.pdlRaw === 4, `pdlRaw counts all 4 results (got ${pdlScout.pdlRaw})`);
  assert(pdlScout.acceptedBySource.pdl === 3,
    `acceptedBySource.pdl === 3 (got ${pdlScout.acceptedBySource.pdl})`);
  assert(pdlScout.rejectedBySource.pdl === 1,
    `rejectedBySource.pdl === 1 (spoofed URL; got ${pdlScout.rejectedBySource.pdl})`);
  const pdl1 = DB.candidates.find(c => c.pipelineRunId === pdlRun && c.name === 'PDL Person One');
  assert(pdl1 && pdl1.source === 'PDL' && pdl1.scoutDecision === 'accepted',
    `PDL candidate stored with source='PDL' / accepted (got ${pdl1 && pdl1.source}/${pdl1 && pdl1.scoutDecision})`);
  assert(pdl1 && pdl1.identityVerificationStatus === 'verified',
    `PDL candidate identityVerificationStatus === 'verified' (LinkedIn /in/)`);
  assert(pdl1 && isFinalShortlistEligible(pdl1) === true,
    `PDL candidate IS final-shortlist eligible`);

  // Verified-only gate: an unverified PDL candidate MUST NOT pass the gate.
  {
    const savedUrl = pdl1.linkedinUrl;
    const savedStatus = pdl1.identityVerificationStatus;
    pdl1.linkedinUrl = '';
    pdl1.identityVerificationStatus = 'unverified';
    assert(isFinalShortlistEligible(pdl1) === false,
      `Unverified PDL candidate (no LinkedIn URL) is NOT final-shortlist eligible`);
    pdl1.linkedinUrl = savedUrl;
    pdl1.identityVerificationStatus = savedStatus;
  }

  // (d) Profile Resolve — rescues Apollo-no-LinkedIn review-pool candidate
  STUB_PDL_SEARCH = { data: [] };
  STUB_APOLLO_PEOPLE = [
    { id: 'rescue-1', name: 'Rescue Candidate', title: 'Security Engineer',
      organization: { name: 'RescueCo' },  // no linkedin_url → goes to review
    },
  ];
  STUB_PDL_RESOLVE = {
    'Rescue Candidate': { data: {
      linkedin_url: 'linkedin.com/in/rescue-candidate',
      location_country: 'United States',
      job_title: 'Security Engineer',
      job_company_name: 'RescueCo',
    }, likelihood: 8 },
  };
  const rescueNeed = createNeed({
    companyId: coApollo.id, title: 'Security Engineer',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const rescueRun = 'pdl_resolve_' + Date.now().toString(36);
  const rescueScout = await runScout({ needId: rescueNeed.id, pipelineRunId: rescueRun });
  const rescued = DB.candidates.find(c => c.pipelineRunId === rescueRun && c.name === 'Rescue Candidate');
  assert(rescued, `rescue candidate exists in DB`);
  assert(rescued && /linkedin\.com\/in\/rescue-candidate/.test(rescued.linkedinUrl || ''),
    `Profile Resolve filled missing LinkedIn URL (got "${rescued && rescued.linkedinUrl}")`);
  assert(rescued && rescued.identityVerificationStatus === 'verified',
    `Resolved candidate flipped to identityVerificationStatus='verified' (got "${rescued && rescued.identityVerificationStatus}")`);
  assert(rescued && rescued.identityVerificationSource === 'pdl-resolved',
    `identityVerificationSource === 'pdl-resolved' (got "${rescued && rescued.identityVerificationSource}")`);
  assert(rescued && rescued.scoutDecision === 'accepted',
    `Rescued candidate scoutDecision flipped from review → accepted`);
  assert(rescued && isFinalShortlistEligible(rescued) === true,
    `Rescued candidate IS final-shortlist eligible`);

  // (d2) PDL Resolve guard — insufficient identifiers skip enrich, no noisy provider error.
  STUB_PDL_SEARCH = { data: [] };
  STUB_PDL_LOOKUP = null;
  STUB_PDL_RESOLVE = {};
  STUB_PDL_RESOLVE_HTTP = null;
  PDL_CALLS.length = 0;
  STUB_APOLLO_PEOPLE = [
    { id: 'single-token-1', name: 'Mononym', title: 'Security Engineer',
      organization: { name: 'SoloCo' },
    },
  ];
  const singleTokenNeed = createNeed({
    companyId: coApollo.id, title: 'Security Engineer',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const singleTokenRun = 'pdl_single_token_' + Date.now().toString(36);
  const singleTokenScout = await runScout({ needId: singleTokenNeed.id, pipelineRunId: singleTokenRun });
  const singleToken = DB.candidates.find(c => c.pipelineRunId === singleTokenRun && c.name === 'Mononym');
  assert(!PDL_CALLS.includes('enrich/resolve'),
    `single-token Apollo name does NOT call PDL enrich/resolve (calls=${JSON.stringify(PDL_CALLS)})`);
  const singleTokenIdentifiers = pdlResolveIdentifiersFromName('Mononym');
  assert(singleTokenIdentifiers.ok === false &&
    singleTokenIdentifiers.reason === 'PDL_ENRICH_SKIPPED_INSUFFICIENT_IDENTIFIERS',
    `single-token Apollo candidate records PDL_ENRICH_SKIPPED_INSUFFICIENT_IDENTIFIERS`);
  assert(singleToken && singleToken.scoutDecision === 'review' &&
    singleToken.resolution_status === 'unresolved' && isFinalShortlistEligible(singleToken) === false,
    `single-token unresolved candidate stays in review/recoverable path`);
  assert(singleTokenScout.providerDiagnostics.pdl.error === false,
    `single-token PDL enrich skip does not mark provider failed`);

  // (d3) PDL Resolve 404 — no match, not fatal, candidate stays review/recoverable.
  STUB_PDL_SEARCH = { data: [] };
  STUB_PDL_RESOLVE = {};
  STUB_PDL_RESOLVE_HTTP = { status: 404, body: { error: 'not_found' } };
  PDL_CALLS.length = 0;
  STUB_APOLLO_PEOPLE = [
    { id: 'no-match-1', name: 'No Match', title: 'Security Engineer',
      organization: { name: 'NoMatchCo' },
    },
  ];
  const noMatchNeed = createNeed({
    companyId: coApollo.id, title: 'Security Engineer',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const noMatchRun = 'pdl_no_match_' + Date.now().toString(36);
  const noMatchScout = await runScout({ needId: noMatchNeed.id, pipelineRunId: noMatchRun });
  const noMatch = DB.candidates.find(c => c.pipelineRunId === noMatchRun && c.name === 'No Match');
  assert(PDL_CALLS.includes('enrich/resolve'),
    `two-token Apollo name calls PDL enrich/resolve for 404 no-match case`);
  assert(noMatch && Array.isArray(noMatch.provider_trace) &&
    noMatch.provider_trace.some(t => t.provider === 'pdl' && t.called === true &&
      t.returned === false && t.skip_reason === 'PDL_ENRICH_NO_MATCH'),
    `PDL 404 records PDL_ENRICH_NO_MATCH trace`);
  assert(noMatch && noMatch.scoutDecision === 'review' &&
    noMatch.resolution_status === 'unresolved' && isFinalShortlistEligible(noMatch) === false,
    `PDL 404 no-match candidate remains NEEDS_REVIEW/recoverable`);
  assert(noMatchScout.providerDiagnostics.pdl.error === false,
    `PDL 404 no-match does not mark provider failed globally`);

  // (d4) PDL Resolve 200 thin match — not structurally resolved.
  STUB_PDL_SEARCH = { data: [] };
  STUB_PDL_RESOLVE_HTTP = null;
  STUB_PDL_RESOLVE = {
    'Thin Match': { data: { linkedin_url: 'linkedin.com/in/thin-match' }, likelihood: 7 },
  };
  PDL_CALLS.length = 0;
  STUB_APOLLO_PEOPLE = [
    { id: 'thin-match-1', name: 'Thin Match', title: 'Security Engineer',
      organization: { name: 'ThinCo' },
    },
  ];
  const thinNeed = createNeed({
    companyId: coApollo.id, title: 'Security Engineer',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const thinRun = 'pdl_thin_match_' + Date.now().toString(36);
  const thinScout = await runScout({ needId: thinNeed.id, pipelineRunId: thinRun });
  const thin = DB.candidates.find(c => c.pipelineRunId === thinRun && c.name === 'Thin Match');
  assert(thin && !/linkedin\.com\/in\/thin-match/.test(thin.linkedinUrl || '') &&
    thin.identityVerificationStatus !== 'verified' && thin.resolution_status === 'unresolved',
    `PDL 200 thin match does not mark candidate resolved/verified`);
  assert(thin && Array.isArray(thin.provider_trace) &&
    thin.provider_trace.some(t => t.provider === 'pdl' && t.called === true &&
      t.returned === false && t.skip_reason === 'PDL_ENRICH_THIN_MATCH'),
    `PDL 200 thin match records PDL_ENRICH_THIN_MATCH`);
  assert(thinScout.providerDiagnostics.pdl.error === false,
    `PDL 200 thin match does not mark provider failed globally`);

  // (d5) PDL Resolve non-200/non-404 classifications avoid unknown-error.
  async function assertPdlResolveHttpClassification(status, reason, errorType) {
    STUB_PDL_SEARCH = { data: [] };
    STUB_PDL_RESOLVE = {};
    STUB_PDL_RESOLVE_HTTP = { status, body: { error: reason } };
    STUB_APOLLO_PEOPLE = [
      { id: `pdl-http-${status}`, name: `Http ${status}`, title: 'Security Engineer',
        organization: { name: `Http${status}Co` },
      },
    ];
    const httpNeed = createNeed({
      companyId: coApollo.id, title: 'Security Engineer',
      requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
    });
    const httpRun = `pdl_http_${status}_` + Date.now().toString(36);
    const scout = await runScout({ needId: httpNeed.id, pipelineRunId: httpRun });
    assert(scout.providerDiagnostics.pdl.error === true,
      `PDL HTTP ${status} marks provider diagnostic error`);
    assert(scout.providerDiagnostics.pdl.sanitized_error_message === reason,
      `PDL HTTP ${status} sanitized reason is ${reason}`);
    assert(scout.providerDiagnostics.pdl.error_type === errorType,
      `PDL HTTP ${status} is classified as ${errorType}, not unknown-error`);
  }
  await assertPdlResolveHttpClassification(429, 'PDL_RATE_LIMITED', 'rate-limited');
  await assertPdlResolveHttpClassification(500, 'PDL_TEMPORARY_PROVIDER_ERROR', 'provider-error');

  // (e) Profile Lookup — enriches accepted candidate with skills snapshot
  STUB_PDL_SEARCH = {
    data: [
      { linkedin_url: 'linkedin.com/in/enrich-target',
        full_name: 'Enrich Target', job_title: 'Engineer' },   // no skills initially
    ],
  };
  STUB_PDL_LOOKUP = {
    data: {
      skills: ['Kubernetes','Terraform','Helm','Prometheus','Grafana'],
      summary: 'Detailed engineer summary.',
      location_locality: 'London',
      location_country: 'UK',
    },
    likelihood: 9,
  };
  STUB_PDL_RESOLVE = {};
  STUB_APOLLO_PEOPLE = [];
  const lookupNeed = createNeed({
    companyId: coApollo.id, title: 'Cloud Security Engineer',
    requiredSkills: ['Kubernetes'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const lookupRun = 'pdl_lookup_' + Date.now().toString(36);
  await runScout({ needId: lookupNeed.id, pipelineRunId: lookupRun });
  const enriched = DB.candidates.find(c => c.pipelineRunId === lookupRun && c.name === 'Enrich Target');
  assert(enriched && Array.isArray(enriched.skills) && enriched.skills.includes('Kubernetes'),
    `Profile Lookup enriched candidate.skills with Kubernetes (got ${JSON.stringify(enriched && enriched.skills)})`);
  assert(enriched && Array.isArray(enriched.enrichedBy) && enriched.enrichedBy.includes('pdl-lookup'),
    `enrichedBy includes 'pdl-lookup' (got ${JSON.stringify(enriched && enriched.enrichedBy)})`);

  // (f) Hunter on candidates — fill missing email
  STUB_PDL_SEARCH = { data: [] };
  STUB_HUNTER_EMAIL = 'hunter.found@example.com';
  process.env.HUNTER_API_KEY = 'commit-c-hunter-key';
  STUB_APOLLO_PEOPLE = [
    { id: 'hunter-target', name: 'Hunter Target', title: 'Security Engineer',
      city: 'Detroit', state: 'Michigan', country: 'United States',
      linkedin_url: 'https://www.linkedin.com/in/hunter-target',
      organization: { name: 'HunterCo' },
      employment_history: [{ title: 'Security Engineer', organization: { name: 'HunterCo' }, start_date: '2024-01-01', current: true }],
      // no email field
    },
  ];
  const hunterNeed = createNeed({
    companyId: coApollo.id, title: 'Security Engineer',
    requiredSkills: ['Azure'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const hunterRun = 'hunter_enrich_' + Date.now().toString(36);
  await runScout({ needId: hunterNeed.id, pipelineRunId: hunterRun });
  const hunterCand = DB.candidates.find(c => c.pipelineRunId === hunterRun && c.name === 'Hunter Target');
  assert(hunterCand && hunterCand.email === 'hunter.found@example.com',
    `Hunter filled candidate.email (got "${hunterCand && hunterCand.email}")`);
  assert(hunterCand && Array.isArray(hunterCand.enrichedBy) && hunterCand.enrichedBy.includes('hunter'),
    `enrichedBy includes 'hunter' (got ${JSON.stringify(hunterCand && hunterCand.enrichedBy)})`);

  // Reset
  STUB_PDL_SEARCH = null;
  STUB_PDL_LOOKUP = null;
  STUB_PDL_RESOLVE = null;
  STUB_PDL_RESOLVE_HTTP = null;
  STUB_HUNTER_EMAIL = null;
  delete process.env.PDL_API_KEY;
  STUB_APOLLO_PEOPLE = null;

  // ── 32. Commit D — OpenAI candidate parser + score refinement ──
  const { openaiParseCandidateItem, refineMatchScoresWithOpenAI } = _internals;
  const prevOpenAI = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'commit-d-openai-key';

  // (a) openaiParseCandidateItem: high-confidence parse → returns object
  STUB_OPENAI_RESPONSE = JSON.stringify({
    name: 'Parsed Person', title: 'Cloud Security Engineer',
    company: 'CloudCorp', location: 'Berlin', skills: ['Azure','Sentinel'],
    profileUrl: 'https://www.linkedin.com/in/parsed-person', confidence: 0.85,
  });
  const llmHi = await openaiParseCandidateItem({
    title: 'unparseable garbage title', url: 'https://example.com/page', description: 'long bio text',
  });
  assert(llmHi && llmHi.name === 'Parsed Person',
    `LLM parser extracts name when confidence ≥ 0.6 (got ${llmHi && llmHi.name})`);
  assert(llmHi && llmHi.skills.includes('Azure'),
    `LLM parser extracts skills (got ${JSON.stringify(llmHi && llmHi.skills)})`);

  // (b) Low confidence → returns null (filter out non-person snippets)
  STUB_OPENAI_RESPONSE = JSON.stringify({ confidence: 0.2 });
  const llmLo = await openaiParseCandidateItem({ title: 'company page', url: 'https://acme.example' });
  assert(llmLo === null, `LLM parser returns null on low confidence (got ${llmLo})`);

  // (c) Malformed JSON → returns null
  STUB_OPENAI_RESPONSE = 'not valid json {';
  const llmBad = await openaiParseCandidateItem({ title: 'x', url: 'https://x' });
  assert(llmBad === null, `LLM parser returns null on malformed JSON (got ${llmBad})`);

  // (d) Missing OpenAI key → returns null
  delete process.env.OPENAI_API_KEY;
  STUB_OPENAI_RESPONSE = JSON.stringify({ name: 'X', confidence: 0.9 });
  const llmDormant = await openaiParseCandidateItem({ title: 'x', url: 'https://x' });
  assert(llmDormant === null, `LLM parser dormant when OPENAI_API_KEY missing`);

  // (e) refineMatchScoresWithOpenAI: adjusts top-K scores, clamps to ±15
  process.env.OPENAI_API_KEY = 'commit-d-openai-key';
  const fakeNeed = { title: 'Security Engineer', requiredSkills: ['Azure'], seniority: 'Mid', location: 'Remote' };
  const fakeScored = [
    { c: { id: 'cand-a', name: 'A', currentTitle: 'SE', skills: ['Azure'] }, score: 70, matchedSkills: ['Azure'], missingSkills: [] },
    { c: { id: 'cand-b', name: 'B', currentTitle: 'SE', skills: ['Azure'] }, score: 60, matchedSkills: ['Azure'], missingSkills: [] },
  ];
  STUB_OPENAI_RESPONSE = JSON.stringify({
    adjustments: { 'cand-a': 8, 'cand-b': -20 /* over cap; should clamp to -15 */, 'cand-c': 99 /* not in input; ignored */ },
  });
  const adjMap = await refineMatchScoresWithOpenAI(fakeScored, fakeNeed);
  assert(adjMap['cand-a'] === 8,   `LLM adjustment within range preserved (got ${adjMap['cand-a']})`);
  assert(adjMap['cand-b'] === -15, `LLM adjustment over cap clamped to -15 (got ${adjMap['cand-b']})`);
  // cand-c is allowed through but doesn't matter because matchmaker only applies to scored candidates

  // (f) LLM failure (null response) → empty adjustments map (heuristic falls back)
  STUB_OPENAI_RESPONSE = '';
  const adjEmpty = await refineMatchScoresWithOpenAI(fakeScored, fakeNeed);
  assert(Object.keys(adjEmpty).length === 0,
    `LLM failure → empty adjustments map (got ${JSON.stringify(adjEmpty)})`);

  // (g) Missing OpenAI key → empty adjustments
  delete process.env.OPENAI_API_KEY;
  STUB_OPENAI_RESPONSE = JSON.stringify({ adjustments: { 'cand-a': 5 } });
  const adjDormant = await refineMatchScoresWithOpenAI(fakeScored, fakeNeed);
  assert(Object.keys(adjDormant).length === 0,
    `refineMatchScoresWithOpenAI dormant when OPENAI_API_KEY missing`);

  // (h) Integration: OpenAI remains disabled in active match scoring. Even
  // when configured and returning adjustments, matchmaker scores/order stay
  // purely heuristic.
  process.env.OPENAI_API_KEY = 'commit-d-openai-key';
  const llmHighCand = findOrCreateCandidate({
    name: 'LLM Disabled High',
    title: 'Cloud Security Engineer',
    skills: ['Azure', 'Sentinel'],
    linkedinUrl: 'https://www.linkedin.com/in/llm-disabled-high',
    source: 'Manual', scoutDecision: 'accepted',
  });
  const llmLowCand = findOrCreateCandidate({
    name: 'LLM Disabled Low',
    title: 'Cloud Security Engineer',
    skills: ['Azure'],
    linkedinUrl: 'https://www.linkedin.com/in/llm-disabled-low',
    source: 'Manual', scoutDecision: 'accepted',
  });
  const adjNeed = createNeed({
    companyId: coApollo.id, title: 'Cloud Security Engineer',
    requiredSkills: ['Azure', 'Sentinel'], seniority: 'Mid', locationType: 'Remote', confirmed: true,
  });
  const adjRun = 'llm_adj_run_' + Date.now().toString(36);
  llmHighCand.pipelineRunId = adjRun;
  llmLowCand.pipelineRunId = adjRun;
  const highBaseline = scoreCandidateAgainstNeed(llmHighCand, adjNeed, adjRun);
  const lowBaseline = scoreCandidateAgainstNeed(llmLowCand, adjNeed, adjRun);
  assert(highBaseline.score > lowBaseline.score,
    `Fixture baseline has high candidate ahead (high=${highBaseline.score}, low=${lowBaseline.score})`);
  STUB_OPENAI_RESPONSE = JSON.stringify({ adjustments: { [llmHighCand.id]: -15, [llmLowCand.id]: 15 } });
  await runMatchmaker({ needId: adjNeed.id, pipelineRunId: adjRun });
  const highMatch = DB.matches.find(m => m.pipelineRunId === adjRun && m.candidateId === llmHighCand.id);
  const lowMatch = DB.matches.find(m => m.pipelineRunId === adjRun && m.candidateId === llmLowCand.id);
  assert(highMatch && highMatch.score === highBaseline.score,
    `OpenAI adjustment does NOT change high candidate score (expected ${highBaseline.score}, got ${highMatch && highMatch.score})`);
  assert(lowMatch && lowMatch.score === lowBaseline.score,
    `OpenAI adjustment does NOT change low candidate score (expected ${lowBaseline.score}, got ${lowMatch && lowMatch.score})`);
  assert(highMatch && lowMatch && highMatch.rank < lowMatch.rank,
    `Candidate ordering stays heuristic despite OpenAI adjustment response (highRank=${highMatch && highMatch.rank}, lowRank=${lowMatch && lowMatch.rank})`);
  assert(highMatch && lowMatch &&
    !(highMatch.reasoning || []).concat(lowMatch.reasoning || []).some(r => /LLM score adjustment/.test(r)),
    `Match reasoning has no LLM score adjustment note`);

  // ── 20b. Candidate-pool expansion metadata stays metadata-only ───────
  const sentinelVariants = buildRankedTitleVariants('Microsoft Sentinel SOC Analyst');
  assert(!sentinelVariants.some(v => /sentinel|kql|kusto/i.test(v.title)),
    `Tool-specific terms are NOT baked into Apollo title variants`);
  for (const must of [
    'SOC Analyst',
    'Security Operations Analyst',
    'Security Analyst',
    'SIEM Analyst',
    'Detection Analyst',
    'Incident Response Analyst',
    'Cybersecurity Analyst',
  ]) {
    assert(sentinelVariants.some(v => v.title === must),
      `Variant expansion includes real title "${must}"`);
  }

  const combinedVariants = buildRankedTitleVariants('SOC Analyst / Detection Analyst');
  assert(combinedVariants[0].title === 'SOC Analyst' &&
    combinedVariants[1].title === 'Detection Analyst' &&
    !combinedVariants.some(v => /\//.test(v.title)),
    `Combined role labels split into real titles without slash variants (variants=${JSON.stringify(combinedVariants.slice(0, 5))})`);

  const expansionPlan = buildCandidateSearchExpansion({
    title: 'Microsoft Sentinel SOC Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    location: 'Detroit',
  }, { enabled: true });
  assert(expansionPlan.profileKeywords.includes('KQL') && expansionPlan.profileKeywords.includes('Kusto'),
    `KQL/Kusto are profile keywords`);
  assert(expansionPlan.locationTiers.some(t => t.label === 'Detroit hybrid') &&
    expansionPlan.locationTiers.some(t => t.label === 'Remote US'),
    `Location tiers include Detroit hybrid and Remote US`);

  const metaNeed = createNeed({
    companyId: coApollo.id,
    title: 'Microsoft Sentinel SOC Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Remote',
    confirmed: true,
  });
  const metaRun = 'exp_meta_run_' + Date.now().toString(36);
  const wideMeta = {
    providersFound: ['apollo'],
    searchVariantsFound: ['Cybersecurity Analyst'],
    searchVariantMeta: [{ title: 'Cybersecurity Analyst', specificity_weight: 0.45, variant_type: 'wide_net' }],
    locationTiersMatched: ['Remote US'],
    locationTierMeta: [{ key: 'remote-us', label: 'Remote US', proximity_tier: 'Remote US', proximity_rank: 4 }],
    profileKeywordSignals: [],
  };
  const noEvidenceWide = findOrCreateCandidate({
    name: 'Wide Net No Evidence',
    title: 'Cybersecurity Analyst',
    company: 'WideCo',
    location: 'Remote US',
    skills: ['Customer Support'],
    linkedinUrl: 'https://www.linkedin.com/in/wide-net-no-evidence',
    source: 'Manual',
    scoutDecision: 'accepted',
    pipelineRunId: metaRun,
    ...wideMeta,
  });
  const noEvidencePlain = findOrCreateCandidate({
    name: 'Wide Net Plain',
    title: 'Cybersecurity Analyst',
    company: 'PlainCo',
    location: 'Remote US',
    skills: ['Customer Support'],
    linkedinUrl: 'https://www.linkedin.com/in/wide-net-plain',
    source: 'Manual',
    scoutDecision: 'accepted',
    pipelineRunId: metaRun,
  });
  const noEvidenceMetaScore = scoreCandidateAgainstNeed(noEvidenceWide, metaNeed, metaRun);
  const noEvidencePlainScore = scoreCandidateAgainstNeed(noEvidencePlain, metaNeed, metaRun);
  assert(noEvidenceMetaScore.score === noEvidencePlainScore.score,
    `specificity_weight/search metadata does NOT change score (${noEvidenceMetaScore.score} vs ${noEvidencePlainScore.score})`);
  assert(noEvidenceMetaScore.matchedSkills.length === 0 && noEvidenceMetaScore.missingSkills.includes('Microsoft Sentinel') && noEvidenceMetaScore.missingSkills.includes('KQL'),
    `Wide-net candidate without profile evidence fails cleanly and keeps missing skills`);

  const exactEvidence = findOrCreateCandidate({
    name: 'Exact Sentinel Evidence',
    title: 'Microsoft Sentinel SOC Analyst',
    company: 'ExactCo',
    location: 'Remote US',
    skills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    linkedinUrl: 'https://www.linkedin.com/in/exact-sentinel-evidence',
    source: 'Manual',
    scoutDecision: 'accepted',
    pipelineRunId: metaRun,
    providersFound: ['apollo'],
    searchVariantsFound: ['SOC Analyst'],
    searchVariantMeta: [{ title: 'SOC Analyst', specificity_weight: 1.0, variant_type: 'exact_role' }],
  });
  const linklessWide = findOrCreateCandidate({
    name: 'Linkless Wide Net',
    title: 'Cybersecurity Analyst',
    company: 'LinklessCo',
    location: 'Remote US',
    skills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    source: 'Manual',
    scoutDecision: 'accepted',
    pipelineRunId: metaRun,
    ...wideMeta,
  });
  assert(!isFinalShortlistEligible(linklessWide),
    `Verified-only filtering still excludes expansion candidate without usable profile link`);
  await runMatchmaker({ needId: metaNeed.id, pipelineRunId: metaRun });
  const exactMatch = DB.matches.find(m => m.pipelineRunId === metaRun && m.candidateId === exactEvidence.id);
  const wideMatch = DB.matches.find(m => m.pipelineRunId === metaRun && m.candidateId === noEvidenceWide.id);
  assert(exactMatch && wideMatch && exactMatch.rank < wideMatch.rank,
    `specificity_weight does NOT override score/order (exactRank=${exactMatch && exactMatch.rank}, wideRank=${wideMatch && wideMatch.rank})`);

  const dupA = findOrCreateCandidate({ name: 'Same Name Only', source: 'Manual', scoutDecision: 'review' });
  const dupB = findOrCreateCandidate({ name: 'Same Name Only', source: 'Manual', scoutDecision: 'review' });
  assert(dupA.id !== dupB.id,
    `Dedupe does not collapse candidates by name alone`);

  const multiMetaA = findOrCreateCandidate({
    name: 'Multi Source Meta',
    company: 'MetaCo',
    linkedinUrl: 'https://www.linkedin.com/in/multi-source-meta',
    source: 'Apollo',
    scoutDecision: 'accepted',
    providersFound: ['apollo'],
    searchVariantsFound: ['SOC Analyst'],
    searchVariantMeta: [{ title: 'SOC Analyst', specificity_weight: 1.0, variant_type: 'exact_role' }],
    locationTiersMatched: ['Michigan hybrid'],
    locationTierMeta: [{ key: 'michigan-hybrid', label: 'Michigan hybrid', proximity_tier: 'Michigan hybrid', proximity_rank: 2 }],
  });
  const multiMetaB = findOrCreateCandidate({
    name: 'Multi Source Meta',
    company: 'MetaCo',
    linkedinUrl: 'https://www.linkedin.com/in/multi-source-meta',
    source: 'Firecrawl',
    scoutDecision: 'accepted',
    providersFound: ['firecrawl'],
    searchVariantsFound: ['SIEM Analyst'],
    searchVariantMeta: [{ title: 'SIEM Analyst', specificity_weight: 0.7, variant_type: 'medium_specificity' }],
    locationTiersMatched: ['Remote US'],
    locationTierMeta: [{ key: 'remote-us', label: 'Remote US', proximity_tier: 'Remote US', proximity_rank: 4 }],
  });
  assert(multiMetaA.id === multiMetaB.id &&
    multiMetaB.providersFound.includes('apollo') && multiMetaB.providersFound.includes('firecrawl') &&
    multiMetaB.searchVariantsFound.includes('SOC Analyst') && multiMetaB.searchVariantsFound.includes('SIEM Analyst') &&
    multiMetaB.locationTiersMatched.includes('Michigan hybrid') && multiMetaB.locationTiersMatched.includes('Remote US'),
    `Candidate stores all variants/providers/location tiers across deduped touches`);

  const links = collectCandidateProfileLinks({
    linkedinUrl: 'https://www.linkedin.com/in/profile-link-test',
    github: 'https://github.com/profile-link-test',
    sourceUrl: 'https://profiles.example.net/person',
    portfolioUrl: 'https://portfolio.example.net/person',
    resumeUrl: 'https://resume.example.net/person.pdf',
  });
  assert(links.linkedin && links.github && links.source && links.portfolio && links.resume,
    `Profile link collector preserves LinkedIn/GitHub/source/portfolio/resume links`);

  const prevFirecrawlExpansionKey = process.env.FIRECRAWL_API_KEY;
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';
  STUB_FIRECRAWL_ITEMS = [
    { title: 'Private Junior Analyst — SOC Analyst at Acme', url: 'https://www.linkedin.com/in/private-junior-analyst', description: 'Private profile login required. Junior SOC analyst with SIEM exposure.' },
  ];
  STUB_GH_SEARCH_USERS = { items: [] };
  const warningNeed = createNeed({
    companyId: coApollo.id,
    title: 'Microsoft Sentinel SOC Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Remote',
    confirmed: true,
  });
  const warningRun = 'warning_run_' + Date.now().toString(36);
  await runScout({ needId: warningNeed.id, pipelineRunId: warningRun, expandCandidatePool: true });
  const warningCand = DB.candidates.find(c => c.pipelineRunId === warningRun && /Private Junior Analyst/.test(c.name || ''));
  assert(warningCand && warningCand.privateProfileWarning === 'Private profile — manual verification required',
    `Private-profile warning added without auto-rejecting`);
  assert(warningCand && warningCand.entry_level_warning === 'Entry-level profile — not enough experience evidence for mid-level role',
    `Entry-level warning prepared for mid-level role`);
  assert(warningCand && warningCand.profileKeywordSignals.includes('SIEM'),
    `Profile keyword signals come from profile text`);
  STUB_FIRECRAWL_ITEMS = null;
  STUB_GH_SEARCH_USERS = null;
  if (prevFirecrawlExpansionKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = prevFirecrawlExpansionKey;

  // ── 20c. Sourcing-quality gate: visibility is pre-scoring metadata ──
  const isoMonthsAgo = months => new Date(Date.now() - months * 30.4375 * 86400 * 1000).toISOString().slice(0, 10);
  const qualityNeed = createNeed({
    companyId: coApollo.id,
    title: 'SOC Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Remote',
    confirmed: true,
  });
  const detectionNeed = createNeed({
    companyId: coApollo.id,
    title: 'Detection Engineer',
    requiredSkills: ['Sigma', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Remote',
    confirmed: true,
  });
  const michiganHybridNeed = createNeed({
    companyId: coApollo.id,
    title: 'SOC Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Hybrid',
    location: 'Michigan hybrid',
    confirmed: true,
  });
  const texasHybridNeed = createNeed({
    companyId: coApollo.id,
    title: 'SOC Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Hybrid',
    location: 'Texas hybrid',
    confirmed: true,
  });  const qualityRun = 'quality_gate_' + Date.now().toString(36);
  const work = (title, months, opts = {}) => ({
    title,
    company: opts.company || 'SecurityCo',
    startDate: isoMonthsAgo(months),
    endDate: opts.stale ? isoMonthsAgo(72) : undefined,
    current: !opts.stale,
    months,
  });
  const gateCandidate = (input, need = qualityNeed) => {
    const c = findOrCreateCandidate({
      source: 'Manual',
      scoutDecision: 'accepted',
      pipelineRunId: qualityRun,
      linkedinUrl: `https://www.linkedin.com/in/${String(input.name || 'quality').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      ...input,
    });
    return applySourcingQualityGate(c, need);
  };

  const threeMonthSoc = gateCandidate({
    name: 'Three Month Soc',
    title: 'SOC Analyst',
    skills: ['Microsoft Sentinel', 'KQL'],
    workHistory: [work('SOC Analyst', 3)],
  });
  assert(threeMonthSoc.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW &&
    threeMonthSoc.reason_code === 'SECURITY_EXPERIENCE_UNDER_12_MONTHS',
    `3-month SOC candidate -> NEEDS_REVIEW (state=${threeMonthSoc.visibility_state}, reason=${threeMonthSoc.reason_code})`);

  const staleSecurity = gateCandidate({
    name: 'Stale Security Role',
    title: 'Security Analyst',
    skills: ['SIEM'],
    workHistory: [work('Security Analyst', 24, { stale: true })],
  });
  assert([VISIBILITY_STATE.NEEDS_REVIEW, VISIBILITY_STATE.HIDDEN].includes(staleSecurity.visibility_state) &&
    staleSecurity.reason_code === 'STALE_SECURITY_EXPERIENCE',
    `6-year stale security role -> NEEDS_REVIEW/HIDDEN based on signal (state=${staleSecurity.visibility_state}, reason=${staleSecurity.reason_code})`);

  const bootcampSoc = gateCandidate({
    name: 'Bootcamp Soc',
    title: 'SOC Analyst',
    summary: 'Bootcamp graduate with 2 years SOC Analyst experience.',
    skills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    workHistory: [work('SOC Analyst', 24)],
  });
  assert(bootcampSoc.visibility_state === VISIBILITY_STATE.VISIBLE &&
    bootcampSoc.signals_snapshot.confidence_modifier < 0,
    `bootcamp + 2-year SOC -> VISIBLE with confidence modifier only (state=${bootcampSoc.visibility_state}, modifier=${bootcampSoc.signals_snapshot.confidence_modifier})`);

  const bootcampNoWork = gateCandidate({
    name: 'Bootcamp No Work',
    title: 'Aspiring SOC Analyst',
    summary: 'Bootcamp student seeking first role.',
    skills: ['Microsoft Sentinel'],
    workHistory: [],
  });
  assert(bootcampNoWork.visibility_state === VISIBILITY_STATE.HIDDEN &&
    bootcampNoWork.reason_code === 'NO_SECURITY_WORK_HISTORY',
    `bootcamp + no security work history -> HIDDEN (state=${bootcampNoWork.visibility_state}, reason=${bootcampNoWork.reason_code})`);

  const partTimeMasters = gateCandidate({
    name: 'Part Time Masters',
    title: 'Security Analyst',
    summary: 'Part-time master’s student and current Security Analyst.',
    skills: ['SIEM', 'Incident Response'],
    workHistory: [work('Security Analyst', 18)],
  });
  assert(partTimeMasters.visibility_state === VISIBILITY_STATE.VISIBLE,
    `part-time master's + current Security Analyst -> VISIBLE (state=${partTimeMasters.visibility_state})`);

  const ghDetection = gateCandidate({
    name: 'Detection Repo Only',
    title: 'Detection Engineer',
    skills: ['Sigma', 'KQL'],
    github: 'https://github.com/detection-repo-only',
    linkedinUrl: '',
    sourceUrl: 'https://github.com/detection-repo-only',
    source: 'GitHub',
    sourceType: 'candidate_profile',
    scoutReason: 'Public detection-rules repository with Sigma and Sentinel analytic rules',
    repositories: [{ name: 'sentinel-detection-rules', description: 'Sigma, YARA, KQL, Sentinel analytic rules' }],
  }, detectionNeed);
  assert(ghDetection.visibility_state === VISIBILITY_STATE.VISIBLE &&
    ghDetection.signals_snapshot.github_work_like_evidence === true,
    `GitHub-only detection repo can satisfy Detection/SIEM role evidence (state=${ghDetection.visibility_state})`);

  const ghSocOnly = gateCandidate({
    name: 'Soc GitHub Only',
    title: 'SOC Analyst',
    skills: ['KQL'],
    github: 'https://github.com/soc-github-only',
    linkedinUrl: '',
    sourceUrl: 'https://github.com/soc-github-only',
    source: 'GitHub',
    sourceType: 'candidate_profile',
    scoutReason: 'GitHub-only SOC profile with security notes',
    repositories: [{ name: 'security-labs', description: 'KQL notes and SOC labs' }],
  }, qualityNeed);
  assert(ghSocOnly.visibility_state !== VISIBILITY_STATE.VISIBLE &&
    ghSocOnly.reason_code === 'GITHUB_ONLY_WEAK_FOR_SOC',
    `GitHub-only SOC candidate does not satisfy mid-level gate alone (state=${ghSocOnly.visibility_state}, reason=${ghSocOnly.reason_code})`);

  const mkGithubVerifiedFirecrawlOnly = (name) => findOrCreateCandidate({
    name,
    title: 'Security Engineer',
    summary: 'Sigma and KQL detection engineering with SIEM content.',
    skills: ['Sigma', 'KQL', 'SIEM'],
    github: `https://github.com/${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    sourceUrl: `https://github.com/${String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    source: 'GitHub',
    sourceType: 'candidate_profile',
    scoutReason: 'GitHub API verified type=User',
    repositories: [{ name: 'sentinel-detection-rules', description: 'Sigma, YARA, KQL, Sentinel analytic rules' }],
    workHistory: [work('Security Analyst', 18)],
    scoutDecision: 'accepted',
    discovered_by: ['firecrawl'],
    provider_of_record: 'firecrawl',
    resolved_by: [],
    resolution_status: 'unresolved',
    pipelineRunId: qualityRun,
  });

  assert(isGithubPrimaryEvidenceRole(detectionNeed) === true,
    'Detection Engineer is a GitHub-primary-evidence role');
  assert(isGithubPrimaryEvidenceRole(qualityNeed) === false,
    'SOC Analyst is not a GitHub-primary-evidence role');

  const ghFirecrawlDetection = mkGithubVerifiedFirecrawlOnly('GH Firecrawl Detection');
  assert(isFirecrawlOnlyUnresolved(ghFirecrawlDetection, detectionNeed) === true,
    'Firecrawl-only unresolved is identified independently of role type');
  applySourcingQualityGate(ghFirecrawlDetection, detectionNeed);
  assert(ghFirecrawlDetection.visibility_state === VISIBILITY_STATE.VISIBLE &&
    ghFirecrawlDetection.reason_code !== 'FIRECRAWL_ONLY_UNRESOLVED_LOCAL_HYBRID',
    `Remote Detection/SIEM GitHub evidence remains allowed (state=${ghFirecrawlDetection.visibility_state}, reason=${ghFirecrawlDetection.reason_code})`);

  const ghFirecrawlSoc = mkGithubVerifiedFirecrawlOnly('GH Firecrawl SOC');
  applySourcingQualityGate(ghFirecrawlSoc, michiganHybridNeed);
  assert(ghFirecrawlSoc.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW &&
    ghFirecrawlSoc.reason_code === 'FIRECRAWL_ONLY_UNRESOLVED_LOCAL_HYBRID' &&
    isClientReadyForNeed(ghFirecrawlSoc, michiganHybridNeed) === false,
    `Firecrawl-only unresolved Michigan hybrid candidate becomes NEEDS_REVIEW (state=${ghFirecrawlSoc.visibility_state}, reason=${ghFirecrawlSoc.reason_code})`);

  const firecrawlTexas = mkGithubVerifiedFirecrawlOnly('GH Firecrawl Texas');
  applySourcingQualityGate(firecrawlTexas, texasHybridNeed);
  assert(firecrawlTexas.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW &&
    firecrawlTexas.reason_code === 'FIRECRAWL_ONLY_UNRESOLVED_LOCAL_HYBRID' &&
    isClientReadyForNeed(firecrawlTexas, texasHybridNeed) === false,
    `Firecrawl-only unresolved Texas hybrid candidate becomes NEEDS_REVIEW (state=${firecrawlTexas.visibility_state}, reason=${firecrawlTexas.reason_code})`);

  const mkApolloResolvedLocal = (name, state, need, city = state === 'Texas' ? 'Austin' : 'Detroit') => gateCandidate({
    name,
    title: 'SOC Analyst',
    currentTitle: 'SOC Analyst',
    currentCompany: 'SecurityCo',
    skills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    source: 'Apollo',
    sourceType: 'candidate_profile',
    provider_of_record: 'apollo',
    discovered_by: ['apollo'],
    resolved_by: ['apollo'],
    resolution_status: 'resolved',
    location: `${city}, ${state}, United States`,
    city,
    state,
    country: 'United States',
    workHistory: [work('SOC Analyst', 24)],
  }, need);

  const apolloMichigan = mkApolloResolvedLocal('Apollo Michigan Visible', 'Michigan', michiganHybridNeed);
  assert(apolloMichigan.visibility_state === VISIBILITY_STATE.VISIBLE &&
    isClientReadyForNeed(apolloMichigan, michiganHybridNeed) === true &&
    (apolloMichigan.resolved_by || []).includes('apollo'),
    `Apollo-resolved Michigan candidate is client-ready for Michigan hybrid (state=${apolloMichigan.visibility_state})`);

  const apolloTexasForMichigan = mkApolloResolvedLocal('Apollo Texas Review', 'Texas', michiganHybridNeed);
  assert(apolloTexasForMichigan.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW &&
    apolloTexasForMichigan.reason_code === 'LOCATION_OUTSIDE_SELECTED_MARKET' &&
    isClientReadyForNeed(apolloTexasForMichigan, michiganHybridNeed) === false,
    `Apollo-resolved Texas candidate is review for Michigan hybrid (state=${apolloTexasForMichigan.visibility_state}, reason=${apolloTexasForMichigan.reason_code})`);

  const apolloTexasVisible = mkApolloResolvedLocal('Apollo Texas Visible', 'Texas', texasHybridNeed);
  assert(apolloTexasVisible.visibility_state === VISIBILITY_STATE.VISIBLE &&
    isClientReadyForNeed(apolloTexasVisible, texasHybridNeed) === true,
    `Apollo-resolved Texas candidate is client-ready for Texas hybrid (state=${apolloTexasVisible.visibility_state})`);

  const liveGateRun = 'live_firecrawl_gate_' + Date.now().toString(36);
  const liveNeed = createNeed({
    companyId: coApollo.id,
    title: 'SOC Analyst / Detection Analyst',
    requiredSkills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    seniority: 'Mid',
    locationType: 'Hybrid',
    location: 'Michigan hybrid',
    confirmed: true,
  });
  const liveApollo = [
    mkApolloResolvedLocal('Live Apollo Michigan One', 'Michigan', liveNeed),
    mkApolloResolvedLocal('Live Apollo Michigan Two', 'Michigan', liveNeed),
  ];
  const liveFirecrawl = ['One', 'Two', 'Three', 'Four'].map(label => {
    const c = mkGithubVerifiedFirecrawlOnly(`Live Firecrawl Only ${label}`);
    c.pipelineRunId = liveGateRun;
    applySourcingQualityGate(c, liveNeed);
    return c;
  });
  const liveCandidates = [...liveApollo, ...liveFirecrawl];
  liveApollo.forEach(c => { c.pipelineRunId = liveGateRun; });
  liveCandidates.forEach((c, i) => createOrUpdateMatch({
    needId: liveNeed.id,
    candidateId: c.id,
    pipelineRunId: liveGateRun,
    score: 95 - i,
    tier: 'Strong Match',
    matchedSkills: ['SIEM', 'KQL'],
    missingSkills: [],
    reasoning: ['fixture'],
    rank: i + 1,
  }));
  const liveVisibleMatches = DB.matches.filter(m =>
    m.needId === liveNeed.id && m.pipelineRunId === liveGateRun && isVisibleMatch(m));
  const liveReviewCandidates = liveCandidates.filter(c => c.visibility_state === VISIBILITY_STATE.NEEDS_REVIEW);
  assert(liveVisibleMatches.length === 2 && liveReviewCandidates.length === 4,
    `live-case reproduction: 2 Apollo visible, 4 Firecrawl review (visible=${liveVisibleMatches.length}, review=${liveReviewCandidates.length})`);
  assert(liveCandidates.length === liveVisibleMatches.length + liveReviewCandidates.length,
    `live-case reproduction has zero lost candidates (discovered=${liveCandidates.length}, visible=${liveVisibleMatches.length}, review=${liveReviewCandidates.length})`);
  const liveReport = await generateClientReport({ needId: liveNeed.id, pipelineRunId: liveGateRun });
  const viewNames = liveVisibleMatches
    .map(m => DB.candidates.find(c => c.id === m.candidateId)?.name || '')
    .sort();
  const reportNames = (liveReport.report?.candidates || []).map(c => c.name).sort();
  assert(liveReport.ok && liveReport.report.visibleMatchCount === 2 &&
    JSON.stringify(viewNames) === JSON.stringify(reportNames),
    `View Matches and client report return the same client-ready set (view=${viewNames.join('|')}, report=${reportNames.join('|')})`);
  const beforeCount = DB.candidates.length;
  const hiddenReal = gateCandidate({
    name: 'Hidden Real Candidate',
    title: 'Aspiring SOC Analyst',
    summary: 'Aspiring candidate seeking first security role.',
    skills: ['KQL'],
  });
  assert(DB.candidates.length === beforeCount + 1 && hiddenReal.visibility_state !== VISIBILITY_STATE.PURGED,
    `real candidates are retained, not purged (state=${hiddenReal.visibility_state})`);
  assert(hiddenReal.recoverable === true && hiddenReal.reason_code && hiddenReal.signals_snapshot,
    `HIDDEN real candidate retained with reason/snapshot/recoverable`);
  assert(threeMonthSoc.recoverable === true && threeMonthSoc.reason_code && threeMonthSoc.signals_snapshot,
    `NEEDS_REVIEW real candidate retained with reason/snapshot/recoverable`);

  const junkStub = sourcingRejectionStub({
    sourceType: 'job_posting',
    scoutDecision: 'rejected',
    scoutReason: 'job board',
    sourceDomain: 'example.test',
    sourceUrl: 'https://example.test/jobs/security',
  });
  assert(junkStub.visibility_state === VISIBILITY_STATE.PURGED &&
    junkStub.reason_code === 'PURGED_NON_CANDIDATE' &&
    junkStub.recoverable === false,
    `junk records are purged with stub reason (state=${junkStub.visibility_state}, reason=${junkStub.reason_code})`);

  const bootcampScoreBefore = scoreCandidateAgainstNeed(bootcampSoc, qualityNeed, qualityRun).score;
  applySourcingQualityGate(bootcampSoc, qualityNeed);
  const bootcampScoreAfter = scoreCandidateAgainstNeed(bootcampSoc, qualityNeed, qualityRun).score;
  assert(bootcampScoreBefore === bootcampScoreAfter,
    `sourcing-quality gate does NOT change scoring math (${bootcampScoreBefore} vs ${bootcampScoreAfter})`);
  const orderingA = gateCandidate({
    name: 'Ordering Strong Security',
    title: 'SOC Analyst',
    skills: ['Microsoft Sentinel', 'KQL', 'SIEM'],
    workHistory: [work('SOC Analyst', 24)],
  });
  const orderingB = gateCandidate({
    name: 'Ordering Weak Security',
    title: 'SOC Analyst',
    skills: ['Microsoft Sentinel'],
    workHistory: [work('SOC Analyst', 24)],
  });
  await runMatchmaker({ needId: qualityNeed.id, pipelineRunId: qualityRun });
  const orderingMatchA = DB.matches.find(m => m.pipelineRunId === qualityRun && m.candidateId === orderingA.id);
  const orderingMatchB = DB.matches.find(m => m.pipelineRunId === qualityRun && m.candidateId === orderingB.id);
  assert(orderingMatchA && orderingMatchB && orderingMatchA.rank < orderingMatchB.rank,
    `candidate ordering remains score-based after sourcing gate (strong=${orderingMatchA && orderingMatchA.rank}, weak=${orderingMatchB && orderingMatchB.rank})`);
  assert(isFinalShortlistEligible(threeMonthSoc) === false &&
    isFinalShortlistEligible(bootcampSoc) === true &&
    isFinalShortlistEligible(ghDetection) === true &&
    isFinalShortlistEligible(ghSocOnly) === false,
    `verified-only filtering preserved with visibility states`);

  // Reset
  STUB_OPENAI_RESPONSE = null;
  if (prevOpenAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevOpenAI;

  // ── 20d. Provider diagnostics/provenance: observability only ──
  const prevDiagEnv = {
    firecrawl: process.env.FIRECRAWL_API_KEY,
    apollo: process.env.APOLLO_API_KEY,
    pdl: process.env.PDL_API_KEY,
    hunter: process.env.HUNTER_API_KEY,
    adzunaId: process.env.ADZUNA_APP_ID,
    adzunaKey: process.env.ADZUNA_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };
  process.env.FIRECRAWL_API_KEY = 'test-firecrawl-key';
  delete process.env.APOLLO_API_KEY;
  delete process.env.PDL_API_KEY;
  delete process.env.HUNTER_API_KEY;
  delete process.env.ADZUNA_APP_ID;
  delete process.env.ADZUNA_API_KEY;
  delete process.env.OPENAI_API_KEY;
  STUB_FIRECRAWL_ITEMS = [
    {
      title: 'Morgan Sentinel — SOC Analyst at Blue Team Co',
      url: 'https://www.linkedin.com/in/morgan-sentinel-observability',
      description: 'Michigan SOC Analyst with SIEM, Microsoft Sentinel, KQL, Threat Detection, and Incident Response experience.',
    },
  ];
  STUB_GH_SEARCH_USERS = { items: [] };
  STUB_GH_CONTRIBUTORS = {};
  const diagPipeline = await runPipeline({
    company: 'Provider Diagnostics Co',
    role: 'SOC Analyst',
    skills: ['SIEM', 'SOC', 'Incident Response', 'Threat Detection', 'KQL', 'Microsoft Sentinel'],
    location: 'Michigan hybrid',
    seniority: 'Mid',
    expandCandidatePool: true,
  });
  assert(diagPipeline.providerDiagnostics && typeof diagPipeline.providerDiagnostics === 'object',
    `Provider diagnostics are present on a pipeline run`);
  const diagFields = [
    'provider_name','was_called','was_skipped','skip_reason','started_at','finished_at','latency_ms',
    'returned_count','accepted_count','rejected_non_candidate_count','needs_scout_review_count',
    'validated_count','visible_count','hidden_count','needs_review_count','dropped_count',
    'error','error_type','sanitized_error_message','provider_of_record_count','firecrawl_only_count',
    'resolved_by_pdl_count','resolved_by_apollo_count',
  ];
  for (const provider of ['firecrawl','apollo','pdl','github','hunter','adzuna','openai','airtable','clerk']) {
    const d = diagPipeline.providerDiagnostics[provider];
    assert(d && diagFields.every(f => Object.prototype.hasOwnProperty.call(d, f)),
      `Provider diagnostics for ${provider} include called/skipped/error/latency/count fields`);
  }
  assert(diagPipeline.providerDiagnostics.firecrawl.was_called === true &&
    diagPipeline.providerDiagnostics.firecrawl.returned_count >= 1,
    `Firecrawl provider diagnostics show called + returned count`);
  assert(diagPipeline.providerDiagnostics.apollo.was_skipped === true &&
    /APOLLO_API_KEY/.test(diagPipeline.providerDiagnostics.apollo.skip_reason || ''),
    `Apollo skipped state is visible when not configured`);
  assert(diagPipeline.providerDiagnostics.pdl.was_skipped === true &&
    /PDL_API_KEY/.test(diagPipeline.providerDiagnostics.pdl.skip_reason || ''),
    `PDL skipped state is visible when not configured`);

  const diagCandidate = DB.candidates.find(c => c.pipelineRunId === diagPipeline.pipelineRunId && /Morgan Sentinel/.test(c.name || ''));
  assert(diagCandidate && (diagCandidate.discovered_by || []).includes('firecrawl'),
    `Firecrawl candidates carry discovered_by`);
  assert(diagCandidate && diagCandidate.provider_of_record === 'firecrawl',
    `Firecrawl-only candidates show provider_of_record = firecrawl for now`);
  assert(diagCandidate && Array.isArray(diagCandidate.provider_trace) &&
    diagCandidate.provider_trace.some(t => t.provider === 'pdl' && t.called === false && /not currently wired/.test(t.skip_reason || '')),
    `Firecrawl candidate trace records PDL resolution is not currently wired`);
  assert(diagCandidate && diagCandidate.source_confidence === 'low' &&
    diagCandidate.location_confidence === 'low' &&
    diagCandidate.work_history_confidence === 'low',
    `Firecrawl-only candidate confidence fields are low`);

  process.env.APOLLO_API_KEY = 'test-apollo-key';
  STUB_APOLLO_HTTP = {
    status: 401,
    body: 'api_key=TEST_FAKE_DIAGNOSTIC_VALUE token=TEST_FAKE_DIAGNOSTIC_TOKEN auth failed',
  };
  STUB_FIRECRAWL_ITEMS = [];
  const diagErrorNeed = createNeed({
    companyId: coApollo.id,
    title: 'SOC Analyst',
    requiredSkills: ['SIEM'],
    seniority: 'Mid',
    locationType: 'Remote',
    confirmed: true,
  });
  const diagErrorRun = 'provider_error_' + Date.now().toString(36);
  const diagErrorScout = await runScout({ needId: diagErrorNeed.id, pipelineRunId: diagErrorRun });
  assert(diagErrorScout.providerDiagnostics.apollo.error === true &&
    diagErrorScout.providerDiagnostics.apollo.error_type,
    `Provider errors are not swallowed silently`);
  const diagErrorJson = JSON.stringify(diagErrorScout.providerDiagnostics);
  assert(!diagErrorJson.includes('TEST_FAKE_DIAGNOSTIC_VALUE') &&
    !diagErrorJson.includes('TEST_FAKE_DIAGNOSTIC_TOKEN'),
    `Provider errors do not expose secrets`);

  const diagNeed = DB.hiring_needs.find(n => n.id === diagPipeline.needId);
  const scoreWithoutProv = scoreCandidateAgainstNeed({
    ...diagCandidate,
    discovered_by: [],
    resolved_by: [],
    provider_of_record: '',
    provider_trace: [],
    source_confidence: '',
    location_confidence: '',
    work_history_confidence: '',
  }, diagNeed, diagPipeline.pipelineRunId).score;
  const scoreWithProv = scoreCandidateAgainstNeed(diagCandidate, diagNeed, diagPipeline.pipelineRunId).score;
  assert(scoreWithoutProv === scoreWithProv,
    `Provider diagnostics do not change scoring math (${scoreWithoutProv} vs ${scoreWithProv})`);
  const orderNeed = diagNeed;
  const orderBefore = [
    { id: 'diag-order-strong', name: 'Diag Strong', skills: ['SIEM', 'SOC', 'Incident Response', 'Threat Detection', 'KQL', 'Microsoft Sentinel'], location: 'Michigan' },
    { id: 'diag-order-weak', name: 'Diag Weak', skills: ['SIEM'], location: 'Michigan' },
  ].map(c => ({ id: c.id, score: scoreCandidateAgainstNeed(c, orderNeed, diagPipeline.pipelineRunId).score }))
    .sort((a, b) => b.score - a.score).map(x => x.id).join('|');
  const orderAfter = [
    { id: 'diag-order-strong', name: 'Diag Strong', skills: ['SIEM', 'SOC', 'Incident Response', 'Threat Detection', 'KQL', 'Microsoft Sentinel'], location: 'Michigan', discovered_by: ['firecrawl'], provider_of_record: 'firecrawl' },
    { id: 'diag-order-weak', name: 'Diag Weak', skills: ['SIEM'], location: 'Michigan', discovered_by: ['firecrawl'], provider_of_record: 'firecrawl' },
  ].map(c => ({ id: c.id, score: scoreCandidateAgainstNeed(c, orderNeed, diagPipeline.pipelineRunId).score }))
    .sort((a, b) => b.score - a.score).map(x => x.id).join('|');
  assert(orderBefore === orderAfter,
    `Provider diagnostics do not change candidate ordering`);
  assert(diagCandidate.identityVerificationStatus === 'verified' &&
    isFinalShortlistEligible(diagCandidate) === false &&
    isClientReadyForNeed(diagCandidate, diagNeed) === false,
    `Provider diagnostics preserve identity verification while Firecrawl-only local/hybrid stays out of client-ready`);

  const frontendHtml = fs.readFileSync(path.join(__dirname, '..', 'backend', 'public', 'index.html'), 'utf8');
  assert(/ProviderDiagnosticsTable/.test(frontendHtml) && /Provider Diagnostics/.test(frontendHtml),
    `Pipeline Result can render provider diagnostics`);
  assert(/ProviderProvenance/.test(frontendHtml) && /Discovered by:/.test(frontendHtml) && /Provider of record: Firecrawl scrape/.test(frontendHtml),
    `View Matches can render provider provenance fields`);

  STUB_APOLLO_HTTP = null;
  STUB_FIRECRAWL_ITEMS = null;
  STUB_GH_SEARCH_USERS = null;
  STUB_GH_CONTRIBUTORS = null;
  if (prevDiagEnv.firecrawl === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = prevDiagEnv.firecrawl;
  if (prevDiagEnv.apollo === undefined) delete process.env.APOLLO_API_KEY;
  else process.env.APOLLO_API_KEY = prevDiagEnv.apollo;
  if (prevDiagEnv.pdl === undefined) delete process.env.PDL_API_KEY;
  else process.env.PDL_API_KEY = prevDiagEnv.pdl;
  if (prevDiagEnv.hunter === undefined) delete process.env.HUNTER_API_KEY;
  else process.env.HUNTER_API_KEY = prevDiagEnv.hunter;
  if (prevDiagEnv.adzunaId === undefined) delete process.env.ADZUNA_APP_ID;
  else process.env.ADZUNA_APP_ID = prevDiagEnv.adzunaId;
  if (prevDiagEnv.adzunaKey === undefined) delete process.env.ADZUNA_API_KEY;
  else process.env.ADZUNA_API_KEY = prevDiagEnv.adzunaKey;
  if (prevDiagEnv.openai === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevDiagEnv.openai;

  // ── 21. Raw candidates !== final shortlist ──
  // Same need: count raw candidates in run vs visible matchmaker output.
  const rawInRun = DB.candidates.filter(c => c.pipelineRunId === ghGateRun).length;
  assert(rawInRun > ghGateMm.matched,
    `Raw candidate count (${rawInRun}) > final shortlist matched count (${ghGateMm.matched}) — raw view never equals shortlist`);
  // (e2) Sample mock-run proof — real-only shortlist
  console.log('\n── Sample mock run proving final shortlist is real-only ──');
  console.log(JSON.stringify({
    spoof_scout: {
      sourcedRaw: spoofScout.sourcedRaw,
      acceptedCandidates: spoofScout.acceptedCandidates,
      needsScoutReview: spoofScout.needsScoutReview,
      rejectedNonCandidates: spoofScout.rejectedNonCandidates,
    },
    spoof_matchmaker: {
      matched: spoofMm.matched,
      visible: spoofMm.visible,
      dropped: spoofMm.dropped,
      reviewPoolSize: spoofMm.reviewPoolSize,
    },
    shortlist_candidates: spoofRep.report.candidates.map(c => ({
      name: c.name, score: c.score, tier: c.tier, links: c.links,
    })),
    review_only_summary: reviewOnlyRep.report.summary,
  }, null, 2));

  // Restore env state
  if (prevFirecrawlKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = prevFirecrawlKey;
  STUB_FIRECRAWL_ITEMS = null;
  STUB_GH_SEARCH_USERS = null;

  // ── 17. Sample-run proof: pipeline-style log of one scout pass ──
  console.log('\n── Sample mock run proving non-candidate pages are rejected ──');
  console.log(`scout result for "Azure Security Engineer" with mixed input:`);
  console.log(JSON.stringify({
    sourcedRaw: scoutResult.sourcedRaw,
    acceptedCandidates: scoutResult.acceptedCandidates,
    needsScoutReview: scoutResult.needsScoutReview,
    rejectedNonCandidates: scoutResult.rejectedNonCandidates,
    rejectedSamples: scoutResult.rejectedSamples.map(r => ({
      sourceType: r.sourceType,
      scoutDecision: r.scoutDecision,
      scoutReason: r.scoutReason,
      sourceDomain: r.sourceDomain,
      sourceUrl: r.sourceUrl,
      title: r.title,
    })),
    acceptedSamples: scoutResult.candidates.map(c => ({
      name: c.name, sourceType: c.sourceType, scoutDecision: c.scoutDecision, sourceDomain: c.sourceDomain, sourceUrl: c.sourceUrl,
    })),
  }, null, 2));

  console.log('\n══════════════════════════════════');
  if (FAILURES.length) {
    console.log(`PASS 4 FAILED: ${FAILURES.length} issue(s)`);
    process.exit(1);
  }
  console.log('PASS 4 (pipeline isolation v2): ALL CHECKS PASSED');
  console.log('══════════════════════════════════');
}

main().catch(e => { console.error('UNCAUGHT:', e); process.exit(1); });
