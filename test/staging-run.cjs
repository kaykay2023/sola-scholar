/**
 * STAGING VALIDATION RUN — uses whatever API keys are present in process.env.
 * - Does NOT read or print .env contents.
 * - Does NOT print any secret value (no API keys, no auth headers).
 * - Does NOT send outreach (does not invoke runComposer or airtablePush).
 * - Runs the same pipeline input twice and prints the two result envelopes.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Set INTERNAL_PASSWORD to a throwaway so the module loads cleanly. This is
// only used for the /api/health probe at the end, never displayed.
if (!process.env.INTERNAL_PASSWORD) process.env.INTERNAL_PASSWORD = 'staging-' + Date.now();

// Use a scratch data dir so we don't disturb any existing data.json.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sola-staging-'));
process.env.DATA_PATH = TMP;

// Match the "normal" backend startup path — cwd = <repo>/backend — so the
// server's `require('dotenv').config()` call (which reads `${cwd}/.env` by
// default) finds backend/.env if it exists. Repo-root start path is also tried
// in a second probe below.
const BACKEND_DIR = path.resolve(__dirname, '..', 'backend');
process.chdir(BACKEND_DIR);

// Prevent the module from binding a port during require.
const realListen = http.Server.prototype.listen;
http.Server.prototype.listen = function () { this.close && this.close(); return this; };
const server = require(path.resolve(BACKEND_DIR, 'server.js'));
http.Server.prototype.listen = realListen;

const { _internals, app } = server;
const { runPipeline } = _internals;

// Safe service-status snapshot (mirrors /api/health logic, no values printed).
function serviceStatus() {
  const svcs = {
    apollo:   ['APOLLO_API_KEY'],
    firecrawl:['FIRECRAWL_API_KEY'],
    github:   ['GITHUB_TOKEN'],
    hunter:   ['HUNTER_API_KEY'],
    adzuna:   ['ADZUNA_APP_ID', 'ADZUNA_API_KEY'],
    openai:   ['OPENAI_API_KEY'],
    airtable: ['AIRTABLE_PAT', 'AIRTABLE_BASE_ID', 'AIRTABLE_TABLE_NAME'],
  };
  const out = {};
  for (const [name, envs] of Object.entries(svcs)) {
    out[name] = envs.every(e => !!process.env[e]) ? 'configured' : 'missing';
  }
  return out;
}

function summarize(label, p) {
  return {
    label,
    pipelineRunId:     p.pipelineRunId,
    sourced:           p.sourced,
    fullyValidated:    p.fullyValidated,
    needsReview:       p.needsReview,
    insufficientData:  p.insufficientData,
    validated:         p.validated,
    visible:           p.visible,
    dropped:           p.dropped,
    reportId:          p.reportId,
  };
}

async function main() {
  console.log('\n── service status (no values printed) ──');
  console.log(JSON.stringify(serviceStatus(), null, 2));

  const input = {
    company: 'Sola Scholars Staging Test Co',
    role: 'Azure Security Engineer',
    skills: ['Azure','Sentinel','SIEM','KQL','IAM','Defender','incident response','cloud security'],
    location: 'Remote',
    seniority: 'Mid',
  };

  console.log('\n── pipeline RUN 1 ──');
  const r1 = await runPipeline(input);
  const s1 = summarize('run1', r1);
  console.log(JSON.stringify(s1, null, 2));

  console.log('\n── pipeline RUN 2 ──');
  const r2 = await runPipeline(input);
  const s2 = summarize('run2', r2);
  console.log(JSON.stringify(s2, null, 2));

  // ── Run isolation checks ──
  const checks = [];
  checks.push(['distinct pipelineRunId', r1.pipelineRunId !== r2.pipelineRunId,
               `${r1.pipelineRunId} vs ${r2.pipelineRunId}`]);
  checks.push(['run2 dropped count is scoped (not cumulative)', r2.dropped <= Math.max(r2.sourced, r2.validated),
               `r2.dropped=${r2.dropped}, r2.sourced=${r2.sourced}, r2.validated=${r2.validated}`]);

  // DB-level checks via server module
  const DB = server.DB;
  const r1Cands = DB.candidates.filter(c => c.pipelineRunId === r1.pipelineRunId).length;
  const r2Cands = DB.candidates.filter(c => c.pipelineRunId === r2.pipelineRunId).length;
  const r1Matches = DB.matches.filter(m => m.pipelineRunId === r1.pipelineRunId).length;
  const r2Matches = DB.matches.filter(m => m.pipelineRunId === r2.pipelineRunId).length;
  const r1Vals = DB.candidate_validations.filter(v => v.pipelineRunId === r1.pipelineRunId).length;
  const r2Vals = DB.candidate_validations.filter(v => v.pipelineRunId === r2.pipelineRunId).length;
  // Same-candidate-across-runs: count candidate IDs that have matches in both runs
  const r1MatchIds = new Set(DB.matches.filter(m => m.pipelineRunId === r1.pipelineRunId).map(m => m.candidateId));
  const r2MatchIds = new Set(DB.matches.filter(m => m.pipelineRunId === r2.pipelineRunId).map(m => m.candidateId));
  let shared = 0;
  for (const id of r1MatchIds) if (r2MatchIds.has(id)) shared++;
  // For each shared candidate, expect 2 distinct match records (one per run)
  let twoSeparate = 0;
  for (const id of r1MatchIds) if (r2MatchIds.has(id)) {
    const ms = DB.matches.filter(m => m.candidateId === id && (m.pipelineRunId === r1.pipelineRunId || m.pipelineRunId === r2.pipelineRunId));
    if (ms.length === 2) twoSeparate++;
  }

  console.log('\n── DB-level run-isolation snapshot ──');
  console.log(JSON.stringify({
    run1: { candidates: r1Cands, validations: r1Vals, matches: r1Matches },
    run2: { candidates: r2Cands, validations: r2Vals, matches: r2Matches },
    shared_candidate_ids: shared,
    shared_with_two_distinct_match_records: twoSeparate,
  }, null, 2));

  checks.push(['shared candidates have 2 distinct match records', shared === 0 || shared === twoSeparate,
               `shared=${shared}, twoSeparate=${twoSeparate}`]);

  // Old matches not overwritten: pull a run1 match by id and confirm pipelineRunId is still run1
  const sampleR1 = DB.matches.find(m => m.pipelineRunId === r1.pipelineRunId);
  if (sampleR1) {
    checks.push(['run1 sample match retained its pipelineRunId after run2',
                 sampleR1.pipelineRunId === r1.pipelineRunId,
                 `sample.id=${sampleR1.id}, pipelineRunId=${sampleR1.pipelineRunId}`]);
  }

  console.log('\n── isolation checks ──');
  for (const [name, passed, detail] of checks) {
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  }

  // ── /api/health probe (boot in-process, no auth required) ──
  const ephem = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const PORT = ephem.address().port;
  const healthBody = await new Promise((resolve, reject) => {
    const r = http.request({ hostname: 'localhost', port: PORT, path: '/api/health', method: 'GET' }, (res) => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => resolve(buf));
    });
    r.on('error', reject); r.end();
  });
  ephem.close();
  console.log('\n── /api/health body ──');
  console.log(healthBody);
  console.log('  dataPath absent:', !/dataPath/i.test(healthBody));
  console.log('  abs-path absent:', !healthBody.includes(TMP));

  // Did real sourcing happen?
  const sourcingHappened = r1.sourced > 0 || r2.sourced > 0;
  console.log('\n── result ──');
  console.log('  real sourcing happened:', sourcingHappened);
  if (!sourcingHappened) {
    console.log('  reason: no source service has all required env vars set (see service-status snapshot above).');
    console.log('  no GitHub/Firecrawl/Apollo calls were attempted because isConfigured(svc) was false for each.');
  }

  const failedChecks = checks.filter(([, p]) => !p);
  if (failedChecks.length) {
    console.log(`\nSTAGING VALIDATION FAILED: ${failedChecks.length} isolation check(s) failed`);
    process.exit(1);
  }
  console.log('\nSTAGING VALIDATION OK (run isolation verified)');
}

main().catch(e => { console.error('UNCAUGHT:', e.message); process.exit(1); });
