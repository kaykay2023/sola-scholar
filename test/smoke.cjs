/**
 * VERIFICATION PASS 1 — STATIC
 *  - Backend syntax: require() the server (without starting it)
 *  - Frontend JSX: Babel transform
 *  - Route enumeration: list all routes the server registers; cross-check spec
 *  - Schema check: collections referenced match the spec
 *  - Secret scan
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FAILURES = [];
const fail = (m) => { console.error('✗', m); FAILURES.push(m); };
const ok = (m) => console.log('✓', m);

// 1. Backend syntax
let serverModule;
try {
  // Stub listen to avoid binding a port
  const real = require('http').Server.prototype.listen;
  require('http').Server.prototype.listen = function(){ this.close && this.close(); return this; };
  process.env.INTERNAL_PASSWORD = process.env.INTERNAL_PASSWORD || 'smoke-test-pw';
  serverModule = require('../backend/server.js');
  require('http').Server.prototype.listen = real;
  ok('backend/server.js loaded without syntax error');
} catch (e) {
  fail(`server.js syntax: ${e.message}`);
  process.exit(1);
}

// 2. Frontend Babel
const html = fs.readFileSync(path.join(__dirname, '..', 'backend', 'public', 'index.html'), 'utf8');
const startIdx = html.indexOf('<script type="text/babel">');
const endIdx = html.indexOf('</script>', startIdx);
if (startIdx < 0 || endIdx < 0) fail('No babel script in index.html');
else {
  const code = html.slice(startIdx + 26, endIdx);
  let babel;
  try { babel = require('@babel/core'); } catch {
    try { require('child_process').execSync('npm install --no-save --silent @babel/core @babel/preset-react @babel/preset-env', { cwd: path.join(__dirname, '..'), stdio: 'pipe' }); babel = require('@babel/core'); }
    catch (e) { fail(`Could not install babel for test: ${e.message}`); }
  }
  if (babel) {
    try {
      babel.transformSync(code, {
        filename: 'index.html.jsx',
        presets: [
          ['@babel/preset-env', { targets: '> 0.5%, last 2 versions, not dead' }],
          ['@babel/preset-react', { runtime: 'classic' }],
        ],
        babelrc: false, configFile: false,
      });
      ok(`frontend JSX transforms (${code.length} bytes)`);
    } catch (e) {
      fail(`frontend JSX transform: ${e.message}`);
    }
  }
}

// 3. Route enumeration vs spec
const SPEC = [
  ['GET',    '/api/health'],
  ['GET',    '/api/dashboard/stats'],
  ['GET',    '/api/companies'],
  ['GET',    '/api/hiring-managers'],
  ['GET',    '/api/hiring-needs'],
  ['GET',    '/api/candidates'],
  ['GET',    '/api/matches'],
  ['GET',    '/api/outreach'],
  ['GET',    '/api/activity-logs'],
  ['POST',   '/api/connector/run'],
  ['POST',   '/api/needs/detect'],
  ['POST',   '/api/scout/run'],
  ['POST',   '/api/validator/run'],
  ['POST',   '/api/matchmaker/run'],
  ['POST',   '/api/outreach/draft'],
  ['POST',   '/api/client-report/generate'],
  ['POST',   '/api/pipeline/run'],
];

const app = serverModule.app;
const stack = app._router.stack;
const registered = [];
for (const layer of stack) {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).map(m=>m.toUpperCase());
    for (const m of methods) registered.push([m, layer.route.path]);
  }
}
const reg = new Set(registered.map(([m,p]) => `${m} ${p}`));
const missing = SPEC.filter(([m,p]) => !reg.has(`${m} ${p}`));
if (missing.length) fail(`Missing routes: ${missing.map(([m,p])=>m+' '+p).join(', ')}`);
else ok(`All ${SPEC.length} required routes registered`);
console.log(`  (server registers ${registered.length} routes total, including extras)`);

// 4. Collections check
const expectedCollections = ['companies','hiring_managers','hiring_needs','candidates','candidate_validations','matches','outreach','client_reports','activity_logs'];
const dbKeys = Object.keys(serverModule.DB);
const missingCols = expectedCollections.filter(c => !dbKeys.includes(c));
if (missingCols.length) fail(`Missing DB collections: ${missingCols.join(', ')}`);
else ok(`All 9 collections present in DB`);

// 5. Secret scan
const filesToScan = [
  'backend/server.js',
  'backend/public/index.html',
  'package.json',
  'README.md',
  '.env.example',
];
const secretPatterns = [
  { name: 'Firecrawl key', re: /fc-[A-Za-z0-9]{20,}/ },
  { name: 'Airtable PAT',   re: /pat[A-Z][A-Za-z0-9]{14,}/ },
  { name: 'OpenAI key',     re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'Bearer token',   re: /Bearer\s+[A-Za-z0-9_\-\.]{30,}/ },
  { name: 'API key value',  re: /api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i },
];
let leaks = 0;
for (const f of filesToScan) {
  const p = path.join(__dirname, '..', f);
  if (!fs.existsSync(p)) continue;
  const c = fs.readFileSync(p, 'utf8');
  for (const { name, re } of secretPatterns) {
    if (re.test(c)) { fail(`Possible ${name} in ${f}`); leaks++; }
  }
}
if (!leaks) ok('No hardcoded secrets in committed files');

// 5b. Frontend Candidates tab: status separation must be present
const candidatesStatusMarkers = [
  'decisionFilter',
  'decisionOf',
  'decisionBadge',
  '✅ Accepted',
  '🟡 Review',
  '🔴 Rejected',
  'NOT the final shortlist',
];
let candidatesStatusOk = true;
for (const marker of candidatesStatusMarkers) {
  if (!html.includes(marker)) { fail(`Candidates tab status marker missing: "${marker}"`); candidatesStatusOk = false; }
}
if (candidatesStatusOk) ok('Candidates tab includes scoutDecision status separation markers');

// 6. Frontend → keys check (must NOT reference any env-var-style key directly)
const frontendCode = html;
const frontendBadPatterns = [
  /process\.env/, // process.env in frontend would be wrong (it's not bundled)
  /APOLLO_API_KEY|FIRECRAWL_API_KEY|GITHUB_TOKEN|HUNTER_API_KEY|AIRTABLE_PAT|OPENAI_API_KEY/,
  /api\.apollo\.io|api\.firecrawl\.dev|api\.hunter\.io|api\.airtable\.com|api\.openai\.com|api\.adzuna\.com/,  // direct external API hosts
];
let frontendLeaks = 0;
for (const re of frontendBadPatterns) {
  if (re.test(frontendCode)) { fail(`Frontend references something it shouldn't: ${re}`); frontendLeaks++; }
}
if (!frontendLeaks) ok('Frontend never references env vars or external API hosts');

// Done
console.log('\n══════════════════════════════════');
if (FAILURES.length) {
  console.log(`PASS 1 FAILED: ${FAILURES.length} issue(s)`);
  process.exit(1);
}
console.log('PASS 1 (static): ALL CHECKS PASSED');
console.log('══════════════════════════════════');
