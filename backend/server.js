/**
 * Sola Scholar — V1 internal recruiting tool
 * Express server: serves frontend + all /api routes.
 * Keys live ONLY in process.env. No keys are ever sent to the browser.
 */
'use strict';

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// Load .env if present (local dev only). Silently no-op if dotenv isn't installed.
try { require('dotenv').config(); } catch { /* dotenv optional */ }

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = '0.0.0.0';
const CLIENT_REPORT_CANDIDATE_LIMIT = 5;
// DATA_PATH may point at either the persistent data directory (/data) or the
// JSON file itself (/data/data.json). Support both so production keeps loading
// existing Railway volume data even if the variable was set to the file path.
const DATA_PATH_RAW = process.env.DATA_PATH || path.join(__dirname, '..', 'data');
const DATA_FILE = path.extname(DATA_PATH_RAW).toLowerCase() === '.json'
  ? DATA_PATH_RAW
  : path.join(DATA_PATH_RAW, 'data.json');
const DATA_DIR = path.dirname(DATA_FILE);

// ── Internal auth (HTTP Basic). Required to access /api/* (except /api/health). ──
const INTERNAL_USER = process.env.INTERNAL_USER || 'sola';
const INTERNAL_PASSWORD = process.env.INTERNAL_PASSWORD || ''; // refuse if blank in prod

// ── Service config shape (used only to report which envs are set, never the values) ──
const SERVICES = {
  apollo:   { envs: ['APOLLO_API_KEY'] },
  firecrawl:{ envs: ['FIRECRAWL_API_KEY'] },
  github:   { envs: ['GITHUB_TOKEN'] },
  hunter:   { envs: ['HUNTER_API_KEY'] },
  adzuna:   { envs: ['ADZUNA_APP_ID', 'ADZUNA_API_KEY'] },
  openai:   { envs: ['OPENAI_API_KEY'] },
  airtable: { envs: ['AIRTABLE_PAT', 'AIRTABLE_BASE_ID', 'AIRTABLE_TABLE_NAME'] },
  clerk:    { envs: ['CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY'] },
  pdl:      { envs: ['PDL_API_KEY'] },
};
const isConfigured = (svc) => SERVICES[svc] && SERVICES[svc].envs.every(e => !!process.env[e]);

// ── Editable JSON config (role templates + prepared scoring profiles) ──
// Loaded once at startup. A missing or malformed file must never crash the
// server — fall back to an empty config and log a warning.
const CONFIG_DIR = path.join(__dirname, '..', 'config');
function loadJsonConfig(file, fallback) {
  try {
    const full = path.join(CONFIG_DIR, file);
    if (!fs.existsSync(full)) {
      console.warn(`[config] ${file} not found — using fallback`);
      return fallback;
    }
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    console.warn(`[config] failed to load ${file}: ${e.message} — using fallback`);
    return fallback;
  }
}
const ROLE_TEMPLATES = loadJsonConfig('role-templates.json', { version: 0, templates: [] });
// Scoring profiles are PREPARED ONLY. They are never used in score math while
// SCORING_PROFILES.enabled is false. Exposed read-only for reference/UI.
const SCORING_PROFILES = loadJsonConfig('scoring-profiles.json', { version: 0, enabled: false, profiles: [] });

// ── Provider diagnostics ──
// Human-readable per-provider status derived from isConfigured() + the most
// recent activity logs for that provider. Returns ONLY sanitized categories and
// numeric HTTP status codes — never raw response bodies, keys, or secret values.
// Providers with no env vars defined are reported as 'disabled'.
const PROVIDER_LABELS = {
  apollo: 'Apollo', pdl: 'PDL', github: 'GitHub', firecrawl: 'Firecrawl',
  hunter: 'Hunter', adzuna: 'Adzuna', openai: 'OpenAI', airtable: 'Airtable', clerk: 'Clerk',
};
// V1 does not use these providers in the live pipeline path.
const PROVIDER_NOT_USED_IN_V1 = new Set(['clerk']);

function categorizeProviderError(log) {
  const status = log?.meta?.status;
  const reason = String(log?.meta?.reason || log?.message || '').toLowerCase();
  if (/key missing|missing key|not configured/.test(reason)) return 'missing-key';
  if (/plan|restricted|upgrade|subscription|not entitled|forbidden plan/.test(reason)) return 'plan-restricted';
  if (status === 401 || status === 403) return 'auth-rejected';
  if (status === 429 || /rate limit|too many requests/.test(reason)) return 'rate-limited';
  if (status === 400 || status === 422 || /invalid|too long|bad request/.test(reason)) return 'bad-request';
  if (typeof status === 'number' && status >= 500) return 'provider-error';
  if (/timeout|timed out|econn|network/.test(reason)) return 'network-error';
  return 'unknown-error';
}

function providerDiagnostics() {
  const recent = (DB.activity_logs || []).filter(l => l?.meta?.source && PROVIDER_LABELS[l.meta.source]);
  return Object.keys(SERVICES).map(svc => {
    const label = PROVIDER_LABELS[svc] || svc;
    const envs = SERVICES[svc].envs || [];
    const configured = isConfigured(svc);
    const logs = recent.filter(l => l.meta.source === svc); // newest first (unshift)
    const last = logs[0] || null;

    let status, detail, lastErrorCategory = null, lastStatus = null;
    if (PROVIDER_NOT_USED_IN_V1.has(svc)) {
      status = configured ? 'configured-unused' : 'disabled';
      detail = 'Not used in V1 pipeline (forward-compatibility only)';
    } else if (!configured) {
      status = envs.length === 0 ? 'disabled' : 'missing-key';
      detail = envs.length === 0 ? 'No credentials defined for this provider' : `Skipped — required env not set (${envs.join(', ')})`;
    } else if (!last) {
      status = 'configured';
      detail = 'Configured — no recent activity recorded yet';
    } else if (last.status === 'error' || last.status === 'warn') {
      status = 'configured-but-failing';
      lastErrorCategory = categorizeProviderError(last);
      lastStatus = typeof last.meta?.status === 'number' ? last.meta.status : null;
      detail = `Last call did not succeed (${lastErrorCategory})`;
    } else {
      status = 'working';
      detail = 'Last call succeeded';
    }
    return {
      provider: svc,
      label,
      configured,
      requiredEnv: envs,
      status,
      detail,
      lastErrorCategory,
      lastHttpStatus: lastStatus,
      lastActivityAt: last?.ts || null,
    };
  });
}

/* ════════════════════════════════════════════════════════════════════
   STORE — JSON file persistence
   ════════════════════════════════════════════════════════════════════ */
const COLLECTIONS = [
  'companies', 'hiring_managers', 'hiring_needs', 'candidates',
  'candidate_validations', 'matches', 'outreach', 'client_reports', 'activity_logs',
];
function emptyDB() { return Object.fromEntries(COLLECTIONS.map(c => [c, []])); }

let DB = emptyDB();
let writePromise = Promise.resolve();

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}
async function loadDB() {
  try {
    await ensureDataDir();
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    DB = emptyDB();
    for (const c of COLLECTIONS) if (Array.isArray(parsed[c])) DB[c] = parsed[c];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('loadDB:', e.message);
    DB = emptyDB();
    await persistDB();
  }
}
async function persistDB() {
  // Serialize writes; atomic rename.
  writePromise = writePromise.then(async () => {
    await ensureDataDir();
    const tmp = DATA_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(DB, null, 2));
    await fsp.rename(tmp, DATA_FILE);
  }).catch(e => console.error('persistDB:', e.message));
  return writePromise;
}

/* ════════════════════════════════════════════════════════════════════
   HELPERS
   ════════════════════════════════════════════════════════════════════ */
let _idCounter = 0;
const uid = () => 'id_' + Date.now().toString(36) + '_' + (++_idCounter).toString(36) + crypto.randomBytes(2).toString('hex');
const now = () => new Date().toISOString();

async function logActivity(agent, message, status = 'info', meta = null) {
  const entry = { id: uid(), agent, message, status, meta, ts: now() };
  DB.activity_logs.unshift(entry);
  if (DB.activity_logs.length > 500) DB.activity_logs.length = 500;
  await persistDB();
  return entry;
}

const norm = {
  url: u => !u ? '' : String(u).trim().toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/+$/,'').replace(/\?.*$/,''),
  linkedin: u => { const n = norm.url(u); return n.includes('linkedin.com/in/') ? n : ''; },
  github: u => {
    const n = norm.url(u);
    if (!n.includes('github.com/')) return '';
    const m = n.match(/github\.com\/([^\/]+)/);
    return m ? `github.com/${m[1]}` : '';
  },
  email: e => (e || '').trim().toLowerCase(),
  name: s => (s || '').trim().toLowerCase().replace(/\s+/g, ' '),
};

function candidateDedupeKey(c) {
  const profile = c.profileUrl || c.sourceProfile || c.sourceUrl || c.portfolioUrl || c.resumeUrl || '';
  const li = norm.linkedin(c.linkedinUrl || c.linkedin || profile || '');
  if (li) return 'li:' + li;
  const gh = norm.github(c.github || c.githubUrl || profile || '');
  if (gh) return 'gh:' + gh;
  const em = norm.email(c.email || '');
  if (em) return 'em:' + em;
  const nm = norm.name(c.name || '');
  const co = norm.name(c.currentCompany || c.company || '');
  if (nm && co) return 'nc:' + nm + '|' + co;
  const loc = norm.name(c.location || '');
  const src = norm.url(profile || '');
  if (nm && loc && src) return 'nls:' + nm + '|' + loc + '|' + src;
  return 'rand:' + uid();
}

const SENTINEL_PROFILE_KEYWORDS = [
  'KQL',
  'Kusto',
  'Microsoft Sentinel',
  'Sentinel analytics rules',
  'SIEM',
  'SOC',
  'Incident Response',
  'Threat Detection',
  'Threat Hunting',
  'Defender',
  'Log Analytics',
];

function normalizeSet(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map(v => String(v == null ? '' : v).trim())
    .filter(Boolean)));
}

function mergeUniqueStrings(a = [], b = []) {
  return normalizeSet([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
}

function mergeUniqueObjects(a = [], b = [], keyFn = item => JSON.stringify(item)) {
  const out = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!item || typeof item !== 'object') continue;
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function candidateProfileText(c = {}) {
  return [
    c.name,
    c.currentTitle || c.title,
    c.currentCompany || c.company,
    c.location,
    c.summary,
    c.bio,
    ...(Array.isArray(c.skills) ? c.skills : []),
    ...(Array.isArray(c.experienceSignals) ? c.experienceSignals : []),
  ].join(' ');
}

function extractProfileKeywordSignals(input) {
  const text = typeof input === 'string' ? input : candidateProfileText(input);
  const low = String(text || '').toLowerCase();
  return SENTINEL_PROFILE_KEYWORDS.filter(k => low.includes(k.toLowerCase()));
}

function looksPrivateProfile(c = {}) {
  const text = [
    c.summary,
    c.scoutReason,
    c.sourceType,
    c.sourceUrl,
    c.profileUrl,
    c.sourceProfile,
  ].join(' ').toLowerCase();
  return /\b(private|restricted|inaccessible|login required|sign in required|not public|unavailable)\b/.test(text);
}

function usableHttpUrl(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\//i.test(s)) return '';
  if (/^(https?:\/\/)?(example\.com|localhost|127\.0\.0\.1)\b/i.test(s)) return '';
  if (/\b(fake|placeholder|dummy|test-only)\b/i.test(s)) return '';
  return s;
}

function collectCandidateProfileLinks(c = {}) {
  const links = {
    linkedin: isLinkedInProfileUrl(c.linkedinUrl || c.linkedin || c.profileUrl || '') ? (c.linkedinUrl || c.linkedin || c.profileUrl || '') : '',
    github: isUsableGitHubProfileUrl(c.github || c.githubUrl || '') ? (c.github || c.githubUrl || '') : '',
    source: usableHttpUrl(c.sourceProfile || c.profileUrl || c.sourceUrl || ''),
    portfolio: usableHttpUrl(c.portfolioUrl || ''),
    resume: usableHttpUrl(c.resumeUrl || ''),
  };
  if (links.source && (links.source === links.linkedin || links.source === links.github || links.source === links.portfolio || links.source === links.resume)) {
    links.source = '';
  }
  return links;
}

function seniorityReviewMetadata(c = {}, need = {}) {
  const roleSeniority = String(need.seniority || '').toLowerCase();
  const text = candidateProfileText(c).toLowerCase();
  const entrySignals = [
    'entry level', 'entry-level', 'junior', 'intern', 'internship',
    'student', 'new grad', 'recent graduate', 'bootcamp',
  ];
  const seniorSignals = [
    'senior', 'lead', 'principal', 'staff', 'architect', 'manager',
    'director', '10 years', '8 years', '7 years', '6 years', '5 years',
  ];
  const entryHit = entrySignals.find(s => text.includes(s));
  const seniorHit = seniorSignals.find(s => text.includes(s));
  const midPlus = ['mid', 'senior', 'staff', 'principal', 'director'].includes(roleSeniority);
  return {
    seniority_signal: seniorHit || entryHit || '',
    experience_level_guess: seniorHit ? 'experienced' : entryHit ? 'entry_level' : 'unknown',
    work_experience_evidence: seniorHit || entryHit || '',
    entry_level_warning: midPlus && entryHit && !seniorHit
      ? 'Entry-level profile — not enough experience evidence for mid-level role'
      : '',
  };
}

function buildRankedTitleVariants(role = '') {
  const raw = String(role || '').trim();
  const low = raw.toLowerCase();
  const sentinelRole = /sentinel|soc|siem|detection|threat|incident response/i.test(low);
  const variants = [];
  const add = (title, specificity_weight, variant_type) => {
    if (!title) return;
    const key = title.toLowerCase();
    if (variants.some(v => v.title.toLowerCase() === key)) return;
    variants.push({ title, specificity_weight, variant_type });
  };
  if (raw) add(raw, 1.0, sentinelRole ? 'exact_tool_role' : 'input_role');
  if (sentinelRole) {
    [
      'Microsoft Sentinel SOC Analyst',
      'Microsoft Sentinel Analyst',
      'Microsoft Sentinel Detection Analyst',
      'SIEM Detection Analyst',
    ].forEach(t => add(t, 1.0, 'exact_tool_role'));
    [
      'SOC Analyst',
      'Security Operations Analyst',
      'SIEM Analyst',
      'Detection Analyst',
      'Threat Detection Analyst',
      'Incident Response Analyst',
    ].forEach(t => add(t, 0.7, 'medium_specificity'));
    [
      'Cybersecurity Analyst',
      'Azure Security Analyst',
    ].forEach(t => add(t, 0.45, 'wide_net'));
  } else {
    for (const t of expandRoleToTitles(raw)) {
      add(t, t.toLowerCase() === low ? 1.0 : 0.65, t.toLowerCase() === low ? 'input_role' : 'related_role');
    }
  }
  return variants;
}

function buildLocationTiers(need = {}) {
  const custom = String(need.location || '').trim();
  const tiers = [];
  const add = (key, label, rank, searchLocation) => {
    if (!tiers.some(t => t.key === key)) {
      tiers.push({ key, label, proximity_tier: label, proximity_rank: rank, searchLocation });
    }
  };
  if (custom && !/^remote$/i.test(custom)) add('role-location', `${custom} hybrid`, 1, custom);
  add('detroit-hybrid', 'Detroit hybrid', 1, 'Detroit, Michigan');
  add('michigan-hybrid', 'Michigan hybrid', 2, 'Michigan');
  add('midwest-hybrid', 'Midwest hybrid', 3, 'Midwest');
  add('remote-us', 'Remote US', 4, 'United States');
  return tiers;
}

function inferLocationTier(location = '', tiers = buildLocationTiers()) {
  const low = String(location || '').toLowerCase();
  if (!low) return null;
  const match = tiers.find(t => {
    const loc = String(t.searchLocation || '').toLowerCase();
    const label = String(t.label || '').toLowerCase();
    if (t.key === 'remote-us') return /\bremote\b|united states|\busa\b|\bus\b/.test(low);
    if (t.key === 'midwest-hybrid') return /midwest|michigan|ohio|illinois|indiana|wisconsin|minnesota|detroit|chicago|cleveland|columbus|milwaukee|minneapolis/.test(low);
    return (loc && low.includes(loc)) || (label && low.includes(label.replace(/\s*hybrid\s*/g, '').trim()));
  });
  return match || null;
}

function buildCandidateSearchExpansion(need = {}, { enabled = false } = {}) {
  const titleVariants = buildRankedTitleVariants(need.title || '');
  const locationTiers = buildLocationTiers(need);
  const profileKeywords = /sentinel|soc|siem|detection|threat|incident response|defender|kql|kusto/i.test([
    need.title,
    ...(Array.isArray(need.requiredSkills) ? need.requiredSkills : []),
  ].join(' '))
    ? SENTINEL_PROFILE_KEYWORDS.slice()
    : normalizeSet(need.requiredSkills || []).slice(0, 8);
  return {
    enabled: !!enabled,
    titleVariants,
    profileKeywords,
    locationTiers,
  };
}

function sourceMetadata({ provider, sourceLabel = '', query = '', variantMetas = [], locationTier = null, profileText = '', expansionEnabled = false } = {}) {
  const cleanVariants = (Array.isArray(variantMetas) ? variantMetas : [])
    .filter(v => v && v.title)
    .map(v => ({
      title: String(v.title),
      specificity_weight: Number.isFinite(Number(v.specificity_weight)) ? Number(v.specificity_weight) : null,
      variant_type: String(v.variant_type || ''),
    }));
  return {
    providersFound: provider ? [provider] : [],
    searchVariantsFound: cleanVariants.map(v => v.title),
    searchVariantMeta: cleanVariants,
    locationTiersMatched: locationTier ? [locationTier.label || locationTier.proximity_tier || locationTier.key] : [],
    locationTierMeta: locationTier ? [{
      key: locationTier.key || '',
      label: locationTier.label || locationTier.proximity_tier || '',
      proximity_tier: locationTier.proximity_tier || locationTier.label || '',
      proximity_rank: Number.isFinite(Number(locationTier.proximity_rank)) ? Number(locationTier.proximity_rank) : null,
    }] : [],
    sourceSearches: [{
      provider: provider || '',
      sourceLabel,
      query,
      variants: cleanVariants.map(v => v.title),
      variantTypes: normalizeSet(cleanVariants.map(v => v.variant_type)),
      locationTier: locationTier ? (locationTier.label || locationTier.proximity_tier || '') : '',
      specificityWeights: cleanVariants.map(v => v.specificity_weight).filter(v => v !== null),
      expansionEnabled: !!expansionEnabled,
    }].filter(s => s.provider || s.query || s.variants.length || s.locationTier),
    profileKeywordSignals: extractProfileKeywordSignals(profileText),
  };
}

function mergeCandidateSourceMetadata(c, input = {}) {
  c.providersFound = mergeUniqueStrings(c.providersFound, input.providersFound || (input.source ? [input.source] : []));
  c.searchVariantsFound = mergeUniqueStrings(c.searchVariantsFound, input.searchVariantsFound);
  c.locationTiersMatched = mergeUniqueStrings(c.locationTiersMatched, input.locationTiersMatched);
  c.profileKeywordSignals = mergeUniqueStrings(
    c.profileKeywordSignals,
    mergeUniqueStrings(input.profileKeywordSignals, extractProfileKeywordSignals(input.profileText || candidateProfileText(c))),
  );
  c.searchVariantMeta = mergeUniqueObjects(c.searchVariantMeta, input.searchVariantMeta, v => String(v.title || '').toLowerCase());
  c.locationTierMeta = mergeUniqueObjects(c.locationTierMeta, input.locationTierMeta, v => String(v.key || v.label || '').toLowerCase());
  c.sourceSearches = mergeUniqueObjects(c.sourceSearches, input.sourceSearches, s => JSON.stringify({
    provider: s.provider || '',
    sourceLabel: s.sourceLabel || '',
    query: s.query || '',
    locationTier: s.locationTier || '',
    variants: s.variants || [],
  }));
  const tightest = (c.locationTierMeta || [])
    .filter(t => Number.isFinite(Number(t.proximity_rank)))
    .sort((a, b) => Number(a.proximity_rank) - Number(b.proximity_rank))[0];
  if (tightest) {
    c.proximity_tier = tightest.proximity_tier || tightest.label || '';
    c.proximity_rank = Number(tightest.proximity_rank);
  } else if (input.proximity_tier) {
    c.proximity_tier = input.proximity_tier;
    c.proximity_rank = Number.isFinite(Number(input.proximity_rank)) ? Number(input.proximity_rank) : c.proximity_rank || null;
  }
  if (input.privateProfileWarning && !c.privateProfileWarning) c.privateProfileWarning = input.privateProfileWarning;
  if (input.entry_level_warning && !c.entry_level_warning) c.entry_level_warning = input.entry_level_warning;
  for (const f of ['seniority_signal','experience_level_guess','work_experience_evidence','reviewStatus']) {
    if (input[f] && !c[f]) c[f] = input[f];
  }
  return c;
}

function applyReviewMetadata(c, need = {}, meta = {}) {
  if (!c) return c;
  const locationTier = meta.locationTier || inferLocationTier(c.location || '', buildLocationTiers(need));
  const seniority = seniorityReviewMetadata(c, need);
  const privateProfileWarning = looksPrivateProfile(c)
    ? 'Private profile — manual verification required'
    : '';
  mergeCandidateSourceMetadata(c, {
    ...meta,
    ...(locationTier ? sourceMetadata({ locationTier }).locationTierMeta.length ? {
      locationTiersMatched: [locationTier.label || locationTier.proximity_tier || locationTier.key],
      locationTierMeta: sourceMetadata({ locationTier }).locationTierMeta,
    } : {} : {}),
    privateProfileWarning,
    reviewStatus: privateProfileWarning ? 'Needs Manual Review' : c.reviewStatus || '',
    ...seniority,
  });
  return c;
}

/* ── Repository helpers (CRUD + dedupe) ───────────────────────────── */
function findOrCreateCompany({ name, domain, industry, size, hqLocation, pipelineRunId }) {
  if (!name) return null;
  const key = norm.name(name);
  let co = DB.companies.find(c => norm.name(c.name) === key);
  if (co) {
    if (domain && !co.domain) co.domain = domain;
    if (industry && !co.industry) co.industry = industry;
    if (size && !co.size) co.size = size;
    if (hqLocation && !co.hqLocation) co.hqLocation = hqLocation;
  } else {
    co = { id: uid(), name, domain: domain||'', industry: industry||'', size: size||'', hqLocation: hqLocation||'', hiringSignals: [], notes: '', pipelineRunId: pipelineRunId || null, createdAt: now() };
    DB.companies.push(co);
  }
  return co;
}

function findOrCreateManager({ name, title, companyId, email, emailConfidence='unknown', linkedinUrl='', roleCategory='Other', source='Manual', pipelineRunId }) {
  if (!name || !companyId) return null;
  const li = norm.linkedin(linkedinUrl);
  const em = norm.email(email);
  let m = null;
  if (li) m = DB.hiring_managers.find(x => norm.linkedin(x.linkedinUrl) === li);
  if (!m && em) m = DB.hiring_managers.find(x => norm.email(x.email) === em && x.companyId === companyId);
  if (!m) m = DB.hiring_managers.find(x => norm.name(x.name) === norm.name(name) && x.companyId === companyId);
  if (m) {
    if (title && !m.title) m.title = title;
    if (email && !m.email) { m.email = email; m.emailConfidence = emailConfidence; }
    if (linkedinUrl && !m.linkedinUrl) m.linkedinUrl = linkedinUrl;
  } else {
    m = { id: uid(), companyId, name, title: title||'', roleCategory, email: email||'', emailConfidence, linkedinUrl: linkedinUrl||'', status: 'researching', source, pipelineRunId: pipelineRunId || null, createdAt: now() };
    DB.hiring_managers.push(m);
  }
  return m;
}

function createNeed(input) {
  const need = {
    id: uid(),
    companyId: input.companyId,
    managerId: input.managerId || null,
    title: input.title || '',
    description: input.description || '',
    requiredSkills: Array.isArray(input.requiredSkills) ? input.requiredSkills : [],
    tools: Array.isArray(input.tools) ? input.tools : [],
    seniority: input.seniority || 'Mid',
    locationType: input.locationType || 'Remote',
    location: input.location || '',
    salaryRange: input.salaryRange || '',
    sourceUrl: input.sourceUrl || '',
    postedAt: input.postedAt || now(),
    confirmed: !!input.confirmed,
    confirmationEvidence: Array.isArray(input.confirmationEvidence) ? input.confirmationEvidence : [],
    urgency: input.urgency || 'Medium',
    status: input.status || 'open',
    pipelineRunId: input.pipelineRunId || null,
    createdAt: now(),
  };
  DB.hiring_needs.push(need);
  return need;
}

function findOrCreateCandidate(input) {
  const key = candidateDedupeKey(input);
  let c = DB.candidates.find(x => x.dedupeKey === key);
  if (c) {
    const fields = ['name','currentTitle','currentCompany','location','github','linkedinUrl','portfolioUrl','resumeUrl','profileUrl','sourceProfile','email','phone','summary','avatarUrl','sourceUrl','sourceType','scoutDecision','scoutReason','sourceDomain','sourceChannel','scoutScore','scoutScoreReasons','scoutSourceLabel','scoutQuery','experienceScore','experienceSignals','privateProfileWarning','seniority_signal','experience_level_guess','work_experience_evidence','entry_level_warning','reviewStatus'];
    for (const f of fields) if (input[f] && !c[f]) c[f] = input[f];
    if (input.linkedin && !c.linkedinUrl) c.linkedinUrl = input.linkedin;
    if (input.githubUrl && !c.github) c.github = input.githubUrl;
    if (input.profileUrl && !c.sourceProfile) c.sourceProfile = input.profileUrl;
    if (Array.isArray(input.skills) && input.skills.length) {
      c.skills = Array.from(new Set([...(c.skills||[]), ...input.skills]));
    }
    if (input.pipelineRunId) c.pipelineRunId = input.pipelineRunId;
    // First-touch attribution: do NOT overwrite scout source fields when another
    // source touched the same candidate first. This preserves Apollo's
    // "Apollo people search candidate result" reason even if Firecrawl
    // independently surfaces the same LinkedIn /in/ URL afterward.
    if (input.sourceType && !c.sourceType) c.sourceType = input.sourceType;
    if (input.scoutDecision && !c.scoutDecision) c.scoutDecision = input.scoutDecision;
    if (input.scoutReason && !c.scoutReason) c.scoutReason = input.scoutReason;
    if (input.sourceDomain && !c.sourceDomain) c.sourceDomain = input.sourceDomain;
  } else {
    c = {
      id: uid(),
      name: input.name || '',
      currentTitle: input.currentTitle || input.title || '',
      currentCompany: input.currentCompany || input.company || '',
      location: input.location || '',
      skills: Array.isArray(input.skills) ? input.skills : [],
      github: input.github || input.githubUrl || '',
      linkedinUrl: input.linkedinUrl || input.linkedin || (input.profileUrl && input.profileUrl.includes('linkedin.com') ? input.profileUrl : ''),
      portfolioUrl: input.portfolioUrl || input.website || '',
      resumeUrl: input.resumeUrl || '',
      profileUrl: input.profileUrl || '',
      sourceProfile: input.sourceProfile || input.profileUrl || '',
      summary: input.summary || input.bio || '',
      email: input.email || '',
      phone: input.phone || '',
      source: input.source || 'Manual',
      sourceUrl: input.sourceUrl || '',
      sourceType: input.sourceType || (input.source === 'Manual' ? 'candidate_profile' : 'unknown'),
      scoutDecision: input.scoutDecision || (input.source === 'Manual' ? 'accepted' : 'review'),
      scoutReason: input.scoutReason || (input.source === 'Manual' ? 'manual entry' : ''),
      sourceDomain: input.sourceDomain || '',
      sourceChannel: input.sourceChannel || input.source || 'Manual',
      scoutScore: Number.isFinite(input.scoutScore) ? input.scoutScore : null,
      scoutScoreReasons: Array.isArray(input.scoutScoreReasons) ? input.scoutScoreReasons : [],
      scoutSourceLabel: input.scoutSourceLabel || '',
      scoutQuery: input.scoutQuery || '',
      experienceScore: Number.isFinite(input.experienceScore) ? input.experienceScore : null,
      experienceSignals: Array.isArray(input.experienceSignals) ? input.experienceSignals : [],
      providersFound: [],
      searchVariantsFound: [],
      searchVariantMeta: [],
      locationTiersMatched: [],
      locationTierMeta: [],
      sourceSearches: [],
      profileKeywordSignals: [],
      proximity_tier: '',
      proximity_rank: null,
      privateProfileWarning: input.privateProfileWarning || '',
      seniority_signal: input.seniority_signal || '',
      experience_level_guess: input.experience_level_guess || '',
      work_experience_evidence: input.work_experience_evidence || '',
      entry_level_warning: input.entry_level_warning || '',
      reviewStatus: input.reviewStatus || '',
      avatarUrl: input.avatarUrl || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(input.name || 'U')}`,
      dedupeKey: key,
      pipelineRunId: input.pipelineRunId || null,
      // Identity verification block (computed below).
      identityVerificationStatus: 'review',
      identityVerificationSource: '',
      identityVerificationReason: '',
      verifiedProfileUrl: '',
      verifiedAt: '',
      createdAt: now(),
    };
    DB.candidates.push(c);
  }
  mergeCandidateSourceMetadata(c, input);
  // Always re-compute identity verification on every touch so the candidate
  // record stays consistent with its current URL fields.
  refreshIdentityVerification(c);
  return c;
}

function createValidation(candidateId, payload) {
  const v = {
    id: uid(),
    candidateId,
    pipelineRunId: payload.pipelineRunId || null,
    validatedAt: now(),
    tier: payload.tier || 'Insufficient Data',
    proficiency: payload.proficiency || {},
    githubStats: payload.githubStats || null,
    certifications: payload.certifications || [],
    projects: payload.projects || [],
    evidenceNotes: payload.evidenceNotes || '',
  };
  DB.candidate_validations.push(v);
  // Validation may unlock GitHub identity verification (Verified Active /
  // Profile-Based). Refresh the candidate's identityVerification fields so
  // downstream eligibility checks see the upgraded state without needing a
  // separate read path.
  const cand = DB.candidates.find(x => x.id === candidateId);
  if (cand) refreshIdentityVerification(cand);
  return v;
}
function latestValidation(candidateId, pipelineRunId = null) {
  // When pipelineRunId is provided, strictly scope to that run — do NOT borrow
  // validation evidence from another run. When null, return latest across all
  // runs (backward-compatible for manual /api/* paths).
  let all = DB.candidate_validations.filter(v => v.candidateId === candidateId);
  if (pipelineRunId) all = all.filter(v => v.pipelineRunId === pipelineRunId);
  if (!all.length) return null;
  return all.slice().sort((a, b) => new Date(b.validatedAt) - new Date(a.validatedAt))[0];
}
// MVP tiering: 80–100 Strong Match · 60–79 Review · 40–59 Weak Match · <40 Drop
function tierFromScore(score) {
  if (score >= 80) return 'Strong Match';
  if (score >= 60) return 'Review';
  if (score >= 40) return 'Weak Match';
  return 'Drop';
}

const CYBERSECURITY_EVIDENCE_TERMS = [
  'CISSP', 'CCSP', 'CISM', 'Security+', 'AZ-500', 'SC-200', 'SC-100',
  'Azure Security', 'Microsoft Sentinel', 'KQL', 'SIEM', 'SOC',
  'Incident Response', 'IAM', 'Defender for Cloud', 'Cloud Security',
];
function hasCybersecurityEvidence(candidate = {}, match = {}, validation = null) {
  const evidenceText = [
    candidate.name,
    candidate.currentTitle,
    candidate.currentCompany,
    candidate.summary,
    ...(candidate.skills || []),
    ...(match.matchedSkills || []),
    ...(match.reasoning || []),
    validation?.evidenceNotes,
    ...(validation?.certifications || []),
    ...(validation?.projects || []),
  ].join(' ').toLowerCase();
  return CYBERSECURITY_EVIDENCE_TERMS.some(term => evidenceText.includes(term.toLowerCase()));
}
function matchDisplayLabel(score, candidate = {}, match = {}, validation = null) {
  if (score >= 70) return 'Strong Match';
  if (score >= 60) return 'Good Match';
  if (score >= 50) return hasCybersecurityEvidence(candidate, match, validation)
    ? 'Relevant Security Profile'
    : 'Partial Match';
  return 'Weak Match';
}
function matchDisplayHelper(score, label) {
  if (score >= 50 && score < 60 && label === 'Relevant Security Profile') {
    return 'Partial role fit — review missing skills before client submission.';
  }
  if (score >= 50 && score < 60) return 'Partial role fit — review missing skills before client submission.';
  if (score < 50) return 'Weak role fit — review carefully before client submission.';
  return '';
}

function createOrUpdateMatch({ needId, candidateId, pipelineRunId = null, score, tier, matchedSkills, missingSkills, reasoning, rank, dropReason = '', reviewReason = '' }) {
  // Match identity is run-scoped: (needId, candidateId, pipelineRunId).
  // Same candidate + same need across two runs creates two distinct records,
  // preserving historical run isolation.
  let m = DB.matches.find(x =>
    x.needId === needId &&
    x.candidateId === candidateId &&
    (x.pipelineRunId || null) === (pipelineRunId || null)
  );
  if (m) {
    Object.assign(m, {
      score, tier, matchedSkills, missingSkills, reasoning, rank,
      dropReason, reviewReason,
    });
  } else {
    m = {
      id: uid(), needId, candidateId,
      pipelineRunId: pipelineRunId || null,
      score, tier,
      matchedSkills: matchedSkills||[], missingSkills: missingSkills||[],
      reasoning: reasoning||[], rank: rank||0,
      status: 'proposed',
      dropReason, reviewReason,
      createdAt: now(),
    };
    DB.matches.push(m);
  }
  return m;
}

function createOutreach({ managerId, needId, matchIds, channel = 'email', subject, body, kind }) {
  const o = {
    id: uid(),
    managerId,
    needId: needId || null,
    matchIds: matchIds || [],
    channel,
    subject: subject || '',
    body: body || '',
    kind: kind || (needId ? 'shortlist-pitch' : 'warm-intro'),
    status: 'drafted',
    sentAt: null, repliedAt: null, replyText: '', nextAction: '',
    createdAt: now(),
  };
  DB.outreach.push(o);
  return o;
}

function createClientReport(input) {
  const r = {
    id: uid(),
    needId: input.needId,
    pipelineRunId: input.pipelineRunId || null,
    companyName: input.companyName || '',
    roleTitle: input.roleTitle || '',
    summary: input.summary || '',
    candidates: input.candidates || [],
    candidateLimit: input.candidateLimit || null,
    visibleMatchCount: input.visibleMatchCount || null,
    emailDraft: input.emailDraft || '',
    csv: input.csv || '',
    createdAt: now(),
  };
  DB.client_reports.push(r);
  return r;
}

/* ════════════════════════════════════════════════════════════════════
   EXTERNAL API CLIENTS — all server-side, keys never leave this process
   ════════════════════════════════════════════════════════════════════ */
const SKILL_LIBRARY = [
  'Azure','AWS','GCP','Sentinel','Defender','Splunk','KQL','SIEM','SOC','SOAR','IAM','Zero Trust','MITRE',
  'Kubernetes','Terraform','Docker','CI/CD','DevOps','Linux',
  'Python','JavaScript','TypeScript','React','Node.js','Java','Go','Ruby','PHP','C++','C#','Rust','Swift','Kotlin',
  'TensorFlow','PyTorch','Pandas','SQL','PostgreSQL','MongoDB','Redis','Snowflake',
  'Figma','UX Research','Prototyping',
];
function extractSkills(text) {
  const t = (text || '').toLowerCase();
  const found = new Set();
  for (const s of SKILL_LIBRARY) {
    const re = new RegExp('(?:^|[^a-z0-9])' + s.toLowerCase().replace(/[+#.]/g, '\\$&') + '(?:[^a-z0-9]|$)', 'i');
    if (re.test(t)) found.add(s);
  }
  return Array.from(found);
}
function detectSeniority(text) {
  const t = (text || '').toLowerCase();
  if (/\bprincipal\b/.test(t)) return 'Principal';
  if (/\bstaff\b/.test(t)) return 'Staff';
  if (/\bdirector\b/.test(t)) return 'Director';
  if (/\bsenior\b|\bsr\.?\b|\blead\b/.test(t)) return 'Senior';
  if (/\bjunior\b|\bjr\.?\b|\bentry\b|\bgrad\b/.test(t)) return 'Junior';
  return 'Mid';
}
function categorizeManagerTitle(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('ciso') || t.includes('chief information security')) return 'CISO';
  if (t.includes('director') && t.includes('security')) return 'Director-Security';
  if (t.includes('cloud security')) return 'Cloud-Security-Mgr';
  if (t.includes('soc')) return 'SOC-Mgr';
  if (t.includes('head of infra') || t.includes('infrastructure')) return 'Head-Infra';
  if (t.includes('vp') && (t.includes('eng') || t.includes('security'))) return 'VP-Eng';
  if (t.includes('talent') || t.includes('recruiter')) return t.includes('talent') ? 'TA-Partner' : 'Technical-Recruiter';
  if (t.includes('engineering manager') || t.includes('director of engineering')) return 'Director-Security';
  return 'Other';
}

async function apolloSearch({ titles, industry }) {
  if (!isConfigured('apollo')) return { ok: false, reason: 'APOLLO_API_KEY missing', people: [] };
  // Same Apollo cap rule as candidate path: trim, dedupe (case-insensitive),
  // drop empties, cap at APOLLO_PERSON_TITLES_MAX = 25. Prevents Apollo HTTP
  // 422 "Invalid value for person_titles: too long (max 25)" on any caller.
  const cleanTitles = normalizeApolloTitles(titles);
  if (!cleanTitles.length) return { ok: false, reason: 'no titles to search', people: [] };
  const body = { person_titles: cleanTitles, page: 1, per_page: 15 };
  if (industry) body.q_keywords = industry;
  const res = await fetch('https://api.apollo.io/v1/mixed_people/api_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': process.env.APOLLO_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, reason: `Apollo HTTP ${res.status}`, people: [] };
  const data = await res.json();
  return { ok: true, people: data.people || [] };
}

// Apollo's mixed_people/search enforces a max of 25 entries on person_titles.
// Normalize before sending: trim whitespace, drop empties, dedupe
// case-insensitively, cap at 25. Order-preserving so the highest-priority
// titles from expandRoleToTitles survive the cap.
const APOLLO_PERSON_TITLES_MAX = 25;
function normalizeApolloTitles(titles) {
  if (!Array.isArray(titles)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of titles) {
    const t = String(raw == null ? '' : raw).trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= APOLLO_PERSON_TITLES_MAX) break;
  }
  return out;
}

// Apollo people search tuned for CANDIDATE sourcing (not hiring managers).
// Accepts title variants + optional location/seniority/keyword filters.
async function apolloCandidateSearch({ titles, locations = [], seniorities = [], keywords = '', perPage = 25, page = 1 } = {}) {
  if (!isConfigured('apollo')) return { ok: false, reason: 'APOLLO_API_KEY missing', people: [] };
  const cleanTitles = normalizeApolloTitles(titles);
  if (!cleanTitles.length) return { ok: false, reason: 'no titles to search', people: [] };
  const body = {
    person_titles: cleanTitles,
    page,
    per_page: Math.min(Math.max(perPage, 1), 100),
  };
  if (Array.isArray(locations) && locations.length) body.person_locations = locations;
  if (Array.isArray(seniorities) && seniorities.length) body.person_seniorities = seniorities;
  if (keywords) body.q_keywords = keywords;
  let res;
  try {
    res = await fetch('https://api.apollo.io/v1/mixed_people/api_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', 'X-Api-Key': process.env.APOLLO_API_KEY },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, reason: `Apollo fetch error`, people: [] };
  }
  if (!res.ok) {
    // Capture Apollo's non-2xx body so the operator can see Apollo's exact
    // error in the Scout activity log (e.g. "plan does not support q_keywords",
    // "person_titles array too long"). Redact any value that looks like a key,
    // token, password, or authorization header; truncate to 600 chars.
    let raw = '';
    try { raw = await res.text(); } catch { raw = ''; }
    const redacted = String(raw || '')
      .replace(/(api[_-]?key|password|secret|token|bearer|authorization)\s*[:=]\s*["']?[A-Za-z0-9_\-.]+["']?/gi, '$1=<REDACTED>')
      .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '<REDACTED-LONG-TOKEN>')
      .slice(0, 600);
    return {
      ok: false,
      reason: `Apollo HTTP ${res.status}`,
      status: res.status,
      endpoint: '/v1/mixed_people/api_search',
      body: redacted,
      people: [],
    };
  }
  const data = await res.json();
  return { ok: true, people: data.people || [] };
}

// Firecrawl multi-query Scout — targeted boards / sites that consistently
// host candidate evidence:
//   • LinkedIn /in/  → strong-accept via classifier
//   • Wellfound /u/  → review pool via classifier step 2.5
//   • Dice talent    → mixed
//   • Built In       → mixed
//   • Conference speaker pages (security ICP)
// Each query is sent to firecrawlSearch with a small per-query limit; results
// are merged + deduped by URL in runScout before classification.
function buildFirecrawlBoardQueries(need) {
  const role = String(need && need.title || '').trim();
  const skillList = Array.isArray(need && need.requiredSkills) ? need.requiredSkills.slice(0, 3) : [];
  const skills = skillList.join(' ');
  const out = [];
  if (!role) return out;
  // Wellfound /u/ candidate profiles
  out.push({ source: 'wellfound-u',  query: `site:wellfound.com/u/ "${role}" ${skills}`.trim(), limit: 8 });
  // Dice talent / candidate pages
  out.push({ source: 'dice-talent',  query: `site:dice.com "${role}" ${skills}`.trim(),         limit: 8 });
  // Built In talent listings
  out.push({ source: 'builtin',      query: `site:builtin.com "${role}" ${skills}`.trim(),      limit: 8 });
  // Conference speaker pages for security ICP
  if (/security|sentinel|kql|soc|siem|detection|cyber|defender|incident response|threat|iam/i.test(role.toLowerCase())) {
    out.push({ source: 'security-speaker', query: `"${role}" speaker (site:rsaconference.com OR site:blackhat.com OR site:defcon.org)`, limit: 6 });
  }
  return out;
}

// Generate Apollo title variants from a free-text role string. Keyword-driven
// expansion — no LLM call. Used only for candidate sourcing.
function expandRoleToTitles(role) {
  const r = String(role || '').toLowerCase().trim();
  const set = new Set();
  if (role) set.add(role);
  // Security / cloud-security focused set (highest priority for current ICP).
  // 15 titles — fits well under Apollo's max-25 person_titles cap even when
  // combined with the input role itself.
  const security = [
    'Azure Security Engineer',
    'Cloud Security Engineer',
    'Security Engineer',
    'Cyber Security Engineer',
    'Cybersecurity Engineer',
    'SOC Analyst',
    'Security Analyst',
    'Detection Engineer',
    'Incident Response Analyst',
    'IAM Engineer',
    'IAM Analyst',
    'Cloud Security Analyst',
    'Microsoft Security Engineer',
    'SIEM Engineer',
    'Threat Detection Engineer',
  ];
  const data    = ['Data Engineer','Senior Data Engineer','Analytics Engineer','ML Engineer','Data Platform Engineer','Machine Learning Engineer'];
  const backend = ['Backend Engineer','Backend Developer','Software Engineer','Senior Software Engineer','Staff Software Engineer','Senior Backend Engineer'];
  const devops  = ['DevOps Engineer','Site Reliability Engineer','Platform Engineer','Infrastructure Engineer','Cloud Engineer','Senior DevOps Engineer'];
  const frontend= ['Frontend Engineer','Frontend Developer','UI Engineer','Web Engineer','Senior Frontend Engineer'];
  if (/security|sentinel|kql|soc|siem|detection|cyber|defender|incident response|threat|iam/i.test(r)) security.forEach(t => set.add(t));
  if (/data engineer|analytics|warehouse|etl|spark|airflow|dbt|snowflake|ml engineer|machine learning/i.test(r)) data.forEach(t => set.add(t));
  if (/backend|software|api|server-side|go developer|node|python developer/i.test(r)) backend.forEach(t => set.add(t));
  if (/devops|sre|platform|infra|kubernetes|terraform|cloud engineer/i.test(r)) devops.forEach(t => set.add(t));
  if (/frontend|front-end|react|ui engineer|web developer/i.test(r)) frontend.forEach(t => set.add(t));
  // Always stay safely under Apollo's 25-title cap; the apolloCandidateSearch
  // helper enforces the hard 25 cap defensively as well.
  return Array.from(set).slice(0, 20);
}

const BROAD_SECURITY_TITLES = [
  'Security Analyst',
  'Cybersecurity Engineer',
  'Security Engineer',
  'Cloud Security Engineer',
  'Azure Security Engineer',
  'SOC Analyst',
  'Detection Engineer',
  'Incident Response Analyst',
  'Incident Responder',
  'Threat Hunter',
  'IAM Engineer',
  'SIEM Engineer',
];

function uniqStrings(items, limit = Infinity) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function buildApolloCandidateAttempts(need, { expandCandidatePool = false } = {}) {
  const role = need?.title || '';
  const skills = uniqStrings(need?.requiredSkills || [], 5);
  const primarySkill = skills[0] || '';
  const topSkills = skills.slice(0, 2).join(' ');
  const expandedTitles = expandRoleToTitles(role);
  const roleOnly = role ? [role] : expandedTitles.slice(0, 1);
  const broadTitles = uniqStrings([...expandedTitles, ...BROAD_SECURITY_TITLES], 20);
  const locations = need?.location && !/^remote$/i.test(need.location) ? [need.location] : [];
  const expansion = buildCandidateSearchExpansion(need, { enabled: expandCandidatePool });
  let attempts = [
    { label: 'focused-title-primary-skill', titles: expandedTitles, keywords: primarySkill, locations },
    { label: 'focused-title-top-skills', titles: expandedTitles, keywords: topSkills, locations },
    { label: 'focused-title-only', titles: expandedTitles, keywords: '', locations },
    { label: 'role-title-only-no-location', titles: roleOnly, keywords: '', locations: [] },
    { label: 'expanded-related-titles', titles: broadTitles, keywords: primarySkill, locations: [] },
    { label: 'expanded-related-title-only', titles: broadTitles, keywords: '', locations: [] },
  ];
  attempts = attempts.map(a => ({
    ...a,
    searchVariantMeta: (a.titles || []).map(t => {
      const exact = expansion.titleVariants.find(v => v.title.toLowerCase() === String(t).toLowerCase());
      return exact || { title: t, specificity_weight: 0.65, variant_type: t === role ? 'input_role' : 'related_role' };
    }),
    locationTier: locations.length ? buildLocationTiers(need)[0] : null,
    expandCandidatePool: false,
  }));
  if (expandCandidatePool) {
    const byType = type => expansion.titleVariants.filter(v => v.variant_type === type);
    const groups = [
      { label: 'expanded-high-specificity', variants: byType('exact_tool_role').concat(byType('input_role')), keywords: expansion.profileKeywords.slice(0, 3).join(' ') },
      { label: 'expanded-medium-specificity', variants: byType('medium_specificity').concat(byType('related_role')).slice(0, 10), keywords: expansion.profileKeywords.slice(0, 3).join(' ') },
      { label: 'expanded-wide-net', variants: byType('wide_net').slice(0, 6), keywords: expansion.profileKeywords.slice(0, 2).join(' ') },
    ];
    attempts = [];
    for (const tier of expansion.locationTiers) {
      for (const g of groups) {
        const variants = g.variants.length ? g.variants : expansion.titleVariants.slice(0, 1);
        if (!variants.length) continue;
        attempts.push({
          label: `${g.label}:${tier.key}`,
          titles: variants.map(v => v.title),
          keywords: g.keywords,
          locations: tier.searchLocation ? [tier.searchLocation] : [],
          searchVariantMeta: variants,
          locationTier: tier,
          expandCandidatePool: true,
        });
      }
    }
  }
  const seen = new Set();
  return attempts.filter(a => {
    const titles = normalizeApolloTitles(a.titles);
    if (!titles.length) return false;
    const key = JSON.stringify({ titles: titles.map(t => t.toLowerCase()), keywords: a.keywords || '', locations: a.locations || [] });
    if (seen.has(key)) return false;
    seen.add(key);
    a.titles = titles;
    return true;
  });
}

function quoteTerm(value) {
  return `"${String(value || '').replace(/"/g, '').trim()}"`;
}

function buildFirecrawlProfileQueries(need, { expandCandidatePool = false } = {}) {
  const role = need?.title || 'security analyst';
  const skills = uniqStrings(need?.requiredSkills || [], 6);
  const skillA = skills[0] || 'cybersecurity';
  const skillB = skills[1] || 'security';
  const skillC = skills[2] || '';
  const roleNeedle = /security|cyber|soc|siem|sentinel|defender|iam|incident|threat/i.test(role)
    ? role
    : 'security analyst';
  const dynamic = [
    {
      source: 'linkedin-role-skill',
      query: `site:linkedin.com/in/ ${quoteTerm(roleNeedle)} ${quoteTerm(skillA)}`,
      limit: 10,
    },
    {
      source: 'linkedin-open-to-work-role',
      query: `site:linkedin.com/in/ "Open to Work" ${quoteTerm(roleNeedle)}`,
      limit: 10,
    },
    {
      source: 'linkedin-skills',
      query: `site:linkedin.com/in/ ${quoteTerm(skillA)} ${quoteTerm(skillB)} ${skillC ? quoteTerm(skillC) : ''}`.trim(),
      limit: 10,
    },
  ];
  const fixed = [
    { source: 'linkedin-open-to-work-security-analyst', query: 'site:linkedin.com/in/ "Open to Work" "security analyst"', limit: 10 },
    { source: 'github-readme-open', query: 'site:github.com "looking for work" "cybersecurity" README.md', limit: 10 },
    { source: 'reddit-sysadminjobs', query: '"hiring" "Azure" "remote" site:reddit.com/r/sysadminjobs', limit: 10 },
    { source: 'reddit-forhire', query: 'site:reddit.com/r/forhire "looking for a job" cybersecurity', limit: 10 },
    { source: 'indeed-seeking-work', query: 'site:indeed.com "seeking work" "security engineer"', limit: 10 },
    { source: 'linkedin-open-to-work-azure-sentinel', query: '"Open to Work" "Azure" "Sentinel" site:linkedin.com/in/', limit: 10 },
    { source: 'generic-resume-open-to-work', query: '"security analyst" "open to work" resume', limit: 10 },
  ];
  const seen = new Set();
  let queries = [...dynamic, ...fixed];
  if (expandCandidatePool) {
    const expansion = buildCandidateSearchExpansion(need, { enabled: true });
    const expanded = [];
    for (const tier of expansion.locationTiers) {
      for (const variant of expansion.titleVariants.slice(0, 12)) {
        const keywordPart = expansion.profileKeywords.slice(0, 3).map(quoteTerm).join(' ');
        const locationPart = tier.searchLocation ? quoteTerm(tier.searchLocation) : '';
        expanded.push({
          source: `expand:${variant.variant_type}:${tier.key}`,
          query: `site:linkedin.com/in/ ${quoteTerm(variant.title)} ${locationPart} ${keywordPart}`.trim(),
          limit: variant.variant_type === 'wide_net' ? 6 : 8,
          searchVariantMeta: [variant],
          locationTier: tier,
          expandCandidatePool: true,
        });
      }
    }
    queries = expanded.concat(queries.map(q => ({ ...q, expandCandidatePool: false })));
  }
  return queries.filter(q => {
    const key = q.query.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function firecrawlSearch(query, limit = 10) {
  if (!isConfigured('firecrawl')) return { ok: false, reason: 'FIRECRAWL_API_KEY missing', items: [] };
  const res = await fetch('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
    body: JSON.stringify({ query, limit, lang: 'en' }),
  });
  if (!res.ok) return { ok: false, reason: `Firecrawl HTTP ${res.status}`, items: [] };
  const data = await res.json();
  const items = (data.success && data.data) ? data.data : [];
  return { ok: true, items };
}

async function adzunaSearch({ what, where = '' }) {
  if (!isConfigured('adzuna')) return { ok: false, reason: 'Adzuna not configured', results: [] };
  const url = new URL('https://api.adzuna.com/v1/api/jobs/us/search/1');
  url.searchParams.set('app_id', process.env.ADZUNA_APP_ID);
  url.searchParams.set('app_key', process.env.ADZUNA_API_KEY);
  url.searchParams.set('what', what || '');
  if (where) url.searchParams.set('where', where);
  url.searchParams.set('results_per_page', '15');
  const res = await fetch(url.toString());
  if (!res.ok) return { ok: false, reason: `Adzuna HTTP ${res.status}`, results: [] };
  const data = await res.json();
  return { ok: true, results: data.results || [] };
}

async function githubSearchUsers({ query, perPage = 8 }) {
  const headers = { Accept: 'application/vnd.github.v3+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/search/users?q=${encodeURIComponent(query)}&per_page=${perPage}&sort=joined&order=desc`, { headers });
  if (!res.ok) return { ok: false, reason: `GitHub HTTP ${res.status}`, items: [] };
  const data = await res.json();
  return { ok: true, items: data.items || [] };
}
async function githubUser(login) {
  const headers = { Accept: 'application/vnd.github.v3+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/users/${login}`, { headers });
  if (!res.ok) return null;
  return res.json();
}
async function githubRepos(login) {
  const headers = { Accept: 'application/vnd.github.v3+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/users/${login}/repos?sort=updated&per_page=5`, { headers });
  if (!res.ok) return null;
  return res.json();
}

// Returns the top contributors of a public repo. Used by Scout's
// contributor-mining branch to harvest engineers actively working on
// security/cloud OSS (Azure-Sentinel, SigmaHQ/sigma, etc.). Each contributor
// must pass downstream type==='User' + non-org + non-reserved filters before
// becoming a candidate.
async function githubContributors({ owner, repo, perPage = 30 }) {
  if (!owner || !repo) return { ok: false, items: [] };
  const headers = { Accept: 'application/vnd.github.v3+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let res;
  try {
    res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contributors?per_page=${perPage}`,
      { headers },
    );
  } catch { return { ok: false, items: [] }; }
  if (!res.ok) return { ok: false, status: res.status, items: [] };
  const data = await res.json();
  return { ok: true, items: Array.isArray(data) ? data : [] };
}

// Role-family → canonical OSS repos for contributor mining. Security/cloud
// roles get the strongest signal (Sentinel/SIGMA/MITRE/Azure docs). Other
// families included only where the repo is mature + tightly scoped (avoids
// massive noisy mono-repos like nodejs/node).
function pickReposForRole(role) {
  const r = String(role || '').toLowerCase();
  const security = [
    { owner: 'Azure',         repo: 'Azure-Sentinel' },
    { owner: 'SigmaHQ',       repo: 'sigma' },
    { owner: 'OTRF',          repo: 'Microsoft-Sentinel2Go' },
    { owner: 'MicrosoftDocs', repo: 'azure-docs' },
    { owner: 'mitre-attack',  repo: 'attack-flow' },
  ];
  const devops = [
    { owner: 'hashicorp', repo: 'terraform-provider-azurerm' },
    { owner: 'Azure',     repo: 'bicep' },
    { owner: 'kubernetes-sigs', repo: 'cluster-api-provider-azure' },
  ];
  if (/security|sentinel|kql|soc|siem|detection|cyber|defender|incident response|threat|iam/i.test(r)) return security;
  if (/devops|sre|platform|infra|kubernetes|terraform|cloud engineer/i.test(r))                          return [...security.slice(0, 2), ...devops];
  return [];
}

// ── People Data Labs client (optional; dormant when PDL_API_KEY is missing) ──
// Three call patterns:
//   • Person Search   — proactive candidate source via /v5/person/search
//                       (POST, ES bool query over job_title + skills).
//   • Profile Lookup  — enrich a known LinkedIn URL via /v5/person/enrich
//                       (GET, ?profile=<linkedin_url>).
//   • Profile Resolve — find a missing LinkedIn URL from name + company via
//                       /v5/person/enrich (GET, ?first_name=&last_name=&company=).
// Auth: X-Api-Key header. Returns { ok, items|profile|linkedinUrl, reason, status, body }.
// Failure-safe: any non-2xx or network error returns ok:false; runScout falls
// through gracefully. Body is redacted in error logs.
const PDL_BASE = 'https://api.peopledatalabs.com';

function _pdlRedact(s) {
  return String(s || '')
    .replace(/(api[_-]?key|password|secret|token|bearer|authorization|x-api-key)\s*[:=]\s*["']?[A-Za-z0-9_\-.]+["']?/gi, '$1=<REDACTED>')
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, '<REDACTED-LONG-TOKEN>')
    .slice(0, 600);
}

async function pdlPersonSearch({ role, keywords = '', countries = [], pageSize = 25 } = {}) {
  if (!isConfigured('pdl')) return { ok: false, reason: 'PDL_API_KEY missing', items: [] };
  // ES bool query.
  //   • job_title (and country, if provided) stay in `must` — hard requirements.
  //   • skill tokens go in `should` as pure relevance boosters. PDL's hosted
  //     dialect rejects `minimum_should_match` with HTTP 400, and standard
  //     bool semantics already say: when `must` is present, no `should`
  //     clause is required. Each `should` hit just boosts ranking.
  const must = [];
  if (role) must.push({ match: { job_title: String(role) } });
  if (Array.isArray(countries) && countries.length) {
    must.push({ terms: { location_country: countries.map(c => String(c).toLowerCase()) } });
  }
  const should = [];
  for (const kw of String(keywords || '').split(/\s+/).map(s => s.trim()).filter(Boolean)) {
    should.push({ match: { skills: kw } });
  }
  const bool = { must };
  if (should.length) bool.should = should;
  const body = {
    query: { bool },
    size: Math.min(Math.max(pageSize, 1), 100),
  };
  let res;
  try {
    res = await fetch(`${PDL_BASE}/v5/person/search`, {
      method: 'POST',
      headers: {
        'X-Api-Key': process.env.PDL_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch { return { ok: false, reason: 'PDL fetch error', items: [] }; }
  if (!res.ok) {
    let raw = ''; try { raw = await res.text(); } catch {}
    return { ok: false, reason: `PDL HTTP ${res.status}`, status: res.status, endpoint: '/v5/person/search', body: _pdlRedact(raw), items: [] };
  }
  const data = await res.json();
  // PDL returns { status, data: [...], total }.
  const items = Array.isArray(data && data.data) ? data.data : [];
  return { ok: true, items };
}

async function pdlProfileLookup({ linkedinUrl } = {}) {
  if (!isConfigured('pdl')) return { ok: false, reason: 'PDL_API_KEY missing', profile: null };
  if (!isLinkedInProfileUrl(linkedinUrl)) return { ok: false, reason: 'invalid LinkedIn URL', profile: null };
  const params = new URLSearchParams({ profile: linkedinUrl });
  let res;
  try {
    res = await fetch(`${PDL_BASE}/v5/person/enrich?${params.toString()}`, {
      method: 'GET',
      headers: { 'X-Api-Key': process.env.PDL_API_KEY, 'Accept': 'application/json' },
    });
  } catch { return { ok: false, reason: 'PDL fetch error', profile: null }; }
  if (!res.ok) {
    let raw = ''; try { raw = await res.text(); } catch {}
    return { ok: false, reason: `PDL HTTP ${res.status}`, status: res.status, endpoint: '/v5/person/enrich', body: _pdlRedact(raw), profile: null };
  }
  const data = await res.json();
  // PDL returns { status, likelihood, data: {...} }.
  const profile = (data && data.data) || null;
  return { ok: true, profile, likelihood: (data && data.likelihood) || 0 };
}

async function pdlProfileResolve({ firstName, lastName, companyName } = {}) {
  if (!isConfigured('pdl')) return { ok: false, reason: 'PDL_API_KEY missing', linkedinUrl: '' };
  if (!firstName || !lastName) return { ok: false, reason: 'first_name + last_name required', linkedinUrl: '' };
  const params = new URLSearchParams({ first_name: firstName, last_name: lastName });
  if (companyName) params.set('company', companyName);
  let res;
  try {
    res = await fetch(`${PDL_BASE}/v5/person/enrich?${params.toString()}`, {
      method: 'GET',
      headers: { 'X-Api-Key': process.env.PDL_API_KEY, 'Accept': 'application/json' },
    });
  } catch { return { ok: false, reason: 'PDL fetch error', linkedinUrl: '' }; }
  if (!res.ok) {
    let raw = ''; try { raw = await res.text(); } catch {}
    return { ok: false, reason: `PDL HTTP ${res.status}`, status: res.status, endpoint: '/v5/person/enrich', body: _pdlRedact(raw), linkedinUrl: '' };
  }
  const data = await res.json();
  // PDL returns { status, likelihood, data: { linkedin_url: "linkedin.com/in/..." | full url } }.
  const rec = (data && data.data) || {};
  let url = rec.linkedin_url || '';
  if (url && !/^https?:\/\//i.test(url)) url = `https://www.${url}`;
  return { ok: true, linkedinUrl: isLinkedInProfileUrl(url) ? url : '', likelihood: (data && data.likelihood) || 0 };
}

async function hunterEmailFinder({ domain, fullName }) {
  if (!isConfigured('hunter')) return null;
  const url = new URL('https://api.hunter.io/v2/email-finder');
  url.searchParams.set('api_key', process.env.HUNTER_API_KEY);
  if (domain) url.searchParams.set('domain', domain);
  if (fullName) url.searchParams.set('full_name', fullName);
  const res = await fetch(url.toString());
  if (!res.ok) return null;
  const data = await res.json();
  return data?.data?.email || null;
}

async function openaiComplete(systemPrompt, userPrompt, { maxTokens = 600, model = 'gpt-4o-mini' } = {}) {
  if (!isConfigured('openai')) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        max_tokens: maxTokens,
        temperature: 0.4,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) { return null; }
}

// ── OpenAI candidate parser ──────────────────────────────────────────────
// Used by Scout's Firecrawl branch when the regex parser fails to extract a
// usable name from `item.title`. Returns a structured JSON object with a
// confidence score the caller uses as a gate (>= 0.6 → accept the LLM parse).
// Failure-safe: any LLM error / non-JSON / low confidence returns null.
const OPENAI_PARSE_MAX_PER_RUN = 5;
const OPENAI_SCORE_TOP_K = 10;
const OPENAI_SCORE_MAX_DELTA = 15;

async function openaiParseCandidateItem(item) {
  if (!isConfigured('openai') || !item) return null;
  const sys = 'You extract a single candidate profile from a noisy web page snippet. Return ONLY valid JSON, no prose. Schema: {"name":"First Last","title":"job title or empty","company":"current employer or empty","location":"city or empty","skills":["..."],"profileUrl":"linkedin/github URL or empty","confidence":0..1}. If the snippet is not about an individual person (job posting, blog, company page), return {"confidence":0}.';
  const usr = `Title: ${item.title || ''}\nURL: ${item.url || ''}\nDescription: ${item.description || ''}`;
  const raw = await openaiComplete(sys, usr, { maxTokens: 250 });
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^```json\n?|```$/g, '').trim()); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0.6) return null;
  return {
    name: String(parsed.name || '').trim(),
    title: String(parsed.title || '').trim(),
    company: String(parsed.company || '').trim(),
    location: String(parsed.location || '').trim(),
    skills: Array.isArray(parsed.skills) ? parsed.skills.map(String).slice(0, 20) : [],
    profileUrl: String(parsed.profileUrl || '').trim(),
    confidence,
  };
}

// ── OpenAI score refinement ──────────────────────────────────────────────
// Single batched call: LLM ranks the top-K heuristic-scored candidates
// against the hiring need and returns ±15 score adjustments. Heuristic score
// is preserved as the baseline; LLM only nudges. Failure-safe: any LLM error
// → empty adjustments map → heuristic scores stand.
async function refineMatchScoresWithOpenAI(scored, need) {
  if (!isConfigured('openai')) return {};
  if (!Array.isArray(scored) || !scored.length || !need) return {};
  const topK = scored.slice(0, OPENAI_SCORE_TOP_K);
  const candidatesPayload = topK.map(({ c, score, matchedSkills, missingSkills }) => ({
    id: c.id,
    name: c.name,
    title: c.currentTitle || '',
    company: c.currentCompany || '',
    location: c.location || '',
    skills: (c.skills || []).slice(0, 15),
    heuristicScore: score,
    matchedSkills,
    missingSkills,
  }));
  const sys = `You are a recruiting analyst. Given a hiring need and a ranked list of candidates each with a heuristic score (0-100), output a JSON object mapping candidate id → score adjustment in [-${OPENAI_SCORE_MAX_DELTA}, +${OPENAI_SCORE_MAX_DELTA}]. Positive = better fit than heuristic suggests; negative = worse. Return ONLY JSON in this shape: {"adjustments":{"<id>":<int>, ...}}. Do not include candidates you cannot evaluate.`;
  const usr = `Need: ${JSON.stringify({ title: need.title, requiredSkills: need.requiredSkills, seniority: need.seniority, location: need.location, locationType: need.locationType })}\nCandidates:\n${JSON.stringify(candidatesPayload)}`;
  const raw = await openaiComplete(sys, usr, { maxTokens: 600 });
  if (!raw) return {};
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^```json\n?|```$/g, '').trim()); }
  catch { return {}; }
  const adj = parsed && parsed.adjustments;
  if (!adj || typeof adj !== 'object') return {};
  // Clamp every value to ±OPENAI_SCORE_MAX_DELTA. Non-numeric drops.
  const out = {};
  for (const [id, val] of Object.entries(adj)) {
    const n = Number(val);
    if (!Number.isFinite(n)) continue;
    out[id] = Math.max(-OPENAI_SCORE_MAX_DELTA, Math.min(OPENAI_SCORE_MAX_DELTA, Math.round(n)));
  }
  return out;
}

async function airtablePush(records) {
  if (!isConfigured('airtable') || !records.length) return { pushed: 0 };
  const url = `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${encodeURIComponent(process.env.AIRTABLE_TABLE_NAME)}`;
  let pushed = 0;
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map(fields => ({ fields }));
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch, typecast: true }),
    });
    if (!res.ok) break;
    pushed += batch.length;
  }
  return { pushed };
}

/* ════════════════════════════════════════════════════════════════════
   AGENTS — all run server-side
   ════════════════════════════════════════════════════════════════════ */
const ROLE_TITLES_DEFAULT = [
  'CISO','Chief Information Security Officer','Director of Security','Director of Cloud Security',
  'Director of Engineering','Cloud Security Manager','SOC Manager','Security Operations Manager',
  'Head of Infrastructure','VP of Engineering','VP of Security','Engineering Manager',
  'Technical Recruiter','Talent Acquisition Partner',
];

async function runConnector({ industry = '', titles = [], pipelineRunId = null } = {}) {
  await logActivity('Connector', `Searching managers${industry ? ` in ${industry}` : ''}…`, 'running');
  const useTitles = (Array.isArray(titles) && titles.length) ? titles : ROLE_TITLES_DEFAULT;
  const apollo = await apolloSearch({ titles: useTitles, industry });
  if (!apollo.ok) {
    await logActivity('Connector', apollo.reason, 'warn');
    return { created: 0, managers: [], reason: apollo.reason };
  }

  let kept = 0, skippedNoEmail = 0;
  const created = [];
  for (const p of apollo.people) {
    const name = p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
    const title = p.title || '';
    const orgName = p.organization?.name || '';
    if (!name || !title || !orgName) continue;

    const orgIndustry = p.organization?.industry || industry || '';
    const empCount = p.organization?.employee_count;
    const orgSize = empCount ? `${empCount.toLocaleString()} employees` : '';
    const co = findOrCreateCompany({ name: orgName, industry: orgIndustry, size: orgSize, pipelineRunId });

    let email = p.email || '';
    if (!email && co.domain && isConfigured('hunter')) {
      const found = await hunterEmailFinder({ domain: co.domain, fullName: name });
      if (found) email = found;
    }
    if (!email || !email.includes('@')) { skippedNoEmail++; continue; }

    const m = findOrCreateManager({
      name, title, companyId: co.id, email, emailConfidence: 'verified',
      linkedinUrl: p.linkedin_url || '',
      roleCategory: categorizeManagerTitle(title),
      source: 'Apollo',
      pipelineRunId,
    });
    created.push(m);
    kept++;
  }
  await persistDB();
  await logActivity('Connector', `${kept} managers created · ${skippedNoEmail} skipped (no email)`, 'success', { kept, skippedNoEmail });
  return { created: kept, managers: created, skipped: skippedNoEmail };
}

async function runNeedDetector({ companyId, companyName }) {
  let company = null;
  if (companyId) company = DB.companies.find(c => c.id === companyId);
  else if (companyName) company = findOrCreateCompany({ name: companyName });
  if (!company) {
    await logActivity('Need Detector', 'Company not found', 'error');
    return { detected: 0, needs: [], reason: 'Company not found' };
  }
  await logActivity('Need Detector', `Detecting roles at ${company.name}…`, 'running');

  const detected = [];
  // Try Firecrawl first
  if (isConfigured('firecrawl')) {
    const fc = await firecrawlSearch(`${company.name} careers job opening hiring`, 8);
    for (const item of (fc.items || []).slice(0, 8)) {
      const text = `${item.title || ''} ${item.description || ''}`;
      const rawTitle = (item.title || '').split(/[-–|·]/)[0].trim();
      if (!rawTitle || /blog|news|press|article|read more/i.test(rawTitle)) continue;
      const skills = extractSkills(text);
      const seniority = detectSeniority(rawTitle + ' ' + text);
      const need = createNeed({
        companyId: company.id,
        title: rawTitle.slice(0, 120),
        description: (item.description || '').slice(0, 600),
        requiredSkills: skills,
        seniority,
        sourceUrl: item.url || '',
        confirmed: false,
        confirmationEvidence: item.url ? [item.url] : [],
        urgency: 'Medium',
      });
      detected.push(need);
    }
  }
  // Fallback / supplement: Adzuna
  if (!detected.length && isConfigured('adzuna')) {
    const az = await adzunaSearch({ what: `${company.name}` });
    for (const r of (az.results || []).slice(0, 8)) {
      const skills = extractSkills(`${r.title || ''} ${r.description || ''}`);
      const need = createNeed({
        companyId: company.id,
        title: (r.title || '').slice(0, 120),
        description: (r.description || '').slice(0, 600),
        requiredSkills: skills,
        seniority: detectSeniority(r.title + ' ' + (r.description || '')),
        sourceUrl: r.redirect_url || '',
        confirmed: false,
        confirmationEvidence: r.redirect_url ? [r.redirect_url] : [],
      });
      detected.push(need);
    }
  }
  await persistDB();
  await logActivity('Need Detector', `Detected ${detected.length} roles at ${company.name}`, 'success');
  return { detected: detected.length, needs: detected, company };
}

// Maximum scoutStatsByRun entries to keep per need. Prevents unbounded growth
// across many pipeline runs. Latest-by-`at`-timestamp entries are kept.
const SCOUT_STATS_BY_RUN_CAP = 50;
function pruneScoutStatsByRun(need, cap = SCOUT_STATS_BY_RUN_CAP) {
  const m = need && need.scoutStatsByRun;
  if (!m) return 0;
  const keys = Object.keys(m);
  if (keys.length <= cap) return 0;
  const sorted = keys
    .map(k => ({ k, at: (m[k] && m[k].at) || '' }))
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : 0));
  let removed = 0;
  for (const { k } of sorted.slice(cap)) {
    delete m[k];
    removed++;
  }
  return removed;
}

// ── Source-quality classifier ────────────────────────────────────────────
// Classifies a raw scout item before it becomes a candidate. Job postings,
// blogs, docs, tutorials, company pages, etc. are rejected. Only
// candidate_profile / possible_candidate items flow into Validator/Matchmaker.
//
// Ordered by specificity: subdomain/path-bearing rules must match before
// generic apex-domain rules (e.g. microsoft.com blog/docs before microsoft.com
// company page).
const SCOUT_REJECT_RULES = [
  // Job boards / ATS / hiring pages
  { type: 'job_posting',   re: /(^|\.)ziprecruiter\.com/i,                                       why: 'ZipRecruiter job board' },
  { type: 'job_posting',   re: /(^|\.)indeed\.com/i,                                             why: 'Indeed job board' },
  { type: 'job_posting',   re: /(^|\.)glassdoor\.com/i,                                          why: 'Glassdoor job board' },
  { type: 'job_posting',   re: /linkedin\.com\/jobs/i,                                           why: 'LinkedIn jobs page' },
  { type: 'job_posting',   re: /linkedin\.com\/company\//i,                                      why: 'LinkedIn company page' },
  { type: 'job_posting',   re: /(^|\.)greenhouse\.io/i,                                          why: 'Greenhouse ATS' },
  { type: 'job_posting',   re: /(^|\.)lever\.co/i,                                               why: 'Lever ATS' },
  { type: 'job_posting',   re: /(^|\.)workday\.com|myworkdayjobs\.com/i,                         why: 'Workday ATS' },
  { type: 'job_posting',   re: /(^|\.)smartrecruiters\.com/i,                                    why: 'SmartRecruiters ATS' },
  // Wellfound (ex-AngelList Talent): rule split — reject /jobs/ + /company/
  // pages but allow /u/<username> candidate profiles to pass into classify
  // step 2.5 (review pool, not shortlist until verified).
  { type: 'job_posting',   re: /wellfound\.com\/jobs(?:\/|$)/i,                                   why: 'Wellfound jobs path' },
  { type: 'company_page',  re: /wellfound\.com\/company(?:\/|$)/i,                                why: 'Wellfound company page' },
  { type: 'job_posting',   re: /(^|\.)angel\.co\/jobs(?:\/|$)/i,                                  why: 'AngelList jobs path' },
  { type: 'company_page',  re: /(^|\.)angel\.co\/company(?:\/|$)/i,                               why: 'AngelList company page' },
  { type: 'job_posting',   re: /(^|\.)builtin\.com|(^|\.)dice\.com|(^|\.)monster\.com/i,         why: 'Job board' },
  { type: 'job_posting',   re: /\/careers(\/|$|\?)|\/jobs(\/|$|\?)/i,                            why: 'Careers/jobs page path' },

  // Microsoft blogs/docs/learn (must precede generic microsoft.com)
  { type: 'blog_article',  re: /microsoft\.com\/[^/]+\/security\/blog/i,                         why: 'Microsoft Security Blog' },
  { type: 'blog_article',  re: /(^|\.)blogs\.microsoft\.com/i,                                   why: 'Microsoft Blogs' },
  { type: 'blog_article',  re: /microsoft\.com\/[^/]+\/[^/]+\/blog/i,                            why: 'Microsoft product blog' },
  { type: 'blog_article',  re: /azure\.microsoft\.com\/[^/]+\/blog/i,                            why: 'Azure blog' },
  { type: 'documentation', re: /(^|\.)docs\.microsoft\.com/i,                                    why: 'Microsoft Docs' },
  { type: 'documentation', re: /(^|\.)learn\.microsoft\.com/i,                                   why: 'Microsoft Learn' },
  { type: 'documentation', re: /(^|\.)techcommunity\.microsoft\.com/i,                           why: 'Microsoft Tech Community' },

  // AWS / GCP / common docs+blogs
  { type: 'blog_article',  re: /aws\.amazon\.com\/blogs/i,                                       why: 'AWS Blog' },
  { type: 'documentation', re: /(^|\.)docs\.aws\.amazon\.com/i,                                  why: 'AWS Docs' },
  { type: 'blog_article',  re: /cloud\.google\.com\/blog/i,                                      why: 'Google Cloud Blog' },
  { type: 'documentation', re: /cloud\.google\.com\/docs/i,                                      why: 'Google Cloud Docs' },
  { type: 'documentation', re: /(^|\.)developer\.mozilla\.org/i,                                 why: 'MDN' },
  { type: 'documentation', re: /(^|\.)docs\.python\.org|nodejs\.org\/(docs|api)/i,               why: 'Language docs' },
  { type: 'documentation', re: /(^|\.)kubernetes\.io\/docs|(^|\.)docs\.docker\.com/i,            why: 'Infra docs' },
  { type: 'documentation', re: /(^|\.)wikipedia\.org/i,                                          why: 'Wikipedia' },

  // Generic company pages (apex only — runs last)
  { type: 'company_page',  re: /^(www\.)?microsoft\.com$/i,                                      why: 'Microsoft corporate' },
  { type: 'company_page',  re: /^(www\.)?aws\.amazon\.com$/i,                                    why: 'AWS corporate' },
  { type: 'company_page',  re: /^(www\.)?google\.com$/i,                                         why: 'Google corporate' },
  { type: 'company_page',  re: /^(www\.)?oracle\.com$/i,                                         why: 'Oracle corporate' },
  { type: 'company_page',  re: /^(www\.)?ibm\.com$/i,                                            why: 'IBM corporate' },
  { type: 'company_page',  re: /^(www\.)?cisco\.com$/i,                                          why: 'Cisco corporate' },
];

const SCOUT_TITLE_REJECTS = [
  { type: 'job_posting', re: /\b(now hiring|we'?re hiring|hiring now|join (our|the) team|open positions?|apply now|job opening|position available|career(s)? page|view (open|all) jobs)\b/i, why: 'job-listing language in title' },
  { type: 'tutorial',    re: /^(how to|tutorial[:\s]|step[- ]by[- ]step|getting started with|guide to|beginner'?s guide|learn .+ in \d+)/i, why: 'tutorial pattern' },
  { type: 'documentation', re: /\b(best practices|reference (guide|architecture)|overview of|introduction to|fundamentals of|api reference|product update)\b/i, why: 'documentation pattern' },
];

const GH_RESERVED_LOGINS = new Set([
  'features','pulls','issues','marketplace','explore','topics','login','signup',
  'search','about','pricing','enterprise','sponsors','collections','events',
  'codespaces','customer-stories','readme','site','security','team','trending',
  'organizations','settings','notifications','contact',
]);

// Conservative GitHub organization/company rejection list. These are
// well-known org/brand accounts that GitHub serves at root /<name> but are
// not individuals. Compare lowercased. Without API verification (type ===
// "Organization") we use a static allowlist of known orgs/brands. Casing
// in URL is preserved by GitHub but org status is case-insensitive.
const GH_KNOWN_ORGS = new Set([
  // Cloud/security
  'microsoft','azure','azure-sdk','azure-samples','azuread','aws','aws-samples','amazon',
  'google','googlecloudplatform','meta','facebook','openai','anthropic','apple',
  'oracle','ibm','cisco','sap','salesforce','nvidia','intel','adobe','dell','hp',
  // Infra/devops
  'kubernetes','docker','hashicorp','elastic','grafana','prometheus','vercel','netlify',
  'cloudflare','github','gitlab','bitbucket','digitalocean','linode','redhat','canonical',
  'fluxcd','istio','helm','traefik','envoyproxy','jaegertracing','opentelemetry',
  // Data
  'mongodb','postgres','mysql','redis','snowflake','databricks','confluent','apache',
  'tensorflow','pytorch',
  // Language/framework
  'nodejs','denoland','expo','reactjs','vuejs','angular','sveltejs','remix-run',
  'rust-lang','golang','python','rubyonrails','laravel','symfony','springframework',
  'jestjs','vitest-dev','typescript-eslint','webpack','vitejs','rollup',
]);

// Strict LinkedIn profile-URL check. Parses the URL and verifies hostname is
// linkedin.com (or LinkedIn regional subdomain) AND path starts with /in/.
// Blocks spoofed strings like `https://attacker.com/linkedin.com/in/foo` —
// regex-based path-substring checks would incorrectly accept those.
function isLinkedInProfileUrl(url) {
  if (!url) return false;
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  const okHost = host === 'linkedin.com' || host === 'www.linkedin.com' || /\.linkedin\.com$/.test(host);
  if (!okHost) return false;
  return /^\/in\/[a-z0-9\-_%]+/i.test(u.pathname);
}

// ── Trusted candidate-profile URL helpers (per-platform, host-anchored) ──
// Each accepts only the platform's profile URL shape and rejects reserved /
// system / non-profile paths. No syntactic substring matching — full URL parse,
// hostname allowlist, path regex.

function _parseHttpUrl(url) {
  if (!url) return null;
  let u; try { u = new URL(String(url)); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u;
}

// Shared brand/org-handle blocklist for URL-only profile platforms (GitLab,
// Hugging Face, Kaggle). When a platform exposes /<username> at the root,
// well-known company / project handles must be rejected — they are
// organization landing pages, not individual candidate evidence.
// Compared case-insensitively against the path login segment.
const KNOWN_BRAND_HANDLES = new Set([
  // Cloud / hyperscalers
  'microsoft','google','googlecloud','googlecloudplatform','aws','amazon','azure',
  'azuread','azure-sdk','azure-samples','aws-samples',
  // Big tech
  'apple','meta','facebook','openai','anthropic','oracle','ibm','cisco','sap',
  'salesforce','nvidia','intel','adobe','dell','hp','samsung','xiaomi',
  // Infra / devops
  'kubernetes','docker','hashicorp','elastic','grafana','prometheus','vercel',
  'netlify','cloudflare','github','gitlab','gitlab-org','bitbucket',
  'digitalocean','linode','redhat','canonical','mozilla','fluxcd','istio',
  'helm','traefik','envoyproxy','jaegertracing','opentelemetry',
  // Data / ML
  'mongodb','postgres','postgresql','mysql','redis','snowflake','databricks',
  'confluent','apache','tensorflow','pytorch','huggingface','kaggle',
  // Language / framework
  'nodejs','denoland','expo','reactjs','vuejs','angular','sveltejs','remix-run',
  'rust-lang','golang','python','rubyonrails','laravel','symfony',
  'springframework','jestjs','vitest-dev','typescript-eslint','webpack','vitejs',
  'rollup',
]);

// GitLab user (or group) profile — /<username>. Single-segment, non-reserved.
const GITLAB_RESERVED = new Set([
  'help','explore','dashboard','admin','users','search','api','assets',
  'sitemap.xml','public','-','snippets','sign_in','sign_up','jwt',
  'projects','-','oauth','uploads','robots.txt','favicon.ico','register',
  'login','logout','settings',
]);
function isGitLabUserProfileUrl(url) {
  const u = _parseHttpUrl(url); if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'gitlab.com' && host !== 'www.gitlab.com') return false;
  const m = u.pathname.match(/^\/([a-zA-Z0-9][a-zA-Z0-9._-]{1,254})\/?$/);
  if (!m) return false;
  const handle = m[1].toLowerCase();
  if (GITLAB_RESERVED.has(handle)) return false;
  if (KNOWN_BRAND_HANDLES.has(handle)) return false;
  return true;
}

// Hugging Face user/org profile — /<username>. Single-segment, non-reserved.
const HF_RESERVED = new Set([
  'datasets','spaces','models','docs','api','chat','pricing','login','join',
  'search','tasks','organizations','settings','about','privacy','terms','jobs',
  'blog','learn','posts','enterprise','new','new-space','new-dataset','new-model',
]);
function isHuggingFaceProfileUrl(url) {
  const u = _parseHttpUrl(url); if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'huggingface.co' && host !== 'www.huggingface.co' && host !== 'hf.co') return false;
  const m = u.pathname.match(/^\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,39})\/?$/);
  if (!m) return false;
  const handle = m[1].toLowerCase();
  if (HF_RESERVED.has(handle)) return false;
  if (KNOWN_BRAND_HANDLES.has(handle)) return false;
  return true;
}

// Kaggle profile — /<username>. Single-segment, non-reserved.
const KAGGLE_RESERVED = new Set([
  'datasets','competitions','code','learn','discussions','docs','jobs',
  'login','signup','work','me','general','static','organizations','models',
  'rankings','progression','solutions','notebooks','c','t','user-rankings',
]);
function isKaggleProfileUrl(url) {
  const u = _parseHttpUrl(url); if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'kaggle.com' && host !== 'www.kaggle.com') return false;
  const m = u.pathname.match(/^\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,39})\/?$/);
  if (!m) return false;
  const handle = m[1].toLowerCase();
  if (KAGGLE_RESERVED.has(handle)) return false;
  if (KNOWN_BRAND_HANDLES.has(handle)) return false;
  return true;
}

// Stack Overflow user — /users/<numeric-id>[/slug].
function isStackOverflowUserUrl(url) {
  const u = _parseHttpUrl(url); if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'stackoverflow.com' && host !== 'www.stackoverflow.com') return false;
  return /^\/users\/\d+(?:\/[a-zA-Z0-9._-]+)?\/?$/.test(u.pathname);
}

// Credly profile — /users/<username> ONLY. Badge pages (`/badges/<id>`) are
// NOT accepted as candidate identity evidence: a badge proves a credential
// exists, not that the badge belongs to this candidate (Credly badges can be
// linked but the URL alone has no identity binding for our purposes).
function isCredlyProfileUrl(url) {
  const u = _parseHttpUrl(url); if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'credly.com' && host !== 'www.credly.com') return false;
  return /^\/users\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]*)?\/?$/.test(u.pathname);
}

// TryHackMe profile — /p/<username> (current) or /user/<username>.
function isTryHackMeProfileUrl(url) {
  const u = _parseHttpUrl(url); if (!u) return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'tryhackme.com' && host !== 'www.tryhackme.com') return false;
  return /^\/p\/[a-zA-Z0-9._-]+\/?$/.test(u.pathname)
      || /^\/user\/[a-zA-Z0-9._-]+\/?$/.test(u.pathname);
}

// Hack The Box profile — /profile/<id> or /users/<id> on app.hackthebox.com or hackthebox.com.
function isHackTheBoxProfileUrl(url) {
  const u = _parseHttpUrl(url); if (!u) return false;
  const host = u.hostname.toLowerCase();
  const okHost = host === 'app.hackthebox.com' || host === 'hackthebox.com' || host === 'www.hackthebox.com';
  if (!okHost) return false;
  return /^\/profile\/\d+\/?$/.test(u.pathname)
      || /^\/users\/\d+\/?$/.test(u.pathname);
}

// Wellfound (ex-AngelList Talent) candidate profile — /u/<username>.
function isWellfoundProfileUrl(url) {
  const u = _parseHttpUrl(url); if (!u) return false;
  const host = u.hostname.toLowerCase();
  const okHost = host === 'wellfound.com' || host === 'www.wellfound.com' || host === 'angel.co' || host === 'www.angel.co';
  if (!okHost) return false;
  return /^\/u\/[a-zA-Z0-9._-]+\/?$/.test(u.pathname);
}

// Canonical URL normalization for cross-field linkage (e.g., does this URL
// equal candidate.github?). Strips scheme, www, trailing slash, lowercases.
function _normalizeProfileUrl(url) {
  const u = _parseHttpUrl(url); if (!u) return '';
  return (u.hostname.toLowerCase().replace(/^www\./, '') + u.pathname.replace(/\/+$/, '')).toLowerCase();
}

// Central helper. A URL is a trusted candidate-profile evidence source iff it
// matches one of the platform-specific profile patterns. For GitHub, the URL
// must also be THIS candidate's verified github field — never accept a GitHub
// URL on portfolioUrl/sourceUrl alone without verification linkage.
function isTrustedCandidateProfileUrl(url, candidate = null) {
  if (!url) return false;
  if (isLinkedInProfileUrl(url)) return true;
  // GitHub: only trusted when URL is THIS candidate's github field AND verified.
  if (isUsableGitHubProfileUrl(url)) {
    if (!candidate || !candidate.github) return false;
    if (_normalizeProfileUrl(url) !== _normalizeProfileUrl(candidate.github)) return false;
    return isVerifiedGitHubProfile(candidate);
  }
  return (
    isGitLabUserProfileUrl(url)    ||
    isHuggingFaceProfileUrl(url)   ||
    isKaggleProfileUrl(url)        ||
    isStackOverflowUserUrl(url)    ||
    isCredlyProfileUrl(url)        ||
    isTryHackMeProfileUrl(url)     ||
    isHackTheBoxProfileUrl(url)    ||
    isWellfoundProfileUrl(url)
  );
}

// Real usable profile link check. STRICT — a candidate may only enter the
// final Matchmaker pool / shortlist when one of these resolves to a real
// personal profile URL:
//   • valid LinkedIn personal profile (via isLinkedInProfileUrl)
//   • valid GitHub USER profile URL (host=github.com, root /<login>,
//     login NOT in GH_KNOWN_ORGS or GH_RESERVED_LOGINS)
//   • portfolioUrl / resumeUrl / sourceUrl that ITSELF resolves to one of the
//     above (LinkedIn /in/ or GitHub user). Generic http(s) URLs — company
//     pages, blog posts, job posts, search results, docs pages — do NOT
//     count as profile evidence.
// Excluded: empty fields, `apollo://` synthetic URLs, LinkedIn /company/,
// /jobs/, /pub/, spoofed paths, GitHub repo URLs, GitHub org/reserved roots,
// non-http(s) schemes, any generic hostname.
function isUsableGitHubProfileUrl(url) {
  if (!url) return false;
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') return false;
  // Path must be /<login> root (allow trailing slash). Not /<login>/<repo>.
  const m = u.pathname.match(/^\/([a-z0-9](?:[a-z0-9-]{0,38}))\/?$/i);
  if (!m) return false;
  const login = m[1].toLowerCase();
  // Reject obvious system/reserved GitHub paths AND known-org root pages.
  if (GH_RESERVED_LOGINS.has(login)) return false;
  if (GH_KNOWN_ORGS.has(login)) return false;
  return true;
}
function hasUsableProfileLink(c) {
  if (!c) return false;
  // 1. LinkedIn personal profile (host-anchored)
  if (isLinkedInProfileUrl(c.linkedinUrl)) return true;
  // 2. GitHub user profile (strict — orgs/reserved excluded)
  if (isUsableGitHubProfileUrl(c.github)) return true;
  // 3. portfolioUrl / resumeUrl ONLY when they resolve to a recognized
  //    personal profile URL. A generic http(s) URL is not enough — many
  //    accepted manual/legacy rows could otherwise pass with a company page,
  //    blog post, job post, search result, or docs page in these fields.
  for (const candUrl of [c.portfolioUrl, c.resumeUrl]) {
    if (isLinkedInProfileUrl(candUrl)) return true;
    if (isUsableGitHubProfileUrl(candUrl)) return true;
  }
  // 4. sourceUrl — same strict rule. Generic scrape URLs do not qualify.
  if (isLinkedInProfileUrl(c.sourceUrl)) return true;
  if (isUsableGitHubProfileUrl(c.sourceUrl)) return true;
  return false;
}

// Verified GitHub profile gate. A GitHub URL alone is NOT enough — final
// shortlist eligibility requires evidence that the URL was confirmed to be a
// real user account (not just a syntactically valid /<login>). Manual / legacy
// rows with an unverified github field do not qualify by GitHub alone.
//
// Verification signals (any one is sufficient):
//   1. candidate.source === 'GitHub'  (set only by runScout's GH user-search
//      branch, where the GitHub API already returned a real user record)
//   2. candidate.scoutReason matches 'GitHub API verified type=User' (set
//      by runScout's Firecrawl-GH-verification path after a successful
//      githubUser(login) → type === 'User' lookup)
//   3. latestValidation(candidate.id).tier ∈ {'Verified Active', 'Profile-Based'}
//      — meaning runValidator successfully pulled the user's repos (which
//      requires GitHub to have returned a real user record)
function isVerifiedGitHubProfile(c) {
  if (!c) return false;
  if (!isUsableGitHubProfileUrl(c.github)) return false;
  if (c.source === 'GitHub') return true;
  if (c.scoutReason && /GitHub API verified type=User/i.test(c.scoutReason)) return true;
  const v = latestValidation(c.id);
  if (v && (v.tier === 'Verified Active' || v.tier === 'Profile-Based')) return true;
  return false;
}

// ── Identity verification ────────────────────────────────────────────────
// Each candidate carries an identityVerification* block computed from the
// strongest available evidence on their URL fields. STRICT rules:
//   • LinkedIn /in/ URL on candidate.linkedinUrl  →  verified (linkedin-url-pattern)
//   • GitHub user URL + verification linkage (Scout source / API / repo-pull) → verified (github-api)
//   • Stack Overflow numeric-user URL on any URL field → verified (stackoverflow-url-pattern)
//   • Any other trusted-platform URL (GitLab/HF/Kaggle/Credly/THM/HTB/Wellfound)
//     → review  (URL pattern alone is NOT identity proof for these platforms)
//   • Nothing usable  → review (or rejected if no signal at all)
//
// Final shortlist eligibility is then gated by identityVerificationStatus
// === 'verified' AND verifiedProfileUrl still present on the candidate.
function computeIdentityVerification(c) {
  const empty = {
    identityVerificationStatus: 'review',
    identityVerificationSource: '',
    identityVerificationReason: 'No verified identity evidence',
    verifiedProfileUrl: '',
    verifiedAt: '',
  };
  if (!c) return empty;

  // 1. LinkedIn /in/ profile URL on linkedinUrl is the strongest single signal
  if (isLinkedInProfileUrl(c.linkedinUrl)) {
    return {
      identityVerificationStatus: 'verified',
      identityVerificationSource: 'linkedin-url-pattern',
      identityVerificationReason: 'LinkedIn /in/ profile URL on candidate.linkedinUrl',
      verifiedProfileUrl: c.linkedinUrl,
      verifiedAt: now(),
    };
  }

  // 2. Verified GitHub user (Scout source / API verification / repo-pull validation)
  if (isVerifiedGitHubProfile(c)) {
    return {
      identityVerificationStatus: 'verified',
      identityVerificationSource: 'github-api',
      identityVerificationReason: c.scoutReason || 'Scout/GitHub-API verified type=User',
      verifiedProfileUrl: c.github,
      verifiedAt: now(),
    };
  }

  // 3. Stack Overflow numeric-user URL on any URL field (URL shape is strong
  //    identity binding for SO — numeric id + slug is per-user)
  for (const url of [c.linkedinUrl, c.portfolioUrl, c.resumeUrl, c.sourceUrl, c.github]) {
    if (isStackOverflowUserUrl(url)) {
      return {
        identityVerificationStatus: 'verified',
        identityVerificationSource: 'stackoverflow-url-pattern',
        identityVerificationReason: 'Stack Overflow numeric user-id URL pattern',
        verifiedProfileUrl: url,
        verifiedAt: now(),
      };
    }
  }

  // 4. Trusted-platform URL shapes (GitLab/HF/Kaggle/Credly/THM/HTB/Wellfound)
  //    without out-of-band verification → review pool.
  const allUrls = [c.linkedinUrl, c.portfolioUrl, c.resumeUrl, c.sourceUrl, c.github];
  for (const url of allUrls) {
    if (
      isGitLabUserProfileUrl(url) ||
      isHuggingFaceProfileUrl(url) ||
      isKaggleProfileUrl(url) ||
      isCredlyProfileUrl(url) ||
      isTryHackMeProfileUrl(url) ||
      isHackTheBoxProfileUrl(url) ||
      isWellfoundProfileUrl(url) ||
      (isUsableGitHubProfileUrl(url) && !isVerifiedGitHubProfile(c))
    ) {
      return {
        identityVerificationStatus: 'review',
        identityVerificationSource: 'trusted-platform-url-pattern',
        identityVerificationReason: 'Trusted-platform URL shape but no out-of-band verification',
        verifiedProfileUrl: '',
        verifiedAt: '',
      };
    }
  }
  return empty;
}

function refreshIdentityVerification(c) {
  if (!c) return;
  const v = computeIdentityVerification(c);
  c.identityVerificationStatus = v.identityVerificationStatus;
  c.identityVerificationSource = v.identityVerificationSource;
  c.identityVerificationReason = v.identityVerificationReason;
  c.verifiedProfileUrl = v.verifiedProfileUrl;
  c.verifiedAt = v.verifiedAt;
}

// FINAL shortlist eligibility — the single source of truth used by:
//   • runMatchmaker pool gate
//   • runMatchmaker visible count (via isVisibleMatch)
//   • generateClientReport match filter (via isVisibleMatch)
//   • GET /api/matches default response (via isVisibleMatch)
//   • /api/dashboard/stats.matches_visible (via isVisibleMatch)
//
// A candidate appears in the final shortlist iff ALL of:
//   1. scoutDecision === 'accepted'  (strict; NOT null/undefined/''/'review'/
//      'rejected'/'demo'/'fallback' or anything else)
//   2. at least one trusted candidate-profile evidence source:
//        - LinkedIn personal profile (isLinkedInProfileUrl)
//        - Verified GitHub user profile (isVerifiedGitHubProfile)
//        - One of: GitLab user, Hugging Face, Kaggle, Stack Overflow user,
//          Credly, TryHackMe, Hack The Box, Wellfound /u/  (via
//          isTrustedCandidateProfileUrl on linkedinUrl / portfolioUrl /
//          resumeUrl / sourceUrl)
//
// Generic blog / company / docs / job URLs and synthetic apollo:// URLs are
// NEVER acceptable evidence. Each platform helper is host-anchored and rejects
// reserved/system paths.
function isFinalShortlistEligible(c) {
  if (!c) return false;
  if (c.scoutDecision !== 'accepted') return false;
  if (c.identityVerificationStatus !== 'verified') return false;
  if (!c.verifiedProfileUrl) return false;

  const vUrl = c.verifiedProfileUrl;
  // Anti-stale: verifiedProfileUrl MUST still match one of the candidate's
  // current URL fields. If linkedinUrl was later cleared but verifiedProfileUrl
  // wasn't refreshed, treat the candidate as non-eligible. Compares by
  // normalized host+path (lowercased, www-stripped, trailing-slash-stripped).
  const candidateUrls = [c.linkedinUrl, c.github, c.portfolioUrl, c.resumeUrl, c.sourceUrl].filter(Boolean);
  const vKey = _normalizeProfileUrl(vUrl);
  if (!vKey || !candidateUrls.some(u => _normalizeProfileUrl(u) === vKey)) return false;

  // Sanity: verified URL must itself resolve to a recognized verified source.
  if (isLinkedInProfileUrl(vUrl)) return true;
  if (isStackOverflowUserUrl(vUrl)) return true;
  if (isUsableGitHubProfileUrl(vUrl)) return isVerifiedGitHubProfile(c);
  // No other platform is auto-verifiable yet (GitLab/HF/Kaggle/Credly/THM/HTB/
  // Wellfound stay in review pool until an out-of-band verification signal
  // marks them verified — currently none implemented).
  return false;
}

// Single source of truth for "is this match currently visible?".
// Applied to: runMatchmaker visible count, /api/matches default, dashboard
// matches_visible stat, and client report match filter.
// A match is visible iff it is NOT 'Drop' AND its CURRENT candidate state
// still satisfies the shortlist contract (scoutDecision === 'accepted' AND
// hasUsableProfileLink). Stale match records whose candidate has since been
// flipped to review/rejected (or had its profile link removed) become
// invisible at filter time — they stay in DB.matches for audit but disappear
// from visible/raw outputs.
function isVisibleMatch(m) {
  if (!m) return false;
  if (m.tier === 'Drop') return false;
  const c = DB.candidates.find(x => x.id === m.candidateId);
  return isFinalShortlistEligible(c);
}

// Person-like signals heuristic — used when a root GitHub URL is encountered
// without API verification. Looks for an individual person rather than a brand,
// project, or team page. Three independent positive signals:
//   1. Parenthesized display name in the page title (e.g. "login (Jane Doe) · GitHub")
//   2. Personal role/skill vocabulary in title/description
//      (engineer, developer, researcher, etc.)
//   3. "FirstName LastName" at the start of the title (no parens)
function isPersonLikeSignal(title = '', description = '') {
  const t = String(title || '');
  const d = String(description || '');
  // 1. Parenthesized display name in title — accept single first names too
  //    (real GitHub display names are often just a first name). Require ≥3
  //    lowercase chars after the capital so 3-letter abbreviations like
  //    "AWS"/"API"/"Web" don't false-match.
  if (/\(([A-Z][a-z]{2,}(?:[\s'\-][A-Z][a-z]+){0,3})\)/.test(t)) return true;
  // 2. Personal role vocabulary (broader — covers security/cloud roles, MLE/SRE,
  //    pentest/red team, IC + senior levels).
  const text = `${t} ${d}`.toLowerCase();
  if (/\b(engineer|developer|architect|consultant|researcher|analyst|scientist|specialist|admin(istrator)?|practitioner|pentester|red[- ]?team|blue[- ]?team|sre|devops|hacker|hunter|software|programmer|coder|technologist|cybersecurity|infosec|cloud security|application security|product security|security engineer|ml engineer|data engineer|systems? engineer|principal engineer|staff engineer|lead engineer|tech lead)\b/.test(text)) return true;
  // 3. "Firstname Lastname" at start of title (no parens), allowing hyphen/apostrophe
  if (/^[A-Z][a-z]+(?:['\-][A-Z][a-z]+)?\s+[A-Z][a-z]+/.test(t)) return true;
  return false;
}

function scoreSourcedPage({ title = '', url = '', description = '' } = {}) {
  const u = String(url || '');
  const titleText = String(title || '');
  const text = `${titleText} ${description || ''}`;
  const lower = text.toLowerCase();
  let score = 0;
  const reasons = [];

  // URL signals (max 30). Prefer LinkedIn /in/ as the strongest identity
  // signal; GitHub/reddit are useful but still require downstream verification
  // before final shortlist eligibility.
  if (isLinkedInProfileUrl(u)) {
    score += 30;
    reasons.push('URL: LinkedIn /in/ profile');
  } else if (isUsableGitHubProfileUrl(u)) {
    score += 20;
    reasons.push('URL: GitHub profile root');
  } else if (/^https?:\/\/(?:www\.)?reddit\.com\/user\/[A-Za-z0-9_-]+\/?/i.test(u)) {
    score += 15;
    reasons.push('URL: Reddit user profile');
  }

  // Content signals (max 50).
  if (/#open[-_]?to[-_]?work|#opentowork|\bopen to work\b/i.test(text)) {
    score += 20;
    reasons.push('Content: open-to-work signal');
  }
  if (/\b(looking for work|looking for a job|seeking employment|seeking work|open to opportunities|available for work)\b/i.test(text)) {
    score += 20;
    reasons.push('Content: candidate availability phrase');
  }
  if (/\b(resume|curriculum vitae|work history|experience|skills|certifications|projects|employment history)\b/i.test(text)) {
    score += 10;
    reasons.push('Content: resume/profile structure');
  }

  // Metadata/title signals (max 20). We do not currently fetch raw HTML, so
  // schema.org Person is a future enhancement; title metadata is available now.
  if (/\b(resume|portfolio|about me|cv)\b/i.test(titleText)) {
    score += 10;
    reasons.push('Title: profile-like metadata');
  }
  if (/\b(schema\.org\/Person|\"@type\"\s*:\s*\"Person\")\b/i.test(text)) {
    score += 10;
    reasons.push('Metadata: schema.org Person');
  }

  const decision = score >= 60 ? 'accepted' : score >= 40 ? 'review' : 'rejected';
  return { score: Math.min(score, 100), decision, reasons };
}

function classifySourceItem({ title = '', url = '', description = '', source = '' } = {}) {
  const u = String(url || '');
  const t = String(title || '');
  const d = String(description || '');
  let host = '', urlLower = u.toLowerCase();
  try { host = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { host = ''; }
  const sourceDomain = host;

  // 1. Domain/path-based rejection (specific paths first) — must run before
  //    GitHub user-profile acceptance so e.g. linkedin.com/jobs hits its reject
  //    rule before /in/ acceptance ever fires.
  for (const rule of SCOUT_REJECT_RULES) {
    if (rule.re.test(host) || rule.re.test(urlLower)) {
      return { sourceType: rule.type, scoutDecision: 'rejected', scoutReason: rule.why, sourceDomain };
    }
  }

  // 2. Strong-accept: LinkedIn /in/ profile (wins over title/description heuristics
  //    so a real candidate whose bio mentions "best practices" or "guide" is not
  //    incorrectly rejected as documentation/tutorial).
  //    Uses strict URL parsing — does NOT accept spoofed URLs like
  //    `https://attacker.com/linkedin.com/in/foo`.
  if (isLinkedInProfileUrl(u)) {
    return { sourceType: 'candidate_profile', scoutDecision: 'accepted', scoutReason: 'LinkedIn /in/ profile URL', sourceDomain: 'linkedin.com' };
  }

  // 2.5. Strong-route: Wellfound /u/<username> candidate profile → review pool
  //      (URL pattern only; not identity-verified). Placed before title-only
  //      rejects so a noisy "NOW HIRING" title on a real Wellfound /u/ page
  //      does not false-positive as a job listing.
  if (isWellfoundProfileUrl(u)) {
    return {
      sourceType: 'possible_candidate',
      scoutDecision: 'review',
      scoutReason: 'Wellfound /u/ candidate profile (unverified — review pool)',
      sourceDomain,
    };
  }

  // 3. GitHub user profile — root /<login> with no further path. Reject if the
  //    login is a reserved GitHub path or a known org/brand account. For
  //    everything else, classify() is sync and cannot call the GitHub API, so
  //    it returns "review" when person-like signals exist; runScout layer may
  //    upgrade to accepted/rejected via GitHub API type verification.
  //    Without person-like signals, default to rejected (do NOT blindly accept).
  const ghProfile = urlLower.match(/^https?:\/\/(?:www\.)?github\.com\/([a-z0-9](?:[a-z0-9-]{0,38}))\/?(?:[?#]|$)/i);
  if (ghProfile) {
    const login = ghProfile[1].toLowerCase();
    if (GH_RESERVED_LOGINS.has(login)) {
      return { sourceType: 'unknown', scoutDecision: 'rejected', scoutReason: `GitHub reserved path /${login}`, sourceDomain: 'github.com' };
    }
    if (GH_KNOWN_ORGS.has(login)) {
      return { sourceType: 'company_page', scoutDecision: 'rejected', scoutReason: `GitHub organization /${login}`, sourceDomain: 'github.com' };
    }
    if (isPersonLikeSignal(title, description)) {
      return { sourceType: 'possible_candidate', scoutDecision: 'review', scoutReason: 'GitHub root URL — unverified, person-like signals present', sourceDomain: 'github.com' };
    }
    return { sourceType: 'company_page', scoutDecision: 'rejected', scoutReason: 'GitHub root URL with no person-like signals', sourceDomain: 'github.com' };
  }
  // GitHub direct API user record (caller passes a synthetic URL for github API hits)
  if (source === 'GitHub') {
    return { sourceType: 'candidate_profile', scoutDecision: 'accepted', scoutReason: 'GitHub user search result', sourceDomain: 'github.com' };
  }

  // 4. Personal-page keywords in path
  if (/\/(resume|cv|portfolio|about[-_]?me|aboutme|personal[-_]?(site|page))(\/|$|\?)/i.test(u)) {
    return { sourceType: 'candidate_profile', scoutDecision: 'accepted', scoutReason: 'personal-page keyword in URL path', sourceDomain };
  }

  // 5. Title-only rejects (after URL acceptance signals; description noise
  //    alone should not reject a real candidate page).
  for (const rule of SCOUT_TITLE_REJECTS) {
    if (rule.re.test(t)) {
      return { sourceType: rule.type, scoutDecision: 'rejected', scoutReason: rule.why, sourceDomain };
    }
  }

  // 6. Author-style profile pages → possible_candidate (manual review)
  if (/medium\.com\/@[a-z0-9\-_.]+\/?$/i.test(urlLower) || /(^|\.)dev\.to\/[a-z0-9\-_]+\/?$/i.test(urlLower)) {
    return { sourceType: 'possible_candidate', scoutDecision: 'review', scoutReason: 'author-style profile (Medium/Dev.to)', sourceDomain };
  }

  // 7. Personal-style apex domain (single-segment, indie TLD)
  if (host && /^[a-z][a-z0-9-]{1,40}\.(me|dev|io|tech|xyz|page|site|blog|codes|engineer|engineering)$/i.test(host)) {
    return { sourceType: 'possible_candidate', scoutDecision: 'review', scoutReason: 'personal-style TLD/domain', sourceDomain: host };
  }

  // 8. Default: unknown, reject (do not silently flow garbage into validator)
  return { sourceType: 'unknown', scoutDecision: 'rejected', scoutReason: 'no candidate-like signal', sourceDomain };
}

async function runScout({ needId, pipelineRunId = null, expandCandidatePool = false } = {}) {
  const need = DB.hiring_needs.find(n => n.id === needId);
  if (!need) { await logActivity('Scout', 'Need not found', 'error'); return { sourced: 0, candidates: [], sourcedRaw: 0, acceptedCandidates: 0, needsScoutReview: 0, rejectedNonCandidates: 0, rejectedSamples: [] }; }
  if (!need.confirmed) { await logActivity('Scout', 'Need is not confirmed; confirm before sourcing', 'warn'); return { sourced: 0, candidates: [], sourcedRaw: 0, acceptedCandidates: 0, needsScoutReview: 0, rejectedNonCandidates: 0, rejectedSamples: [], reason: 'unconfirmed' }; }
  await logActivity('Scout', `Sourcing for "${need.title}"…`, 'running');

  const skillQuery = (need.requiredSkills || []).slice(0, 4).join(' ');
  const cutoff = new Date(Date.now() - 10 * 86400 * 1000);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  const expansion = buildCandidateSearchExpansion(need, { enabled: !!expandCandidatePool });
  const accepted = [];
  const review = [];
  const rejected = [];
  let sourcedRaw = 0;

  // Per-source counters. First-touch attribution: each unique candidate is
  // credited to the first source that introduced it (so a duplicate found by a
  // later source does not double-count).
  const rawResultsBySource      = { apollo: 0, firecrawl: 0, github: 0, adzuna: 0, pdl: 0 };
  const acceptedBySource        = { apollo: 0, firecrawl: 0, github: 0, adzuna: 0, pdl: 0 };
  const reviewBySource          = { apollo: 0, firecrawl: 0, github: 0, adzuna: 0, pdl: 0 };
  const rejectedBySource        = { apollo: 0, firecrawl: 0, github: 0, adzuna: 0, pdl: 0 };
  const rejectedReasonsBySource = { apollo: {}, firecrawl: {}, github: {}, adzuna: {}, pdl: {} };
  const rejectedByReason       = {};
  const sourceQueryStats       = { apollo: [], firecrawl: [], github: [] };
  const candById = new Map(); // candidate.id -> first source tag (for dedupe attribution)
  const recordAccept = (c, sourceTag) => {
    if (candById.has(c.id)) return false;
    candById.set(c.id, sourceTag);
    accepted.push(c);
    acceptedBySource[sourceTag] = (acceptedBySource[sourceTag] || 0) + 1;
    return true;
  };
  const recordReview = (c, sourceTag) => {
    if (candById.has(c.id)) return false;
    candById.set(c.id, sourceTag);
    review.push(c);
    reviewBySource[sourceTag] = (reviewBySource[sourceTag] || 0) + 1;
    return true;
  };
  const recordReject = (entry, sourceTag = 'unknown') => {
    const stamped = { ...entry, source: sourceTag };
    rejected.push(stamped);
    const key = entry.scoutReason || entry.sourceType || 'unknown';
    rejectedByReason[key] = (rejectedByReason[key] || 0) + 1;
    if (rejectedBySource[sourceTag] !== undefined) rejectedBySource[sourceTag]++;
    if (!rejectedReasonsBySource[sourceTag]) rejectedReasonsBySource[sourceTag] = {};
    rejectedReasonsBySource[sourceTag][key] = (rejectedReasonsBySource[sourceTag][key] || 0) + 1;
  };

  // ── 1. Apollo candidate search (highest-precision source) ──
  // Apollo people-search returns real LinkedIn URLs + employer + location.
  // Force-accept as candidate_profile — does NOT pass through the heuristic
  // classifier (which is built for noisy Firecrawl results).
  if (isConfigured('apollo')) {
    for (const attempt of buildApolloCandidateAttempts(need, { expandCandidatePool })) {
      const ap = await apolloCandidateSearch({
        titles: attempt.titles,
        locations: attempt.locations,
        keywords: attempt.keywords,
        perPage: 25,
        page: 1,
      });
      const apolloReturned = (ap.people || []).length;
      sourceQueryStats.apollo.push({
        step: attempt.label,
        titles: attempt.titles,
        keywords: attempt.keywords,
        locations: attempt.locations,
        ok: ap.ok,
        count: apolloReturned,
        reason: ap.reason || '',
      });

      // Live-diagnostic: log every relaxation step so we can tune query shape.
      if (ap.ok) {
        await logActivity(
          'Scout',
          `Apollo people search: ${apolloReturned} returned (${attempt.label}; titles=${attempt.titles.length}, kw="${attempt.keywords}", loc=${attempt.locations.join('|') || '(none)'})`,
          apolloReturned > 0 ? 'success' : 'warn',
          { source: 'apollo', step: attempt.label, returned: apolloReturned, titles: attempt.titles, locations: attempt.locations, keywords: attempt.keywords },
        );
      } else {
        const bodySnippet = ap.body ? ` body=${ap.body}` : '';
        await logActivity(
          'Scout',
          `Apollo skipped: ${ap.reason} endpoint=${ap.endpoint || '?'}${bodySnippet}`,
          'warn',
          { source: 'apollo', step: attempt.label, reason: ap.reason, status: ap.status || null, endpoint: ap.endpoint || null, body: ap.body || '' },
        );
        break;
      }

      if (!apolloReturned) continue;
      await logActivity(
        'Scout',
        `Apollo relaxation accepted step "${attempt.label}" with ${apolloReturned} people`,
        'success',
        { source: 'apollo', step: attempt.label, returned: apolloReturned },
      );
      for (const p of (ap.people || [])) {
        sourcedRaw++;
        rawResultsBySource.apollo++;
        const name = (p.name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || '').trim();
        if (!name || name.length < 2) {
          recordReject({
            sourceType: 'unknown',
            scoutDecision: 'rejected',
            scoutReason: 'Apollo result missing person name',
            sourceDomain: 'apollo.io',
            sourceUrl: p.linkedin_url || '',
            title: '',
          }, 'apollo');
          continue;
        }
        const linkedinUrl = p.linkedin_url || '';
        // Strict host-anchored check. Rejects spoofed URLs like
        // `https://attacker.com/linkedin.com/in/jane` and LinkedIn /company/ pages.
        const hasRealLinkedIn = isLinkedInProfileUrl(linkedinUrl);
        const orgName = (p.organization && p.organization.name) || '';
        const loc = [p.city, p.state, p.country].filter(Boolean).join(', ');
        const summary = p.headline || p.title || '';
        // Apollo results without a real LinkedIn /in/ URL go to the review
        // pool, NOT visible/accepted. Do not synthesize an `apollo://` URL —
        // visible candidates must carry a real profile link.
        const sourceType    = hasRealLinkedIn ? 'candidate_profile' : 'possible_candidate';
        const scoutDecision = hasRealLinkedIn ? 'accepted'          : 'review';
        const scoutReason   = hasRealLinkedIn
          ? 'Apollo people search candidate result'
          : 'Apollo result missing real LinkedIn/profile URL — manual review';
        const sourceDomain  = hasRealLinkedIn ? 'linkedin.com' : 'apollo.io';
        // Apollo phone extraction — defensive across Apollo's varying response
        // shapes. Prefer the sanitized number on phone_numbers[0]; fall back
        // to raw_number, then top-level mobile_phone / corporate_phone.
        let phone = '';
        if (Array.isArray(p.phone_numbers) && p.phone_numbers.length) {
          const first = p.phone_numbers[0] || {};
          phone = first.sanitized_number || first.raw_number || '';
        }
        if (!phone) phone = p.mobile_phone || p.corporate_phone || p.work_phone || '';
        phone = String(phone || '').trim();
        const profileText = [name, p.title || '', orgName, loc, summary].join(' ');
        const meta = sourceMetadata({
          provider: 'apollo',
          sourceLabel: `apollo:${attempt.label}`,
          query: attempt.keywords || '(title-only)',
          variantMetas: attempt.searchVariantMeta || [],
          locationTier: attempt.locationTier || inferLocationTier(loc, expansion.locationTiers),
          profileText,
          expansionEnabled: !!attempt.expandCandidatePool,
        });

        const c = findOrCreateCandidate({
          name,
          title: p.title || '',
          company: orgName,
          location: loc,
          summary,
          skills: extractSkills(`${p.title || ''} ${summary}`),
          email: (p.email && p.email.includes('@')) ? p.email : '',
          phone,
          linkedinUrl: hasRealLinkedIn ? linkedinUrl : '',
          sourceUrl: hasRealLinkedIn ? linkedinUrl : '',
          source: 'Apollo',
          sourceType,
          scoutDecision,
          scoutReason,
          sourceDomain,
          scoutSourceLabel: `apollo:${attempt.label}`,
          scoutQuery: attempt.keywords || '(title-only)',
          pipelineRunId,
          ...meta,
        });
        applyReviewMetadata(c, need, meta);
        if (hasRealLinkedIn) recordAccept(c, 'apollo');
        else                 recordReview(c, 'apollo');
      }
      if (!expandCandidatePool) break;
    }
  } else {
    await logActivity('Scout', 'Apollo unavailable (key missing) — skipping Apollo candidate search', 'info', { source: 'apollo', reason: 'APOLLO_API_KEY missing' });
  }

  let llmParseUsed = 0;
  if (isConfigured('firecrawl')) {
    const seenFirecrawlUrls = new Set();
    // Combine profile-pattern queries (LinkedIn /in/-focused) with board-
    // targeted queries (Dice / Built In / Wellfound /u/ / security speakers).
    // Order: profile queries first (highest signal) then boards. URL dedupe
    // via seenFirecrawlUrls below prevents double-counting.
    const profileQueries = [
      ...buildFirecrawlProfileQueries(need, { expandCandidatePool }),
      ...buildFirecrawlBoardQueries(need),
    ];
    for (const q of profileQueries) {
      const fc = await firecrawlSearch(q.query, q.limit || 10);
      const items = fc.items || [];
      sourceQueryStats.firecrawl.push({ source: q.source, query: q.query, ok: fc.ok, count: items.length, reason: fc.reason || '' });
      await logActivity(
        'Scout',
        `Firecrawl ${q.source}: ${items.length} returned`,
        fc.ok ? 'info' : 'warn',
        { source: 'firecrawl', sourceLabel: q.source, query: q.query, count: items.length, reason: fc.reason || '' },
      );
      for (const item of items) {
        const itemUrl = item.url || '';
        const itemKey = itemUrl || `${item.title || ''}|${item.description || ''}`;
        if (seenFirecrawlUrls.has(itemKey)) continue;
        seenFirecrawlUrls.add(itemKey);
        sourcedRaw++;
        rawResultsBySource.firecrawl++;
        const pageScore = scoreSourcedPage(item);
      const cls = classifySourceItem({
        title: item.title, url: item.url, description: item.description, source: 'Firecrawl',
      });
      if (cls.scoutDecision === 'rejected' && pageScore.score >= 60) {
        cls.sourceType = 'possible_candidate';
        cls.scoutDecision = 'accepted';
        cls.scoutReason = `scored candidate-like page (${pageScore.score}): ${pageScore.reasons.join('; ')}`;
      } else if (cls.scoutDecision === 'rejected' && pageScore.score >= 40) {
        cls.sourceType = 'possible_candidate';
        cls.scoutDecision = 'review';
        cls.scoutReason = `scored possible candidate (${pageScore.score}): ${pageScore.reasons.join('; ')}`;
      } else if (pageScore.reasons.length) {
        cls.scoutReason = `${cls.scoutReason} · score=${pageScore.score} (${pageScore.reasons.join('; ')})`;
      }

      // Async GitHub API verification: when classify() returned "review" for a
      // github.com/<login> URL because it could not be sure (unverified, person
      // signals only), call the GitHub API to upgrade — type==='User' accepts,
      // type==='Organization' rejects. If the API is unavailable / rate-limited
      // / returns nothing, the item stays as review (no blind accept).
      if (cls.scoutDecision === 'review' && cls.sourceDomain === 'github.com') {
        const ghMatch = (item.url || '').match(/github\.com\/([a-z0-9\-_]+)/i);
        const login = ghMatch ? ghMatch[1] : '';
        if (login) {
          const ghDetail = await githubUser(login);
          if (ghDetail && ghDetail.type === 'User') {
            cls.sourceType = 'candidate_profile';
            cls.scoutDecision = 'accepted';
            cls.scoutReason = 'GitHub API verified type=User';
          } else if (ghDetail && ghDetail.type === 'Organization') {
            recordReject({
              sourceType: 'company_page',
              scoutDecision: 'rejected',
              scoutReason: 'GitHub API verified type=Organization',
              sourceDomain: 'github.com',
              sourceUrl: item.url || '',
              title: item.title || '',
              scoutScore: pageScore.score,
              scoutScoreReasons: pageScore.reasons,
            }, 'firecrawl');
            continue;
          }
          // null / unknown → stays review
        }
      }

      if (cls.scoutDecision === 'rejected') {
        recordReject({
          sourceType: cls.sourceType,
          scoutDecision: 'rejected',
          scoutReason: cls.scoutReason,
          sourceDomain: cls.sourceDomain,
          sourceUrl: item.url || '',
          title: item.title || '',
          scoutScore: pageScore.score,
          scoutScoreReasons: pageScore.reasons,
          scoutSourceLabel: q.source,
          scoutQuery: q.query,
        }, 'firecrawl');
        continue;
      }
      // accepted / review → parse fields and stamp classifier output on the candidate
      const desc = `${item.description || ''} ${item.title || ''}`;
      const parts = (item.title || '').split(/[-–|]/);
      const name = (parts[0] || '').trim().replace(/['"]/g, '');
      let parsedName = name;
      let parsedTitle = '', parsedCompany = '', parsedLocation = '', parsedSkillsExtra = [];
      let llmParsedFlag = false;
      if (!name || name.length < 2) {
        // Regex parse failed. Try OpenAI candidate parser as fallback —
        // capped to OPENAI_PARSE_MAX_PER_RUN per pipeline to control cost.
        if (llmParseUsed < OPENAI_PARSE_MAX_PER_RUN && isConfigured('openai')) {
          llmParseUsed++;
          const llm = await openaiParseCandidateItem(item);
          if (llm && llm.name && llm.confidence >= 0.6) {
            parsedName = llm.name;
            parsedTitle = llm.title;
            parsedCompany = llm.company;
            parsedLocation = llm.location;
            parsedSkillsExtra = llm.skills || [];
            llmParsedFlag = true;
          }
        }
        if (!parsedName || parsedName.length < 2) {
          recordReject({
            sourceType: cls.sourceType,
            scoutDecision: 'rejected',
            scoutReason: 'no parseable person-name from title (LLM also failed/skipped)',
            sourceDomain: cls.sourceDomain,
            sourceUrl: item.url || '',
            title: item.title || '',
            scoutScore: pageScore.score,
            scoutScoreReasons: pageScore.reasons,
            scoutSourceLabel: q.source,
            scoutQuery: q.query,
          }, 'firecrawl');
          continue;
        }
      }
      const titlePart = (parts[1] || '').trim();
      const atMatch = titlePart.match(/^(.+?)\s+at\s+(.+)$/i);
      const regexTitle = atMatch ? atMatch[1].trim() : titlePart;
      const regexCompany = atMatch ? atMatch[2].trim() : '';
      // Prefer LLM-parsed fields when present, fall back to regex.
      const cTitle = parsedTitle || regexTitle;
      const cCompany = parsedCompany || regexCompany;
      const cLocation = parsedLocation || '';
      const emailMatch = desc.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
      const isLi = cls.sourceDomain === 'linkedin.com';
      const profileText = [
        parsedName,
        cTitle,
        cCompany,
        cLocation,
        item.description || '',
        ...(parsedSkillsExtra || []),
      ].join(' ');
      const meta = sourceMetadata({
        provider: 'firecrawl',
        sourceLabel: q.source,
        query: q.query,
        variantMetas: q.searchVariantMeta || [],
        locationTier: q.locationTier || inferLocationTier(cLocation || item.description || '', expansion.locationTiers),
        profileText,
        expansionEnabled: !!q.expandCandidatePool,
      });
      const c = findOrCreateCandidate({
        name: parsedName, title: cTitle, company: cCompany, location: cLocation,
        summary: (item.description || '').slice(0, 200),
        skills: Array.from(new Set([...extractSkills(desc), ...parsedSkillsExtra])),
        email: emailMatch ? emailMatch[0] : '',
        linkedinUrl: isLi ? (item.url || '') : '',
        portfolioUrl: !isLi ? (item.url || '') : '',
        sourceUrl: item.url || '',
        source: isLi ? 'LinkedIn' : 'Web',
        sourceType: cls.sourceType,
        scoutDecision: cls.scoutDecision,
        scoutReason: llmParsedFlag ? `${cls.scoutReason} · LLM-parsed` : cls.scoutReason,
        sourceDomain: cls.sourceDomain,
        scoutScore: pageScore.score,
        scoutScoreReasons: pageScore.reasons,
        scoutSourceLabel: q.source,
        scoutQuery: q.query,
        pipelineRunId,
        ...meta,
      });
      applyReviewMetadata(c, need, meta);
      if (llmParsedFlag) {
        c.enrichedBy = Array.from(new Set([...(c.enrichedBy || []), 'openai-parse']));
      }
      if (cls.scoutDecision === 'accepted') recordAccept(c, 'firecrawl');
      else recordReview(c, 'firecrawl');
      }
      // Try prioritized Firecrawl queries in order until candidate-like records
      // are found. Rejected pages are still counted/deduped for diagnostics.
      if (!expandCandidatePool && acceptedBySource.firecrawl + reviewBySource.firecrawl > 0) break;
    }
  }

  // GitHub user search → every item is a candidate_profile by API contract
  const ghQueries = expandCandidatePool
    ? expansion.titleVariants.slice(0, 8).map(v => ({
        query: `${v.title} ${expansion.profileKeywords.slice(0, 3).join(' ')} type:user pushed:>${cutoffISO}`.trim(),
        searchVariantMeta: [v],
        source: `github:expanded:${v.variant_type}`,
        expandCandidatePool: true,
      }))
    : uniqStrings([
        `${skillQuery || need.title} type:user pushed:>${cutoffISO}`,
        `${need.title} ${skillQuery} type:user`,
        `cybersecurity security engineer azure sentinel type:user`,
      ], 3).map(query => ({ query, searchVariantMeta: [], source: 'github:user-search', expandCandidatePool: false }));
  let ghItems = [];
  let ghPlan = null;
  for (const plan of ghQueries) {
    const gh = await githubSearchUsers({ query: plan.query, perPage: 8 });
    ghItems = (gh.items || []).slice(0, 8);
    sourceQueryStats.github.push({ query: plan.query, ok: gh.ok, count: ghItems.length, reason: gh.reason || '', source: plan.source });
    await logActivity('Scout', `GitHub user search: ${ghItems.length} returned`, gh.ok ? 'info' : 'warn', { source: 'github', query: plan.query, count: ghItems.length, reason: gh.reason || '' });
    if (ghItems.length || !gh.ok) {
      ghPlan = plan;
      if (!expandCandidatePool) break;
    }
    if (ghItems.length && expandCandidatePool) break;
  }
  for (const u of ghItems) {
    sourcedRaw++;
    rawResultsBySource.github++;
    const detail = await githubUser(u.login) || u;
    if (detail.updated_at && new Date(detail.updated_at) < cutoff) {
      recordReject({
        sourceType: 'candidate_profile',
        scoutDecision: 'rejected',
        scoutReason: 'GitHub account stale (no push in cutoff window)',
        sourceDomain: 'github.com',
        sourceUrl: detail.html_url || `https://github.com/${u.login}`,
        title: `${u.login} (stale)`,
      }, 'github');
      continue;
    }
    const name = detail.name || u.login.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const blog = (detail.blog || '').trim();
    const ghUrl = detail.html_url || `https://github.com/${u.login}`;
    const profileText = [name, detail.bio || '', detail.company || '', detail.location || ''].join(' ');
    const meta = sourceMetadata({
      provider: 'github',
      sourceLabel: ghPlan?.source || 'github:user-search',
      query: ghPlan?.query || '',
      variantMetas: ghPlan?.searchVariantMeta || [],
      locationTier: inferLocationTier(detail.location || '', expansion.locationTiers),
      profileText,
      expansionEnabled: !!ghPlan?.expandCandidatePool,
    });
    const c = findOrCreateCandidate({
      name,
      title: detail.bio ? detail.bio.split(/[.|,;\n]/)[0].trim().slice(0, 80) : '',
      company: (detail.company || '').replace(/^@/, ''),
      location: detail.location || '',
      summary: detail.bio || '',
      skills: extractSkills(detail.bio || ''),
      email: detail.email || '',
      github: ghUrl,
      portfolioUrl: blog && !blog.includes('linkedin.com') ? blog : '',
      avatarUrl: detail.avatar_url,
      source: 'GitHub',
      sourceType: 'candidate_profile',
      scoutDecision: 'accepted',
      scoutReason: 'GitHub user search result',
      sourceDomain: 'github.com',
      sourceUrl: ghUrl,
      pipelineRunId,
      ...meta,
    });
    applyReviewMetadata(c, need, meta);
    recordAccept(c, 'github');
  }

  // GitHub contributor mining — harvests top contributors of canonical
  // security/cloud repos (Azure-Sentinel, SigmaHQ/sigma, Microsoft-Sentinel2Go,
  // MicrosoftDocs/azure-docs, mitre-attack/attack-flow for security roles;
  // terraform-provider-azurerm, bicep, cluster-api-provider-azure for devops).
  // Each contributor is verified via githubUser → type==='User', not in
  // KNOWN_ORGS/RESERVED_LOGINS, not stale.
  const minedRepos = pickReposForRole(need.title);
  for (const r of minedRepos) {
    const contrib = await githubContributors({ owner: r.owner, repo: r.repo, perPage: 15 });
    if (!contrib.ok) {
      sourceQueryStats.github.push({ query: `contrib:${r.owner}/${r.repo}`, ok: false, count: 0, reason: `HTTP ${contrib.status || 'fail'}` });
      continue;
    }
    sourceQueryStats.github.push({ query: `contrib:${r.owner}/${r.repo}`, ok: true, count: (contrib.items || []).length, reason: '' });
    for (const u of (contrib.items || []).slice(0, 10)) {
      const login = String(u.login || '').toLowerCase();
      if (!u.login || u.type === 'Bot' || u.type === 'Anonymous') continue; // skip silently — bots aren't candidates
      if (GH_KNOWN_ORGS.has(login) || GH_RESERVED_LOGINS.has(login)) continue;
      sourcedRaw++;
      rawResultsBySource.github++;
      const detail = await githubUser(u.login);
      if (!detail || detail.type !== 'User') {
        recordReject({
          sourceType: 'unknown',
          scoutDecision: 'rejected',
          scoutReason: `GitHub contributor not type=User (login=${u.login})`,
          sourceDomain: 'github.com',
          sourceUrl: u.html_url || `https://github.com/${u.login}`,
          title: u.login || '',
        }, 'github');
        continue;
      }
      if (detail.updated_at && new Date(detail.updated_at) < cutoff) {
        recordReject({
          sourceType: 'candidate_profile',
          scoutDecision: 'rejected',
          scoutReason: 'GitHub contributor stale (no push in cutoff window)',
          sourceDomain: 'github.com',
          sourceUrl: detail.html_url || `https://github.com/${u.login}`,
          title: `${u.login} (stale)`,
        }, 'github');
        continue;
      }
      const name = detail.name || u.login.replace(/-/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
      const blog = (detail.blog || '').trim();
      const ghUrl = detail.html_url || `https://github.com/${u.login}`;
      const profileText = [name, detail.bio || '', detail.company || '', detail.location || ''].join(' ');
      const meta = sourceMetadata({
        provider: 'github',
        sourceLabel: `github:contrib:${r.owner}/${r.repo}`,
        query: `${r.owner}/${r.repo}`,
        variantMetas: [],
        locationTier: inferLocationTier(detail.location || '', expansion.locationTiers),
        profileText,
        expansionEnabled: false,
      });
      const c = findOrCreateCandidate({
        name,
        title: detail.bio ? detail.bio.split(/[.|,;\n]/)[0].trim().slice(0, 80) : '',
        company: (detail.company || '').replace(/^@/, ''),
        location: detail.location || '',
        summary: detail.bio || '',
        skills: extractSkills(detail.bio || ''),
        email: detail.email || '',
        github: ghUrl,
        portfolioUrl: blog && !blog.includes('linkedin.com') ? blog : '',
        avatarUrl: detail.avatar_url,
        source: 'GitHub',
        sourceType: 'candidate_profile',
        scoutDecision: 'accepted',
        scoutReason: `GitHub contributor of ${r.owner}/${r.repo}`,
        sourceDomain: 'github.com',
        sourceUrl: ghUrl,
        scoutSourceLabel: `github:contrib:${r.owner}/${r.repo}`,
        scoutQuery: `${r.owner}/${r.repo}`,
        pipelineRunId,
        ...meta,
      });
      applyReviewMetadata(c, need, meta);
      recordAccept(c, 'github');
    }
  }

  // Adzuna candidate-mention mining — weak signal: job-description text
  // sometimes contains "by NAME", "submitted by NAME", "author: NAME".
  // Extracted names always go to review pool (URL points at job board page,
  // not a candidate profile — verified-only gate stays unchanged).
  if (isConfigured('adzuna')) {
    const adzKeywords = (need.requiredSkills || []).slice(0, 3).join(' ');
    const az = await adzunaSearch({ what: `${need.title} ${adzKeywords}`.trim(), where: '' });
    if (az.ok) {
      // Name parts: standard ("John") or Irish/Scottish ("O'Brien").
      // Connector between parts: space or hyphen ("Anne-Marie Lopez").
      // Requires 2-4 total parts (so single-word matches like "by Apply" don't
      // false-fire — acronyms like "HTML" are also blocked: no lowercase tail).
      const nameRe = /\b(?:by|author(?:\s*:|\s+is)?|submitted\s+by|written\s+by|posted\s+by|contact)\s+((?:[A-Z][a-z]+|[A-Z]'[A-Z][a-z]+)(?:[-\s](?:[A-Z][a-z]+|[A-Z]'[A-Z][a-z]+)){1,3})\b/g;
      const seenAdzNames = new Set();
      for (const r of (az.results || []).slice(0, 20)) {
        const text = `${r.title || ''} ${r.description || ''}`;
        let m;
        nameRe.lastIndex = 0;
        while ((m = nameRe.exec(text)) !== null) {
          const personName = m[1].trim();
          const key = personName.toLowerCase();
          if (seenAdzNames.has(key)) continue;
          seenAdzNames.add(key);
          sourcedRaw++;
          rawResultsBySource.adzuna++;
          const meta = sourceMetadata({
            provider: 'adzuna',
            sourceLabel: 'adzuna:mention',
            query: `${need.title} ${adzKeywords}`.trim(),
            variantMetas: [],
            locationTier: inferLocationTier(r.location && r.location.display_name || '', expansion.locationTiers),
            profileText: text,
            expansionEnabled: false,
          });
          const c = findOrCreateCandidate({
            name: personName,
            title: (r.title || '').slice(0, 80),
            company: r.company && r.company.display_name || '',
            location: r.location && r.location.display_name || '',
            summary: (r.description || '').slice(0, 200),
            skills: extractSkills(text),
            sourceUrl: r.redirect_url || '',
            source: 'Adzuna',
            sourceType: 'possible_candidate',
            scoutDecision: 'review',
            scoutReason: 'Adzuna candidate-mention mining (weak signal; URL is a job posting)',
            sourceDomain: 'adzuna.com',
            scoutSourceLabel: 'adzuna:mention',
            scoutQuery: `${need.title} ${adzKeywords}`.trim(),
            pipelineRunId,
            ...meta,
          });
          applyReviewMetadata(c, need, meta);
          recordReview(c, 'adzuna');
        }
      }
    }
  }

  // ── PDL (People Data Labs): proactive source + Apollo-rescue + LinkedIn enrich ──
  // Dormant when PDL_API_KEY missing. All calls are failure-safe.
  if (isConfigured('pdl')) {
    // (a) Proactive Person Search — fetch up to 25 real LinkedIn profiles
    const pdlKeywords = (need.requiredSkills || []).slice(0, 5).join(' ');
    const pdlPlans = expandCandidatePool
      ? expansion.titleVariants.slice(0, 8).map(v => ({
          role: v.title,
          keywords: expansion.profileKeywords.slice(0, 5).join(' '),
          sourceLabel: `pdl:expanded:${v.variant_type}`,
          searchVariantMeta: [v],
          expandCandidatePool: true,
        }))
      : [{ role: need.title || '', keywords: pdlKeywords, sourceLabel: 'pdl:person-search', searchVariantMeta: [], expandCandidatePool: false }];
    for (const pdlPlan of pdlPlans) {
    const pdlSearch = await pdlPersonSearch({
      role: pdlPlan.role,
      keywords: pdlPlan.keywords,
      pageSize: 25,
    });
    if (pdlSearch.ok) {
      for (const p of (pdlSearch.items || [])) {
        sourcedRaw++;
        rawResultsBySource.pdl++;
        // PDL stores linkedin_url without scheme (e.g. "linkedin.com/in/jane").
        let profileUrl = p.linkedin_url || '';
        if (profileUrl && !/^https?:\/\//i.test(profileUrl)) profileUrl = `https://www.${profileUrl}`;
        if (!isLinkedInProfileUrl(profileUrl)) {
          recordReject({
            sourceType: 'unknown',
            scoutDecision: 'rejected',
            scoutReason: 'PDL result missing real LinkedIn URL',
            sourceDomain: 'pdl',
            sourceUrl: '',
            title: '',
          }, 'pdl');
          continue;
        }
        const fullName = (p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || '').trim();
        const locationParts = [p.location_locality || p.location_name, p.location_region, p.location_country].filter(Boolean);
        const loc = locationParts.join(', ');
        const profileText = [
          fullName,
          p.job_title || '',
          p.job_company_name || '',
          loc,
          p.summary || '',
          ...(Array.isArray(p.skills) ? p.skills : []),
        ].join(' ');
        const meta = sourceMetadata({
          provider: 'pdl',
          sourceLabel: pdlPlan.sourceLabel,
          query: pdlPlan.keywords || pdlPlan.role,
          variantMetas: pdlPlan.searchVariantMeta,
          locationTier: inferLocationTier(loc, expansion.locationTiers),
          profileText,
          expansionEnabled: !!pdlPlan.expandCandidatePool,
        });
        const c = findOrCreateCandidate({
          name: fullName || 'PDL candidate',
          title: p.job_title || '',
          company: p.job_company_name || '',
          location: loc,
          summary: p.summary || p.job_title || '',
          skills: Array.isArray(p.skills) && p.skills.length
            ? p.skills.map(s => String(s)).filter(Boolean).slice(0, 30)
            : extractSkills(`${p.job_title || ''} ${p.summary || ''}`),
          email: '',
          linkedinUrl: profileUrl,
          sourceUrl: profileUrl,
          source: 'PDL',
          sourceType: 'candidate_profile',
          scoutDecision: 'accepted',
          scoutReason: 'PDL Person Search candidate result',
          sourceDomain: 'linkedin.com',
          scoutSourceLabel: pdlPlan.sourceLabel,
          scoutQuery: pdlPlan.keywords || pdlPlan.role,
          pipelineRunId,
          ...meta,
        });
        applyReviewMetadata(c, need, meta);
        recordAccept(c, 'pdl');
      }
      await logActivity('Scout', `PDL Person Search: ${(pdlSearch.items || []).length} returned`, (pdlSearch.items || []).length ? 'success' : 'warn', { source: 'pdl', returned: (pdlSearch.items || []).length });
    } else {
      await logActivity('Scout', `PDL Person Search skipped: ${pdlSearch.reason}`, 'warn',
        { source: 'pdl', reason: pdlSearch.reason, status: pdlSearch.status || null, endpoint: pdlSearch.endpoint || null, body: pdlSearch.body || '' });
    }
    if (!expandCandidatePool && pdlSearch.ok) break;
    }

    // (b) Profile Resolve — rescue Apollo-no-LinkedIn review-pool candidates
    //     by filling missing LinkedIn URL via /v5/person/enrich with
    //     first_name + last_name + company. On success, refresh identity
    //     verification → candidate flips to 'verified' / 'pdl-resolved' →
    //     enters final shortlist.
    const apolloReviewCandidates = review.filter(c =>
      c.source === 'Apollo' && !isLinkedInProfileUrl(c.linkedinUrl) && c.name
    );
    // Parallel + capped at 15 to avoid Cloudflare 520 on /api/pipeline/run.
    await Promise.all(apolloReviewCandidates.slice(0, 15).map(async (c) => {
      const parts = String(c.name || '').trim().split(/\s+/);
      if (parts.length < 2) return;
      const firstName = parts[0];
      const lastName = parts[parts.length - 1];
      const companyName = (c.currentCompany || '').replace(/^@/, '');
      const resolved = await pdlProfileResolve({ firstName, lastName, companyName });
      if (resolved.ok && resolved.linkedinUrl) {
        c.linkedinUrl = resolved.linkedinUrl;
        c.sourceUrl = c.sourceUrl || resolved.linkedinUrl;
        c.identityVerificationStatus = 'verified';
        c.identityVerificationSource = 'pdl-resolved';
        c.identityVerificationReason = `PDL Profile Resolve found LinkedIn for ${firstName} ${lastName}`;
        c.verifiedProfileUrl = resolved.linkedinUrl;
        c.verifiedAt = now();
        c.scoutDecision = 'accepted';
        c.sourceType = 'candidate_profile';
      }
    }));

    // (c) Profile Lookup — enrich accepted candidates with LinkedIn URLs
    //     using snapshot data (skills, summary, location). Pulls richer
    //     skill set for matchmaker scoring. Cap at 10 to control credits.
    const enrichable = accepted
      .filter(c => isLinkedInProfileUrl(c.linkedinUrl) && (!c.skills || c.skills.length < 3))
      .slice(0, 10);
    await Promise.all(enrichable.map(async (c) => {
      const lookup = await pdlProfileLookup({ linkedinUrl: c.linkedinUrl });
      if (lookup.ok && lookup.profile) {
        const p = lookup.profile;
        if (Array.isArray(p.skills) && p.skills.length) {
          const newSkills = p.skills.map(s => String(s)).filter(Boolean);
          c.skills = Array.from(new Set([...(c.skills || []), ...newSkills])).slice(0, 30);
        }
        if (!c.summary && (p.summary || p.job_title)) c.summary = (p.summary || p.job_title || '').slice(0, 500);
        if (!c.location && (p.location_name || p.location_country)) {
          c.location = [p.location_locality || p.location_name, p.location_region, p.location_country].filter(Boolean).join(', ');
        }
        c.enrichedBy = Array.from(new Set([...(c.enrichedBy || []), 'pdl-lookup']));
        c.enrichedAt = now();
      }
    }));
  }

  // ── Hunter on candidates — fill missing email for accepted records with a
  //    real company. Pre-existing manager-side Hunter path unchanged.
  //    Parallel + capped at 10 to avoid Cloudflare edge-timeout on the
  //    pipeline endpoint (sequential 15 × ~2s pushes us past 100s budget).
  if (isConfigured('hunter')) {
    const emailNeeded = accepted
      .filter(c => !c.email && c.name && c.currentCompany)
      .slice(0, 10);
    await Promise.all(emailNeeded.map(async (c) => {
      const domain = (c.currentCompany || '').toLowerCase().replace(/[^a-z0-9]+/g, '') + '.com';
      const found = await hunterEmailFinder({ domain, fullName: c.name });
      if (found && found.includes('@')) {
        c.email = found;
        c.emailVerification = 'hunter';
        c.enrichedBy = Array.from(new Set([...(c.enrichedBy || []), 'hunter']));
        c.enrichedAt = now();
      }
    }));
  }

  const candidates = [...accepted, ...review];

  // Persist scout stats on the need so a later manual /api/client-report/generate
  // call (no scoutStats arg) can still render the "No candidate-like profiles"
  // special message. Keyed by pipelineRunId so historical runs are preserved.
  const scoutStatsRecord = {
    sourcedRaw,
    acceptedCandidates: accepted.length,
    needsScoutReview: review.length,
    rejectedNonCandidates: rejected.length,
    rejectedSamples: rejected.slice(0, 10),
    rawResultsBySource,
    acceptedBySource,
    reviewBySource,
    rejectedBySource,
    rejectedByReason,
    rejectedReasonsBySource,
    sourceQueryStats,
    expansion: {
      enabled: !!expandCandidatePool,
      titleVariants: expansion.titleVariants,
      profileKeywords: expansion.profileKeywords,
      locationTiers: expansion.locationTiers,
    },
    // Explicit per-source aliases (top-level convenience for operators):
    apolloRaw: rawResultsBySource.apollo,
    firecrawlRaw: rawResultsBySource.firecrawl,
    githubRaw: rawResultsBySource.github,
    adzunaRaw: rawResultsBySource.adzuna,
    pdlRaw: rawResultsBySource.pdl,
    reviewCandidates: review.length,
    rejectedCandidates: rejected.length,
    at: now(),
  };
  if (!need.scoutStatsByRun) need.scoutStatsByRun = {};
  const runKey = pipelineRunId || '_manual';
  need.scoutStatsByRun[runKey] = scoutStatsRecord;
  need.lastScoutStats = scoutStatsRecord;
  pruneScoutStatsByRun(need);

  await persistDB();
  await logActivity(
    'Scout',
    `Sourced ${sourcedRaw} raw (apollo=${rawResultsBySource.apollo} firecrawl=${rawResultsBySource.firecrawl} github=${rawResultsBySource.github}) · ${accepted.length} accepted · ${review.length} review · ${rejected.length} rejected for "${need.title}"`,
    'success',
    { sourcedRaw, rawResultsBySource, acceptedBySource, reviewBySource, rejectedBySource, sourceQueryStats, expansion: scoutStatsRecord.expansion, accepted: accepted.length, review: review.length, rejected: rejected.length }
  );
  return {
    sourced: candidates.length,          // backwards-compatible: validator-input count
    sourcedRaw,
    acceptedCandidates: accepted.length,
    needsScoutReview: review.length,
    rejectedNonCandidates: rejected.length,
    rejectedSamples: rejected.slice(0, 10),
    rawResultsBySource,
    acceptedBySource,
    reviewBySource,
    rejectedBySource,
    rejectedByReason,
    rejectedReasonsBySource,
    sourceQueryStats,
    expansion: scoutStatsRecord.expansion,
    // Explicit per-source aliases for operator diagnostics:
    apolloRaw: rawResultsBySource.apollo,
    firecrawlRaw: rawResultsBySource.firecrawl,
    githubRaw: rawResultsBySource.github,
    adzunaRaw: rawResultsBySource.adzuna,
    pdlRaw: rawResultsBySource.pdl,
    reviewCandidates: review.length,
    rejectedCandidates: rejected.length,
    candidates,
  };
}

const LANG_SKILL = {
  JavaScript: ['JavaScript','React','Node.js','Vue','Express','Next.js'],
  TypeScript: ['TypeScript','React','Angular','Node.js','Next.js'],
  Python: ['Python','Django','FastAPI','Flask','TensorFlow','Pandas'],
  Java: ['Java','Spring Boot','Kafka'], Go: ['Go','gRPC','Docker'],
  Rust: ['Rust','WebAssembly'], Ruby: ['Ruby','Rails'], 'C++': ['C++'],
  'C#': ['C#','.NET'], PHP: ['PHP','Laravel'], Swift: ['Swift','iOS'], Kotlin: ['Kotlin','Android'],
};
function hasReviewEvidence(c) {
  if (!c) return false;
  if (c.linkedinUrl) return true;
  if (c.portfolioUrl) return true;
  if (c.resumeUrl) return true;
  if (c.sourceUrl) return true;
  if (Array.isArray(c.skills) && c.skills.length >= 1) return true;
  if (c.summary && c.summary.trim().length >= 20) return true;
  if (c.currentTitle) return true;
  if (c.source && c.source !== 'Manual') return true;
  return false;
}

async function runValidator({ candidateIds = null, pipelineRunId = null } = {}) {
  // Explicit array (even empty) wins; only fall back to all DB candidates when
  // candidateIds is null/undefined. Pipeline always passes the scout list so
  // validator counts stay scoped to the current run.
  const ids = Array.isArray(candidateIds) ? candidateIds : DB.candidates.map(c => c.id);
  await logActivity('Validator', `Validating ${ids.length} candidate(s)…`, 'running');
  let fullyValidated = 0, needsReview = 0, insufficientData = 0;
  for (const id of ids) {
    const c = DB.candidates.find(x => x.id === id);
    if (!c) continue;

    // Full GitHub validation path
    if (c.github) {
      const username = c.github.replace(/.*github\.com\//, '').replace(/\/$/, '');
      if (!username) {
        if (hasReviewEvidence(c)) {
          createValidation(id, { tier: 'Needs Review', evidenceNotes: 'Malformed GitHub URL — using profile/source evidence', pipelineRunId });
          needsReview++;
        } else {
          createValidation(id, { tier: 'Insufficient Data', evidenceNotes: 'Malformed GitHub URL and no other evidence', pipelineRunId });
          insufficientData++;
        }
        continue;
      }
      const repos = await githubRepos(username);
      if (!repos) {
        if (hasReviewEvidence(c)) {
          createValidation(id, { tier: 'Needs Review', evidenceNotes: 'GitHub fetch failed — profile/source evidence available', pipelineRunId });
          needsReview++;
        } else {
          createValidation(id, { tier: 'Insufficient Data', evidenceNotes: 'GitHub fetch failed and no other evidence', pipelineRunId });
          insufficientData++;
        }
        continue;
      }
      if (!repos.length) {
        createValidation(id, { tier: 'Profile-Based', evidenceNotes: 'GitHub account exists but no public repos', pipelineRunId });
        fullyValidated++;
        continue;
      }

      const langCount = {};
      let totalStars = 0, totalForks = 0, hasRecent = false;
      const tenDaysAgo = new Date(Date.now() - 10 * 86400 * 1000);
      for (const r of repos) {
        if (r.language) langCount[r.language] = (langCount[r.language] || 0) + 1;
        totalStars += (r.stargazers_count || 0);
        totalForks += (r.forks_count || 0);
        if (new Date(r.pushed_at) >= tenDaysAgo) hasRecent = true;
      }
      const proficiency = {};
      Object.entries(langCount).sort((a, b) => b[1] - a[1]).forEach(([lang, count]) => {
        const pct = Math.round((count / repos.length) * 100);
        const mapped = LANG_SKILL[lang] || [lang];
        mapped.forEach(skill => {
          proficiency[skill] = Math.max(proficiency[skill] || 0, Math.min(pct + Math.min(totalStars * 2, 20), 100));
        });
      });
      let tier = 'Profile-Based';
      if (Object.keys(proficiency).length >= 2 && hasRecent && totalStars >= 1) tier = 'Verified Active';
      createValidation(id, {
        tier, proficiency,
        githubStats: { repos: repos.length, stars: totalStars, forks: totalForks, hasRecent },
        evidenceNotes: `Pulled ${repos.length} repos`,
        pipelineRunId,
      });
      fullyValidated++;
      continue;
    }

    // No GitHub — fall back to Needs Review when other evidence exists
    if (hasReviewEvidence(c)) {
      createValidation(id, {
        tier: 'Needs Review',
        evidenceNotes: 'No GitHub — profile/source/skill evidence present, manual review',
        pipelineRunId,
      });
      needsReview++;
    } else {
      createValidation(id, {
        tier: 'Insufficient Data',
        evidenceNotes: 'No GitHub and no usable profile/source/skill evidence',
        pipelineRunId,
      });
      insufficientData++;
    }
  }
  await persistDB();
  const validated = fullyValidated + needsReview;
  await logActivity(
    'Validator',
    `Validated ${validated}/${ids.length} (full ${fullyValidated} · review ${needsReview} · insufficient ${insufficientData})`,
    'success',
    { fullyValidated, needsReview, insufficientData },
  );
  return { validated, fullyValidated, needsReview, insufficientData, total: ids.length };
}

function scoreCandidateAgainstNeed(c, need, pipelineRunId = null) {
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9+#]/g, '');
  const cSkills = new Set((c.skills || []).map(norm));
  const req = (need.requiredSkills || []);
  const matched = req.filter(s => cSkills.has(norm(s)));
  const missing = req.filter(s => !cSkills.has(norm(s)));
  const reasons = [];

  // Run-scoped: only use validation evidence from the current pipeline run.
  const v = latestValidation(c.id, pipelineRunId);
  let skillRaw = 0;
  if (req.length) {
    if (v?.proficiency && Object.keys(v.proficiency).length) {
      const profScores = matched.map(s => {
        const key = Object.keys(v.proficiency).find(k => norm(k) === norm(s));
        return key ? v.proficiency[key] / 100 : 0.5;
      });
      skillRaw = profScores.length ? (profScores.reduce((a, b) => a + b, 0) / req.length) * 100 : 0;
    } else { skillRaw = (matched.length / req.length) * 100; }
  } else { skillRaw = 50; }
  const skillScore = Math.min(skillRaw, 100) * 0.35;
  if (matched.length) reasons.push(`Matches ${matched.length}/${req.length} required skills: ${matched.join(', ')}`);

  const senOrder = ['Junior','Mid','Senior','Staff','Principal','Director'];
  const cSenIdx = senOrder.findIndex(s => (c.currentTitle || '').toLowerCase().includes(s.toLowerCase()));
  const nSenIdx = senOrder.indexOf(need.seniority || 'Mid');
  let senRaw = 50;
  let senMismatch = false;
  if (cSenIdx >= 0 && nSenIdx >= 0) {
    const diff = Math.abs(cSenIdx - nSenIdx);
    senRaw = diff === 0 ? 100 : diff === 1 ? 75 : diff === 2 ? 45 : 20;
    if (diff === 0) reasons.push(`Seniority match: ${need.seniority}`);
    if (diff >= 2) senMismatch = true;
  }
  const senScore = senRaw * 0.20;

  const cLoc = (c.location || '').toLowerCase();
  const pLoc = (need.location || '').toLowerCase();
  let locRaw = 30;
  let locMismatch = false;
  if (need.locationType === 'Remote' || cLoc.includes('remote')) { locRaw = 100; reasons.push('Remote-friendly'); }
  else if (pLoc && cLoc && (cLoc.includes(pLoc) || pLoc.includes(cLoc))) { locRaw = 100; reasons.push(`Location match: ${c.location}`); }
  else if (pLoc && cLoc) { locMismatch = true; }
  const locScore = locRaw * 0.15;

  let availRaw = 50;
  if (v?.githubStats?.hasRecent) { availRaw = 90; reasons.push('Active in last 10 days'); }
  else if (c.source === 'GitHub' || c.source === 'LinkedIn') availRaw = 65;
  const availScore = availRaw * 0.15;

  let valRaw = 20;
  if (v?.tier === 'Verified Active') { valRaw = 100; reasons.push('Verified Active on GitHub'); }
  else if (v?.tier === 'Profile-Based') { valRaw = 60; reasons.push('Profile-based verification'); }
  const valScore = valRaw * 0.15;

  const total = Math.min(Math.round(skillScore + senScore + locScore + availScore + valScore), 100);
  const tier = tierFromScore(total);

  const issues = [];
  if (req.length && matched.length === 0) issues.push('No required skill overlap');
  if (missing.length) issues.push(`Missing required skills: ${missing.join(', ')}`);
  if (v?.tier === 'Needs Review') issues.push(c.github ? 'Partial evidence only — needs human review' : 'Missing GitHub but has profile/source data');
  if (v?.tier === 'Insufficient Data') issues.push('Insufficient public evidence');
  if (senMismatch) issues.push('Seniority mismatch');
  if (locMismatch) issues.push('Location mismatch');

  let dropReason = '', reviewReason = '';
  if (tier === 'Drop') {
    dropReason = issues.length ? issues.join(' · ') : 'Below match threshold';
  } else if (tier === 'Weak Match' || tier === 'Review') {
    reviewReason = issues.length ? issues.join(' · ') : 'Borderline — needs review';
  }

  if (!reasons.length) reasons.push('Broad skill set aligns with role');
  return { score: total, tier, matchedSkills: matched, missingSkills: missing, reasoning: reasons, dropReason, reviewReason };
}

async function runMatchmaker({ needId, pipelineRunId = null } = {}) {
  const need = DB.hiring_needs.find(n => n.id === needId);
  if (!need) { await logActivity('Matchmaker', 'Need not found', 'error'); return { matched: 0, visible: 0, dropped: 0 }; }

  // Scope to current run when pipelineRunId is provided so dropped counts don't accumulate.
  // FINAL SHORTLIST POLICY: STRICT.
  //   1. scoutDecision === 'accepted'  (exact string; NOT null, undefined, '',
  //      'review', 'rejected', 'demo', legacy, or anything else)
  //   2. hasUsableProfileLink(c) === true  (real LinkedIn /in/ OR real GitHub
  //      user OR real http(s) portfolio/source URL; NEVER apollo:// synthetic)
  // Any candidate failing either gate stays out of Matchmaker, out of matches,
  // out of the client report.
  const allInRun = pipelineRunId
    ? DB.candidates.filter(c => c.pipelineRunId === pipelineRunId)
    : DB.candidates;
  // Single source of truth: isFinalShortlistEligible. Anything failing the
  // central gate (review/rejected/demo/null scoutDecision OR no LinkedIn /in/
  // and no verified GitHub user) stays out of the pool.
  const pool = allInRun.filter(isFinalShortlistEligible);
  const reviewPoolSize = allInRun.length - pool.length;
  if (!pool.length) {
    await logActivity(
      'Matchmaker',
      `No accepted candidates in pool${pipelineRunId ? ` for run ${pipelineRunId}` : ''} (review pool: ${reviewPoolSize})`,
      'warn',
      { reviewPoolSize }
    );
    return { matched: 0, visible: 0, dropped: 0, reviewPoolSize };
  }
  await logActivity(
    'Matchmaker',
    `Scoring ${pool.length} candidate(s) against "${need.title}"${pipelineRunId ? ` (run ${pipelineRunId})` : ''}…`,
    'running',
  );

  const scored = pool.map(c => ({ c, ...scoreCandidateAgainstNeed(c, need, pipelineRunId) }));
  scored.sort((a, b) => b.score - a.score);

  scored.forEach((entry, i) => {
    createOrUpdateMatch({
      needId, candidateId: entry.c.id, pipelineRunId,
      score: entry.score, tier: entry.tier,
      matchedSkills: entry.matchedSkills, missingSkills: entry.missingSkills,
      reasoning: entry.reasoning, rank: i + 1,
      dropReason: entry.dropReason, reviewReason: entry.reviewReason,
    });
  });
  await persistDB();

  const matchFilter = pipelineRunId
    ? (m => m.needId === needId && m.pipelineRunId === pipelineRunId)
    : (m => m.needId === needId);
  // Stale-match safety: visible count uses isVisibleMatch which re-checks
  // CURRENT candidate state (scoutDecision === 'accepted' + usable link).
  // An old match whose candidate has since flipped to review/rejected is
  // no longer counted as visible.
  const visible = DB.matches.filter(m => matchFilter(m) && isVisibleMatch(m)).length;
  const dropped = DB.matches.filter(m => matchFilter(m) && m.tier === 'Drop').length;
  await logActivity('Matchmaker', `${visible} visible · ${dropped} dropped · ${reviewPoolSize} in review pool`, 'success', { visible, dropped, reviewPoolSize });
  return { matched: scored.length, visible, dropped, reviewPoolSize };
}

async function runComposer({ needId, managerId, matchIds = [], kind }) {
  const manager = DB.hiring_managers.find(m => m.id === managerId);
  if (!manager) { await logActivity('Composer', 'Manager not found', 'error'); return { drafted: false }; }
  const resolvedKind = kind || (needId ? 'shortlist-pitch' : 'warm-intro');
  const need = needId ? DB.hiring_needs.find(n => n.id === needId) : null;
  const company = DB.companies.find(c => c.id === manager.companyId);
  const first = (manager.name || '').split(' ')[0] || 'there';

  let subject = '', body = '';

  // Try OpenAI first; fall back to template
  if (isConfigured('openai')) {
    const sys = `You are an internal recruiting assistant for Sola Scholar — an in-house AI recruiting intelligence service for cybersecurity and cloud hiring. Write a brief, concrete, no-spam email. Tone: respectful, value-first, never desperate. Output JSON only: {"subject":"...","body":"..."}.`;
    let usr;
    if (resolvedKind === 'shortlist-pitch' && need) {
      const skillsTop = (need.requiredSkills || []).slice(0, 5).join(', ');
      usr = `Draft a short outreach email pitching a vetted shortlist for the role "${need.title}" at ${company?.name || 'their company'}. Recipient: ${first}, ${manager.title}. Skills the candidates have: ${skillsTop || 'unspecified'}. ${matchIds.length} candidates are in the shortlist.`;
    } else {
      usr = `Draft a short warm intro email to ${first}, ${manager.title} at ${company?.name || 'their company'}. We are Sola Scholar — in-house AI recruiting intelligence for cybersecurity and cloud hiring. No specific role yet — we want a 15 min intro.`;
    }
    const resp = await openaiComplete(sys, usr, { maxTokens: 400 });
    if (resp) {
      try {
        const parsed = JSON.parse(resp.replace(/^```json\n?|```$/g, ''));
        if (parsed.subject && parsed.body) { subject = parsed.subject; body = parsed.body; }
      } catch { /* fall through to template */ }
    }
  }
  if (!subject || !body) {
    if (resolvedKind === 'shortlist-pitch' && need) {
      const skills = (need.requiredSkills || []).slice(0, 3).join(', ');
      subject = `Re: ${need.title}${company ? ` at ${company.name}` : ''} — vetted shortlist`;
      body = `Hi ${first},\n\nI noticed your team may be hiring for ${need.title}${company ? ` at ${company.name}` : ''}. We recently identified and vetted a small group of candidates with experience in ${skills || 'the skill areas you need'}.\n\nIf filling this role is still a priority, I'd be happy to share a one-page summary of the top three.\n\nBest,\nSola Scholar`;
    } else {
      subject = `Hello from Sola Scholar — talent partner for ${company?.name || 'your team'}`;
      body = `Hi ${first},\n\nWe work with security and engineering leaders to surface vetted, demand-first shortlists — only when the need is real.\n\nIf hiring is on your roadmap this quarter, I'd love a 15-minute intro to learn what you're prioritising. No pitch, just listening first.\n\nBest,\nSola Scholar`;
    }
  }

  const o = createOutreach({ managerId, needId: resolvedKind === 'warm-intro' ? null : needId, matchIds: resolvedKind === 'warm-intro' ? [] : matchIds, channel: 'email', subject, body, kind: resolvedKind });
  await persistDB();
  await logActivity('Composer', `${resolvedKind} drafted for ${manager.name}`, 'success');
  return { drafted: true, outreach: o };
}

async function generateClientReport({ needId, pipelineRunId = null, scoutStats = null } = {}) {
  const need = DB.hiring_needs.find(n => n.id === needId);
  if (!need) return { ok: false, reason: 'Need not found' };
  const company = DB.companies.find(c => c.id === need.companyId);

  // Manual-call fallback for scoutStats — STRICTLY run-scoped to avoid stale
  // "No candidate-like profiles" messages bleeding between runs.
  //   • pipelineRunId provided: only need.scoutStatsByRun[pipelineRunId] — no
  //     fallback to need.lastScoutStats (which could be from a different run).
  //   • pipelineRunId absent: need.lastScoutStats is allowed.
  if (!scoutStats) {
    if (pipelineRunId) {
      scoutStats = (need.scoutStatsByRun && need.scoutStatsByRun[pipelineRunId]) || null;
    } else if (need.lastScoutStats) {
      scoutStats = need.lastScoutStats;
    }
  }
  const matchScope = pipelineRunId
    ? (m => m.needId === needId && m.pipelineRunId === pipelineRunId)
    : (m => m.needId === needId);
  // isVisibleMatch enforces tier !== 'Drop' AND current candidate state still
  // satisfies (scoutDecision === 'accepted' + usable profile link). Identical
  // gate to matchmaker visible / /api/matches default / dashboard stats so
  // stale matches cannot leak into the final report.
  const visibleMatches = DB.matches.filter(m => matchScope(m) && isVisibleMatch(m));
  const matches = visibleMatches
    .slice()
    .sort((a, b) => {
      const aStrong = (a.score || 0) >= 60 ? 1 : 0;
      const bStrong = (b.score || 0) >= 60 ? 1 : 0;
      if (aStrong !== bStrong) return bStrong - aStrong;
      if ((a.score || 0) !== (b.score || 0)) return (b.score || 0) - (a.score || 0);
      return (a.rank || Number.MAX_SAFE_INTEGER) - (b.rank || Number.MAX_SAFE_INTEGER);
    })
    .slice(0, CLIENT_REPORT_CANDIDATE_LIMIT);

  const nextStep = tier =>
    tier === 'Strong Match' ? 'Schedule intro call this week'
    : tier === 'Review' ? 'Phone screen in next 7 days'
    : tier === 'Weak Match' ? 'Review profile to assess fit — borderline'
    : 'Review profile to assess fit';

  const candidates = matches.map(m => {
    const c = DB.candidates.find(x => x.id === m.candidateId);
    const v = c ? latestValidation(c.id, pipelineRunId) : null;
    const displayLabel = matchDisplayLabel(m.score, c, m, v);
    // Keep the Needs Review guardrail visible in the client report: when evidence
    // is incomplete, the recommended action is manual review, never a direct
    // client submission. This does NOT change the score, label, or ordering.
    const needsManualReview = (v?.tier || '') === 'Needs Review';
    const links = collectCandidateProfileLinks(c || {});
    const profileLinkCount = Object.values(links).filter(Boolean).length;
    return {
      name: c?.name || '',
      currentTitle: c?.currentTitle || '',
      currentCompany: c?.currentCompany || '',
      location: c?.location || '',
      score: m.score,
      tier: m.tier,
      displayLabel,
      displayHelper: matchDisplayHelper(m.score, displayLabel),
      matchedSkills: m.matchedSkills || [],
      missingSkills: m.missingSkills || [],
      validationTier: v?.tier || 'Not Validated',
      needsManualReview,
      reviewStatus: c?.reviewStatus || (needsManualReview ? 'Needs Manual Review' : ''),
      evidenceNotes: v?.evidenceNotes || '',
      whyFits: (m.reasoning || []).join(' · '),
      reviewReason: m.reviewReason || '',
      recommendedNextStep: needsManualReview
        ? 'Manual review required — confirm evidence before client submission'
        : nextStep(m.tier),
      links,
      hasUsableProfileLink: profileLinkCount > 0,
      profileLinkWarning: profileLinkCount ? '' : 'No usable profile link — manual review required',
      sourceVariants: c?.searchVariantsFound || [],
      searchVariantMeta: c?.searchVariantMeta || [],
      providersFound: c?.providersFound || [],
      locationTiersMatched: c?.locationTiersMatched || [],
      proximity_tier: c?.proximity_tier || '',
      proximity_rank: c?.proximity_rank || null,
      profileKeywordSignals: c?.profileKeywordSignals || [],
      privateProfileWarning: c?.privateProfileWarning || '',
      seniority_signal: c?.seniority_signal || '',
      experience_level_guess: c?.experience_level_guess || '',
      work_experience_evidence: c?.work_experience_evidence || '',
      entry_level_warning: c?.entry_level_warning || '',
      sourceProvider: (c?.providersFound || [c?.source || '']).filter(Boolean)[0] || '',
    };
  });

  // Summary — special-case when there are no real verified candidates in the
  // shortlist. The shortlist only contains scoutDecision === 'accepted'
  // candidates with real profile links; review/possible_candidate records
  // never appear here.
  let summary = '';
  const noShortlist = candidates.length === 0;
  const allFilteredAsNonCandidates = noShortlist
    && scoutStats
    && scoutStats.rejectedNonCandidates > 0
    && (scoutStats.acceptedCandidates || 0) === 0
    && (scoutStats.needsScoutReview || 0) === 0;
  const onlyReviewPool = noShortlist
    && scoutStats
    && (scoutStats.acceptedCandidates || 0) === 0
    && (scoutStats.needsScoutReview || 0) > 0;

  if (allFilteredAsNonCandidates) {
    summary = `No real verified candidates found. Scout found ${scoutStats.rejectedNonCandidates} keyword-related page${scoutStats.rejectedNonCandidates === 1 ? '' : 's'}, but they were job posts/blogs/docs and were excluded.`;
  } else if (onlyReviewPool) {
    summary = `No real verified candidates found. Scout returned ${scoutStats.needsScoutReview} candidate${scoutStats.needsScoutReview === 1 ? '' : 's'} flagged for manual review (no verified profile link); none have been included in the shortlist.`;
  } else if (noShortlist) {
    summary = `No real verified candidates found.`;
  } else if (isConfigured('openai') && candidates.length) {
    const sys = 'You are a recruiting analyst writing a concise (3 sentence) executive summary of a candidate shortlist for a client. Plain prose, factual, value-focused.';
    const usr = `Role: ${need.title} at ${company?.name || 'the company'}. Required skills: ${(need.requiredSkills || []).join(', ') || 'unspecified'}. Top candidate: ${candidates[0].name} (${candidates[0].score}/100, label: ${candidates[0].displayLabel || candidates[0].tier}). ${candidates.length} candidates total. Tone: factual.`;
    summary = (await openaiComplete(sys, usr, { maxTokens: 250 })) || '';
  }
  if (!summary) {
    const top = candidates[0];
    summary = candidates.length
      ? `Shortlist of ${candidates.length} vetted candidate${candidates.length > 1 ? 's' : ''} for the ${need.title} role${company ? ` at ${company.name}` : ''}. Top match: ${top?.name || '—'} (${top?.score || 0}/100, ${top?.displayLabel || top?.tier || ''}). All candidates have been validated against the required skill set.`
      : `No qualifying candidates available yet for the ${need.title} role.`;
  }

  // Email draft
  const emailDraft = `Subject: ${need.title}${company ? ` at ${company.name}` : ''} — vetted shortlist (${candidates.length} candidates)

Hi [client first name],

${summary}

Top candidates:
${candidates.map((c, i) => `${i + 1}. ${c.name} — ${c.currentTitle}${c.currentCompany ? ` (${c.currentCompany})` : ''}
   Match score: ${c.score}/100 (${c.displayLabel || c.tier})
   Strong on: ${c.matchedSkills.join(', ') || '—'}
   Gaps: ${c.missingSkills.join(', ') || 'none'}
   Validation: ${c.validationTier}
   Source: ${(c.providersFound || []).join(', ') || c.sourceProvider || 'unknown'}${c.proximity_tier ? ` · ${c.proximity_tier}` : ''}
   Found through: ${(c.sourceVariants || []).slice(0, 3).join(', ') || 'not captured'}
   Profile links: ${Object.values(c.links || {}).filter(Boolean).join(' | ') || c.profileLinkWarning}
   Review warnings: ${[c.privateProfileWarning, c.entry_level_warning].filter(Boolean).join(' · ') || 'none'}
   Why fits: ${c.whyFits}
   Next step: ${c.recommendedNextStep}`).join('\n\n')}

Happy to set up intro calls with any of the above. Just let me know which to prioritise.

Best,
Sola Scholar
`;

  // CSV
  const esc = v => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const csvRows = [
    ['Rank','Name','Title','Company','Location','Match Score','Tier','Matched Skills','Missing Skills','Validation','Review Status','Source Variants','Variant Metadata','Proximity Tier','Profile Keywords','Private Profile Warning','Entry-Level Warning','Why Fits','Next Step','GitHub','LinkedIn','Source Profile','Portfolio','Resume'].map(esc).join(','),
    ...candidates.map((c, i) => [i+1, c.name, c.currentTitle, c.currentCompany, c.location, c.score, c.displayLabel || c.tier, c.matchedSkills.join(';'), c.missingSkills.join(';'), c.validationTier, c.reviewStatus, c.sourceVariants.join(';'), (c.searchVariantMeta || []).map(v => `${v.title}:${v.variant_type}:${v.specificity_weight}`).join(';'), c.proximity_tier, c.profileKeywordSignals.join(';'), c.privateProfileWarning, c.entry_level_warning, c.whyFits, c.recommendedNextStep, c.links.github, c.links.linkedin, c.links.source, c.links.portfolio, c.links.resume].map(esc).join(',')),
  ];
  const csv = csvRows.join('\n');

  const report = createClientReport({
    needId,
    pipelineRunId,
    companyName: company?.name || '',
    roleTitle: need.title,
    summary,
    candidates,
    candidateLimit: CLIENT_REPORT_CANDIDATE_LIMIT,
    visibleMatchCount: visibleMatches.length,
    emailDraft,
    csv,
  });
  await persistDB();
  await logActivity('Client Report', `Generated for "${need.title}" (${candidates.length} candidates)`, 'success');
  return { ok: true, report };
}

function newPipelineRunId() {
  return 'run_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

async function runPipeline({ company, role, skills = [], location = '', seniority = 'Mid', expandCandidatePool = false }) {
  const pipelineRunId = newPipelineRunId();
  console.log(`[pipeline] start runId=${pipelineRunId} role="${role}" company="${company}"`);
  await logActivity('Pipeline', `Pipeline start ${pipelineRunId}: ${role} @ ${company}`, 'running', { pipelineRunId });
  const result = { pipelineRunId, steps: [] };

  // 1. Find/create company
  const co = findOrCreateCompany({ name: company, pipelineRunId });
  result.companyId = co.id;
  result.steps.push({ step: 'company', companyId: co.id });

  // 2. Try to find a manager (best-effort) — STRICTLY scoped to THIS company.
  // Never borrow a manager from an unrelated company that the connector happened
  // to surface (e.g., conn.managers[0]) — that would attach Company B's hiring
  // manager to a Company A need.
  let mgr = DB.hiring_managers.find(m => m.companyId === co.id);
  if (!mgr) {
    await runConnector({ industry: '', titles: ROLE_TITLES_DEFAULT, pipelineRunId });
    mgr = DB.hiring_managers.find(m => m.companyId === co.id) || null;
  }
  result.managerId = mgr?.id || null;
  // managerId === null is NOT an error: candidate-only searches skip hiring-manager
  // discovery on purpose. Expose an explicit, human-readable status so the UI and
  // client reports never surface a raw "managerId: null" debug value.
  result.managerStatus = mgr ? 'found' : 'skipped';
  result.managerStatusLabel = mgr
    ? 'Hiring manager linked'
    : 'Manager lookup skipped — candidate search mode';
  result.steps.push({
    step: 'manager',
    managerId: mgr?.id || null,
    status: result.managerStatusLabel,
  });

  // 3. Create a confirmed need (we trust the request — we typed the role)
  const need = createNeed({
    companyId: co.id, managerId: mgr?.id || null,
    title: role, requiredSkills: Array.isArray(skills) ? skills : [],
    seniority, locationType: location?.toLowerCase().includes('remote') ? 'Remote' : 'Onsite',
    location, confirmed: true, urgency: 'Medium',
    pipelineRunId,
  });
  await persistDB();
  result.needId = need.id;
  result.steps.push({ step: 'need', needId: need.id });

  // 4. Source candidates (scoped by pipelineRunId; scout rejects job posts/blogs/docs)
  const scout = await runScout({ needId: need.id, pipelineRunId, expandCandidatePool: !!expandCandidatePool });
  result.steps.push({
    step: 'scout',
    sourcedRaw: scout.sourcedRaw,
    acceptedCandidates: scout.acceptedCandidates,
    needsScoutReview: scout.needsScoutReview,
    rejectedNonCandidates: scout.rejectedNonCandidates,
  });

  // 5. Validate only the candidates this run sourced (rejected pages never reach here)
  const scoutIds = Array.from(new Set((scout.candidates || []).map(c => c.id)));
  const val = await runValidator({ candidateIds: scoutIds, pipelineRunId });
  result.steps.push({
    step: 'validate',
    fullyValidated: val.fullyValidated,
    needsReview: val.needsReview,
    insufficientData: val.insufficientData,
    validated: val.validated,
  });

  // 6. Match only this run's candidates against this run's need
  const mm = await runMatchmaker({ needId: need.id, pipelineRunId });
  result.steps.push({ step: 'match', visible: mm.visible, dropped: mm.dropped });

  // 7. Generate client report from this run's matches (with scout context)
  const scoutStats = {
    sourcedRaw: scout.sourcedRaw,
    acceptedCandidates: scout.acceptedCandidates,
    needsScoutReview: scout.needsScoutReview,
    rejectedNonCandidates: scout.rejectedNonCandidates,
    rawResultsBySource: scout.rawResultsBySource,
    acceptedBySource: scout.acceptedBySource,
    reviewBySource: scout.reviewBySource,
    rejectedByReason: scout.rejectedByReason,
    expansion: scout.expansion,
  };
  const rep = await generateClientReport({ needId: need.id, pipelineRunId, scoutStats });
  result.steps.push({ step: 'report', reportId: rep.report?.id || null });
  result.report = rep.report;

  const counts = {
    pipelineRunId,
    sourcedRaw: scout.sourcedRaw,
    acceptedCandidates: scout.acceptedCandidates,
    needsScoutReview: scout.needsScoutReview,
    rejectedNonCandidates: scout.rejectedNonCandidates,
    rawResultsBySource: scout.rawResultsBySource,
    acceptedBySource: scout.acceptedBySource,
    rejectedByReason: scout.rejectedByReason,
    sourced: scout.sourced,
    validatorInput: scoutIds.length,
    fullyValidated: val.fullyValidated,
    needsReview: val.needsReview,
    insufficientData: val.insufficientData,
    validated: val.validated,
    matchmakerInput: mm.matched,
    visible: mm.visible,
    dropped: mm.dropped,
    reportId: rep.report?.id || null,
  };
  console.log(`[pipeline] counts ${JSON.stringify(counts)}`);
  await logActivity('Pipeline', `Pipeline complete for "${role}" @ ${company}`, 'success', counts);

  return {
    pipelineRunId,
    sourcedRaw: scout.sourcedRaw,
    acceptedCandidates: scout.acceptedCandidates,
    needsScoutReview: scout.needsScoutReview,
    rejectedNonCandidates: scout.rejectedNonCandidates,
    rejectedSamples: scout.rejectedSamples || [],
    rawResultsBySource: scout.rawResultsBySource,
    acceptedBySource: scout.acceptedBySource,
    reviewBySource: scout.reviewBySource,
    rejectedBySource: scout.rejectedBySource,
    rejectedByReason: scout.rejectedByReason,
    rejectedReasonsBySource: scout.rejectedReasonsBySource,
    expansion: scout.expansion,
    // Explicit per-source aliases (the fields the operator asked for by name):
    apolloRaw: scout.apolloRaw,
    firecrawlRaw: scout.firecrawlRaw,
    githubRaw: scout.githubRaw,
    adzunaRaw: scout.adzunaRaw,
    pdlRaw: scout.pdlRaw,
    reviewCandidates: scout.reviewCandidates,
    rejectedCandidates: scout.rejectedCandidates,
    sourced: scout.sourced,
    fullyValidated: val.fullyValidated,
    needsReview: val.needsReview,
    insufficientData: val.insufficientData,
    validated: val.validated,
    visible: mm.visible,
    dropped: mm.dropped,
    reportId: rep.report?.id || null,
    companyId: co.id,
    managerId: mgr?.id || null,
    managerStatus: result.managerStatus,
    managerStatusLabel: result.managerStatusLabel,
    needId: need.id,
    report: rep.report,
    steps: result.steps,
  };
}

/* ════════════════════════════════════════════════════════════════════
   EXPRESS APP
   ════════════════════════════════════════════════════════════════════ */
const app = express();
app.use(express.json({ limit: '1mb' }));

// ── Internal Basic Auth (skips /api/health and static frontend) ──
function requireAuth(req, res, next) {
  if (!INTERNAL_PASSWORD) {
    return res.status(503).json({ error: 'Server misconfigured: INTERNAL_PASSWORD env var is not set. Refusing to expose API without auth.' });
  }
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Sola Scholar"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  let user, pass;
  try {
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    user = decoded.slice(0, idx);
    pass = decoded.slice(idx + 1);
  } catch { return res.status(400).json({ error: 'Bad Authorization header' }); }

  const expectedUser = Buffer.from(INTERNAL_USER);
  const expectedPass = Buffer.from(INTERNAL_PASSWORD);
  const givenUser = Buffer.from(user || '');
  const givenPass = Buffer.from(pass || '');
  const userOk = givenUser.length === expectedUser.length && crypto.timingSafeEqual(givenUser, expectedUser);
  const passOk = givenPass.length === expectedPass.length && crypto.timingSafeEqual(givenPass, expectedPass);
  if (!userOk || !passOk) {
    res.set('WWW-Authenticate', 'Basic realm="Sola Scholar"');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  return next();
}

// ── Health (open, no auth, never exposes values or local filesystem paths) ──
app.get('/api/health', (req, res) => {
  const services = {};
  for (const svc of Object.keys(SERVICES)) services[svc] = isConfigured(svc) ? 'configured' : 'missing';
  res.json({
    status: 'ok',
    version: '1.0.0',
    services,
    auth: INTERNAL_PASSWORD ? 'enabled' : 'disabled-NOT-PRODUCTION-SAFE',
  });
});

// ── All other API routes require auth ──
app.use('/api', requireAuth);

// ── Provider diagnostics (auth-protected; sanitized, never exposes secrets) ──
app.get('/api/providers/status', (req, res) => {
  res.json({ providers: providerDiagnostics(), checkedAt: now() });
});

// ── Role templates (auth-protected; editable in config/role-templates.json) ──
app.get('/api/role-templates', (req, res) => {
  res.json(ROLE_TEMPLATES);
});

// ── Scoring profiles (auth-protected, READ-ONLY reference; not used in score math
//    while SCORING_PROFILES.enabled is false) ──
app.get('/api/scoring-profiles', (req, res) => {
  res.json(SCORING_PROFILES);
});

// ── GET routes (read collections) ──
app.get('/api/dashboard/stats', (req, res) => {
  res.json({
    companies: DB.companies.length,
    hiring_managers: DB.hiring_managers.length,
    hiring_needs: DB.hiring_needs.length,
    confirmed_needs: DB.hiring_needs.filter(n => n.confirmed).length,
    candidates: DB.candidates.length,
    candidate_validations: DB.candidate_validations.length,
    matches: DB.matches.length,
    matches_visible: DB.matches.filter(isVisibleMatch).length,
    outreach: DB.outreach.length,
    client_reports: DB.client_reports.length,
    activity_logs: DB.activity_logs.length,
  });
});
app.get('/api/companies',        (req, res) => res.json(DB.companies));
app.get('/api/hiring-managers',  (req, res) => res.json(DB.hiring_managers));
app.get('/api/hiring-needs',     (req, res) => res.json(DB.hiring_needs));
app.get('/api/candidates',       (req, res) => res.json(DB.candidates));
app.get('/api/candidate-validations', (req, res) => res.json(DB.candidate_validations));
app.get('/api/matches', (req, res) => {
  // Default: hide stale matches (current candidate state no longer satisfies
  // the shortlist contract). Pass `?all=1` or `?includeStale=1` to see every
  // raw match record. Stale matches remain in DB.matches for audit.
  const includeStale = req.query && (
    req.query.all === '1' || req.query.all === 'true' ||
    req.query.includeStale === '1' || req.query.includeStale === 'true'
  );
  if (includeStale) return res.json(DB.matches);
  return res.json(DB.matches.filter(isVisibleMatch));
});
app.get('/api/outreach',         (req, res) => res.json(DB.outreach));
app.get('/api/client-reports',   (req, res) => res.json(DB.client_reports));
app.get('/api/activity-logs',    (req, res) => res.json(DB.activity_logs.slice(0, 100)));

// ── Mutation: small CRUD helpers used by the UI ──
app.post('/api/companies', async (req, res) => {
  const co = findOrCreateCompany(req.body || {});
  if (!co) return res.status(400).json({ error: 'name required' });
  await persistDB();
  res.json(co);
});
app.post('/api/hiring-managers', async (req, res) => {
  const { name, title, companyName, email, linkedinUrl } = req.body || {};
  if (!name || !companyName || !email || !email.includes('@')) return res.status(400).json({ error: 'name, companyName, real email required' });
  const co = findOrCreateCompany({ name: companyName });
  const m = findOrCreateManager({ name, title, companyId: co.id, email, emailConfidence: 'verified', linkedinUrl, source: 'Manual', roleCategory: categorizeManagerTitle(title || '') });
  await persistDB();
  res.json(m);
});
app.post('/api/hiring-needs', async (req, res) => {
  const { companyName, ...rest } = req.body || {};
  if (!rest.title || !companyName) return res.status(400).json({ error: 'title and companyName required' });
  const co = findOrCreateCompany({ name: companyName });
  const need = createNeed({ ...rest, companyId: co.id });
  await persistDB();
  res.json(need);
});
app.patch('/api/hiring-needs/:id', async (req, res) => {
  const n = DB.hiring_needs.find(x => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: 'Not found' });
  const allow = ['title','description','requiredSkills','seniority','locationType','location','urgency','status','confirmed','sourceUrl'];
  for (const k of allow) if (k in (req.body || {})) n[k] = req.body[k];
  await persistDB();
  res.json(n);
});
app.delete('/api/hiring-needs/:id', async (req, res) => {
  const i = DB.hiring_needs.findIndex(x => x.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  DB.hiring_needs.splice(i, 1);
  await persistDB();
  res.json({ ok: true });
});
app.patch('/api/matches/:id', async (req, res) => {
  const m = DB.matches.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  if ('status' in (req.body || {})) m.status = req.body.status;
  await persistDB();
  res.json(m);
});
app.patch('/api/outreach/:id', async (req, res) => {
  const o = DB.outreach.find(x => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  const allow = ['subject','body','status','replyText','nextAction'];
  for (const k of allow) if (k in (req.body || {})) o[k] = req.body[k];
  if (req.body?.status === 'sent' && !o.sentAt) o.sentAt = now();
  if (req.body?.status === 'replied' && !o.repliedAt) o.repliedAt = now();
  await persistDB();
  res.json(o);
});

// ── Agent runs ──
app.post('/api/connector/run', async (req, res) => {
  try { res.json(await runConnector(req.body || {})); }
  catch (e) { console.error('connector', e); res.status(500).json({ error: e.message }); }
});
app.post('/api/needs/detect', async (req, res) => {
  try { res.json(await runNeedDetector(req.body || {})); }
  catch (e) { console.error('needs/detect', e); res.status(500).json({ error: e.message }); }
});
app.post('/api/scout/run', async (req, res) => {
  try { res.json(await runScout(req.body || {})); }
  catch (e) { console.error('scout', e); res.status(500).json({ error: e.message }); }
});
app.post('/api/validator/run', async (req, res) => {
  try { res.json(await runValidator(req.body || {})); }
  catch (e) { console.error('validator', e); res.status(500).json({ error: e.message }); }
});
app.post('/api/matchmaker/run', async (req, res) => {
  try { res.json(await runMatchmaker(req.body || {})); }
  catch (e) { console.error('matchmaker', e); res.status(500).json({ error: e.message }); }
});
app.post('/api/outreach/draft', async (req, res) => {
  try { res.json(await runComposer(req.body || {})); }
  catch (e) { console.error('outreach/draft', e); res.status(500).json({ error: e.message }); }
});
app.post('/api/client-report/generate', async (req, res) => {
  try { res.json(await generateClientReport(req.body || {})); }
  catch (e) { console.error('client-report', e); res.status(500).json({ error: e.message }); }
});
app.post('/api/pipeline/run', async (req, res) => {
  const { company, role } = req.body || {};
  if (!company || !role) return res.status(400).json({ error: 'company and role required' });
  try { res.json(await runPipeline(req.body)); }
  catch (e) { console.error('pipeline', e); res.status(500).json({ error: e.message }); }
});

// ── Optional: airtable mirror (push current DB) ──
app.post('/api/airtable/sync', async (req, res) => {
  if (!isConfigured('airtable')) return res.status(400).json({ error: 'Airtable not configured' });
  // Push a flat snapshot of matches as the simplest mirror; full multi-table sync is V2.
  const records = DB.matches.map(m => {
    const c = DB.candidates.find(x => x.id === m.candidateId);
    const n = DB.hiring_needs.find(x => x.id === m.needId);
    return {
      'Candidate': c?.name || '', 'Role': n?.title || '',
      'Score': m.score, 'Tier': m.tier, 'Rank': m.rank,
      'Matched Skills': (m.matchedSkills || []).join(', '),
      'Status': m.status,
    };
  });
  const r = await airtablePush(records);
  res.json(r);
});

// ── Static frontend ──
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// ── 404 for unknown api ──
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

// ── Top-level error handler ──
app.use((err, req, res, next) => {
  // Client-side errors from body-parser (malformed JSON, payload too large) carry
  // a 4xx status. Return that with a clear, sanitized message instead of a generic
  // 500 — never echo the request body or a stack trace to the client.
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: 'Bad request' });
  }
  console.error('Unhandled:', err);
  res.status(500).json({ error: 'Internal error' });
});

/* ════════════════════════════════════════════════════════════════════
   START
   ════════════════════════════════════════════════════════════════════ */
async function start() {
  await loadDB();
  app.listen(PORT, HOST, () => {
    console.log(`Sola Scholar V1 listening on http://${HOST}:${PORT}`);
    console.log(`Data path: ${DATA_FILE}`);
    console.log(`Auth: ${INTERNAL_PASSWORD ? 'enabled (Basic)' : 'DISABLED — set INTERNAL_PASSWORD'}`);
    const status = Object.fromEntries(Object.keys(SERVICES).map(s => [s, isConfigured(s) ? 'OK' : 'missing']));
    console.log('Services:', status);
  });
}
if (require.main === module) start();

module.exports = {
  app, start, DB, loadDB,
  _internals: {
    findOrCreateCompany,
    findOrCreateManager,
    findOrCreateCandidate,
    createNeed,
    createValidation,
    latestValidation,
    createOrUpdateMatch,
    tierFromScore,
    scoreCandidateAgainstNeed,
    hasReviewEvidence,
    runValidator,
    runMatchmaker,
    runScout,
    runPipeline,
    generateClientReport,
    newPipelineRunId,
    classifySourceItem,
    scoreSourcedPage,
    buildApolloCandidateAttempts,
    buildCandidateSearchExpansion,
    buildRankedTitleVariants,
    buildLocationTiers,
    extractProfileKeywordSignals,
    collectCandidateProfileLinks,
    buildFirecrawlProfileQueries,
    buildFirecrawlBoardQueries,
    githubContributors,
    pickReposForRole,
    pdlPersonSearch,
    pdlProfileLookup,
    pdlProfileResolve,
    openaiParseCandidateItem,
    refineMatchScoresWithOpenAI,
    isPersonLikeSignal,
    pruneScoutStatsByRun,
    SCOUT_STATS_BY_RUN_CAP,
    apolloCandidateSearch,
    expandRoleToTitles,
    normalizeApolloTitles,
    APOLLO_PERSON_TITLES_MAX,
    isLinkedInProfileUrl,
    isUsableGitHubProfileUrl,
    hasUsableProfileLink,
    isVerifiedGitHubProfile,
    isGitLabUserProfileUrl,
    isHuggingFaceProfileUrl,
    isKaggleProfileUrl,
    isStackOverflowUserUrl,
    isCredlyProfileUrl,
    isTryHackMeProfileUrl,
    isHackTheBoxProfileUrl,
    isWellfoundProfileUrl,
    isTrustedCandidateProfileUrl,
    computeIdentityVerification,
    refreshIdentityVerification,
    isFinalShortlistEligible,
    isVisibleMatch,
  },
};
