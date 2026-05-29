/**
 * VERIFICATION PASS 2 — BEHAVIORAL
 *  - Boot server on a random port
 *  - Hit every route with auth → expect 200/201 or sane 4xx for missing body
 *  - Hit /api/health WITHOUT auth → expect 200
 *  - Hit /api/companies WITHOUT auth → expect 401
 *  - Verify response shapes
 *  - Try a partial pipeline (no external keys: Connector etc. should warn but not crash)
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FAILURES = [];
const fail = (m) => { console.error('✗', m); FAILURES.push(m); };
const ok = (m) => console.log('✓', m);

// Use a tmp data dir so smoke test doesn't pollute real data
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sola-smoke-'));
process.env.DATA_PATH = TMP_DATA;
process.env.INTERNAL_USER = 'tester';
process.env.INTERNAL_PASSWORD = 'test-pass-1234';
process.env.PORT = '0'; // ephemeral

// Hermetic: refuse all outbound HTTP. Tests must not depend on network/API keys.
// Returns a 599 (not-ok) for every URL — server's external clients (apollo/
// firecrawl/adzuna/github/hunter/openai/airtable) all already handle non-ok
// responses gracefully and return empty results.
global.fetch = async (url) => ({
  ok: false,
  status: 599,
  json: async () => ({}),
  text: async () => '',
});

const { app, loadDB } = require(path.join('..', 'backend', 'server.js'));

function request(method, urlPath, { body, auth } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://localhost:${PORT}`);
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
    const req = http.request({
      hostname: 'localhost', port: PORT, path: url.pathname + url.search, method, headers,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let data = null; try { data = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, data, raw: buf });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let server, PORT;

async function main() {
  await loadDB();
  await new Promise((resolve) => {
    server = app.listen(0, () => { PORT = server.address().port; resolve(); });
  });
  ok(`Server bound to port ${PORT}`);

  const goodAuth = { user: 'tester', pass: 'test-pass-1234' };
  const badAuth  = { user: 'tester', pass: 'wrong-pass' };

  // /api/health (no auth required, must succeed)
  let r = await request('GET', '/api/health');
  if (r.status !== 200) fail(`/api/health returned ${r.status}`);
  else if (!r.data?.services || typeof r.data.services !== 'object') fail('/api/health missing services');
  else if (r.data.auth !== 'enabled') fail(`/api/health auth field: ${r.data.auth}`);
  else ok(`/api/health → 200, auth=${r.data.auth}, services=${Object.keys(r.data.services).length}`);

  // Verify health does NOT leak any secret values
  const healthRaw = JSON.stringify(r.data);
  if (/[A-Za-z0-9]{30,}/.test(healthRaw.replace(/"version":"[^"]+"/, '').replace(TMP_DATA, ''))) {
    // No long random tokens should appear in health output
    fail('Possibly leaked long token in /api/health output');
  } else ok('/api/health does not leak any token-shaped values');

  // Auth gate — un-authed request to protected route
  r = await request('GET', '/api/companies');
  if (r.status !== 401) fail(`/api/companies without auth → ${r.status} (expected 401)`);
  else ok('Unauthenticated /api/companies → 401');

  // Bad auth
  r = await request('GET', '/api/companies', { auth: badAuth });
  if (r.status !== 401) fail(`/api/companies with bad auth → ${r.status} (expected 401)`);
  else ok('Wrong-password /api/companies → 401');

  // Good auth — all read routes
  const reads = [
    '/api/dashboard/stats', '/api/companies', '/api/hiring-managers',
    '/api/hiring-needs', '/api/candidates', '/api/candidate-validations',
    '/api/matches', '/api/outreach', '/api/client-reports', '/api/activity-logs',
  ];
  for (const p of reads) {
    r = await request('GET', p, { auth: goodAuth });
    if (r.status !== 200) { fail(`${p} → ${r.status}`); continue; }
    if (p === '/api/dashboard/stats') {
      if (typeof r.data !== 'object' || r.data === null) fail(`${p} not an object`);
      else ok(`${p} → 200 (object with ${Object.keys(r.data).length} keys)`);
    } else {
      if (!Array.isArray(r.data)) fail(`${p} not an array`);
      else ok(`${p} → 200 (array, ${r.data.length} items)`);
    }
  }

  // Mutation: create a company
  r = await request('POST', '/api/companies', { auth: goodAuth, body: { name: 'Test Cloud Co', industry: 'Cybersecurity' } });
  if (r.status !== 200 || !r.data?.id) fail(`POST /api/companies → ${r.status}`);
  else ok(`POST /api/companies → ${r.data.id}`);
  const companyId = r.data?.id;

  // Mutation: create a manager (require real email — test that validation fails for fake)
  r = await request('POST', '/api/hiring-managers', { auth: goodAuth, body: { name: 'Test Mgr', companyName: 'Test Cloud Co' } });
  if (r.status !== 400) fail(`POST manager without email → ${r.status} (expected 400)`);
  else ok(`POST manager without email → 400 (refuses fabrication)`);

  // Mutation: create a hiring need
  r = await request('POST', '/api/hiring-needs', { auth: goodAuth, body: { title: 'Cloud Security Engineer', companyName: 'Test Cloud Co', requiredSkills: ['Azure','Sentinel','KQL'], confirmed: true } });
  if (r.status !== 200 || !r.data?.id) fail(`POST hiring need → ${r.status}`);
  else ok(`POST hiring need → ${r.data.id}`);
  const needId = r.data?.id;

  // Patch the need
  if (needId) {
    r = await request('PATCH', '/api/hiring-needs/' + needId, { auth: goodAuth, body: { confirmed: false } });
    if (r.status !== 200 || r.data?.confirmed !== false) fail(`PATCH hiring need → ${r.status}`);
    else ok('PATCH /api/hiring-needs/:id (toggle confirmed) → 200');
  }

  // Run agents — they should respond gracefully even without external keys
  const agentTests = [
    ['POST', '/api/connector/run',     { industry: 'Cloud Security' }, 'returns w/o crash even if Apollo key missing'],
    ['POST', '/api/needs/detect',      { companyId }, 'detects (or warns) without crashing'],
    ['POST', '/api/scout/run',         { needId }, 'requires confirmed; gracefully handles unconfirmed'],
    ['POST', '/api/validator/run',     {}, 'validates whatever pool exists'],
    ['POST', '/api/matchmaker/run',    { needId }, 'scores or warns'],
    ['POST', '/api/outreach/draft',    { managerId: 'fake-id' }, 'errors gracefully on missing manager'],
    ['POST', '/api/client-report/generate', { needId }, 'generates from current data'],
    ['POST', '/api/pipeline/run',      { company: 'Test Pipeline Co', role: 'Test Role', skills: ['Azure'] }, 'one-click pipeline'],
  ];
  for (const [method, p, body, note] of agentTests) {
    r = await request(method, p, { auth: goodAuth, body });
    // Any 2xx or 4xx (with handled error JSON) is acceptable; 500 means we didn't catch
    if (r.status >= 500) fail(`${method} ${p} → ${r.status} (${note})`);
    else ok(`${method} ${p} → ${r.status} (${note})`);
  }

  // 404 on unknown api route
  r = await request('GET', '/api/does-not-exist', { auth: goodAuth });
  if (r.status !== 404) fail(`unknown route → ${r.status} (expected 404)`);
  else ok('unknown /api route → 404');

  // Frontend served from /
  r = await request('GET', '/');
  if (r.status !== 200) fail(`GET / → ${r.status}`);
  else if (!r.raw.includes('Sola Scholar')) fail('GET / does not contain "Sola Scholar"');
  else ok('GET / serves the frontend HTML');

  // Server refuses without INTERNAL_PASSWORD: simulate by hitting a server with empty pw
  // (Already covered by initial Pass 1 — server.js requireAuth refuses if INTERNAL_PASSWORD blank.)

  server.close();
  console.log('\n══════════════════════════════════');
  if (FAILURES.length) {
    console.log(`PASS 2 FAILED: ${FAILURES.length} issue(s)`);
    process.exit(1);
  }
  console.log('PASS 2 (behavioral): ALL CHECKS PASSED');
  console.log('══════════════════════════════════');
}
main().catch(e => { console.error('UNCAUGHT:', e); if (server) server.close(); process.exit(1); });
