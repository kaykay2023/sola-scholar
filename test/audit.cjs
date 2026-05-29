/**
 * VERIFICATION PASS 3 — MANUAL AUDIT
 * Static code review for the bug categories I missed last time.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FAILURES = [];
const fail = (m) => { console.error('FAIL:', m); FAILURES.push(m); };
const ok = (m) => console.log('OK:', m);

const html = fs.readFileSync(path.join(__dirname, '..', 'backend', 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');

// 1. Components defined inside other components (focus-loss anti-pattern)
const innerComponentMatches = [];
const lines = html.split('\n');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  // Indented "const SomeCapitalized = (...) => (" inside a function body
  const m = line.match(/^( {2,}|\t+)const ([A-Z][A-Za-z0-9]+) = \(\{[^}]*\}\) =>/);
  if (m) {
    innerComponentMatches.push('line ' + (i+1) + ': ' + m[2] + ' (inside function body)');
  }
}
if (innerComponentMatches.length) {
  for (const x of innerComponentMatches) fail('Inner component: ' + x);
} else {
  ok('No components defined inside other components');
}

// 2. Dead-code stubs
if (/if\(!confirm\)\s*\{\s*\}/.test(html)) fail('Frontend has "if(!confirm){ }" dead stub');
else ok('No "if(!confirm){ }" dead stub');

if (/\bdebugger\b/.test(html)) fail('"debugger" statement in frontend');
else ok('No "debugger" statements');

const consoleLogs = (html.match(/console\.log\(/g) || []).length;
const consoleErrors = (html.match(/console\.error\(/g) || []).length;
if (consoleLogs > 0) fail('Frontend has ' + consoleLogs + ' console.log() calls');
else ok('No console.log in frontend (' + consoleErrors + ' console.error are intentional)');

// 3. Missing key={} in .map()s rendering JSX
//    Find the FIRST '<' AFTER the arrow, then look for 'key={' between that '<' and its matching '>'.
const mapRe = /\.map\(\s*\([a-zA-Z, ]+\)\s*=>\s*\n?\s*<([a-zA-Z][a-zA-Z0-9]*)/g;
let mapHits = 0;
const noKeyHits = [];
let m;
while ((m = mapRe.exec(html)) !== null) {
  mapHits++;
  // The captured tag '<TagName' starts at m.index + m[0].length - (m[1].length + 1)  -- the '<'
  const tagStart = m.index + m[0].length - m[1].length - 1; // position of '<'
  // Find matching '>' for the opening tag (account for nested generics in attrs etc — simple search is enough for JSX)
  const tagEnd = html.indexOf('>', tagStart);
  if (tagEnd < 0) continue;
  const openingTag = html.slice(tagStart, tagEnd + 1);
  if (!/key=\{/.test(openingTag)) {
    noKeyHits.push('map of <' + m[1] + '> at offset ' + m.index);
  }
}
if (noKeyHits.length) {
  for (const h of noKeyHits) fail('Missing key=: ' + h);
} else {
  ok('All ' + mapHits + ' .map() iterables include key={}');
}

// 4. Backend: backend secrets never logged
const backendLogs = server.match(/console\.(log|error|warn)\([^)]+\)/g) || [];
let leakedLogs = 0;
for (const l of backendLogs) {
  if (/process\.env\.\w+_(KEY|TOKEN|PAT|SECRET)/.test(l)) {
    fail('Backend log may print a secret: ' + l);
    leakedLogs++;
  }
}
if (!leakedLogs) ok('Backend logs never reference env-var key/token/pat values');

// 5. Auth uses constant-time compare
if (!/timingSafeEqual/.test(server)) fail('Auth check missing timingSafeEqual');
else ok('Auth uses crypto.timingSafeEqual');

// 6. Server refuses /api/* without INTERNAL_PASSWORD
if (!/Server misconfigured.*INTERNAL_PASSWORD/.test(server)) fail('Server should refuse /api/* when INTERNAL_PASSWORD blank');
else ok('Server refuses /api/* when INTERNAL_PASSWORD blank');

// 7. Atomic writes to data.json
if (!/\.tmp/.test(server) || !/rename/.test(server)) fail('persistDB should use atomic .tmp + rename');
else ok('persistDB uses atomic .tmp + rename');

// 8. ErrorBoundary at root
if (!/<ErrorBoundary>/.test(html) || !/class ErrorBoundary/.test(html)) fail('Missing ErrorBoundary wrapper');
else ok('ErrorBoundary wraps the app');

// 9. Frontend has no API key references and calls only /api/*
const forbidden = [
  'KEY_FIELDS',
  'getKeys()',
  "localStorage.setItem('ss_",
  "localStorage.getItem('ss_",
  'api.firecrawl.dev',
  'api.apollo.io',
  'api.airtable.com',
  'api.openai.com',
  'api.hunter.io',
  'api.adzuna.com',
  'api.github.com',
];
let leaked = 0;
for (const f of forbidden) {
  if (html.includes(f)) { fail('Frontend still contains: ' + f); leaked++; }
}
if (!leaked) ok('Frontend has no key store, no localStorage key store, no external API hosts');

// 10. Branding text
const brand = 'In-house AI recruiting intelligence for cybersecurity and cloud hiring';
if (!html.includes(brand)) fail('Brand text missing');
else ok('Brand text present');

// 11. Async backend handlers wrap external calls in try/catch
//     Scan from each "app.post('/api/<route>'" forward until the matching "});" — handle nested () inside.
const agentHandlers = ['/api/connector/run', '/api/needs/detect', '/api/scout/run', '/api/validator/run', '/api/matchmaker/run', '/api/outreach/draft', '/api/client-report/generate', '/api/pipeline/run'];
let trycatchOK = 0;
for (const route of agentHandlers) {
  const startMarker = "app.post('" + route + "'";
  const start = server.indexOf(startMarker);
  if (start < 0) { fail('Could not locate handler for ' + route); continue; }
  // Walk forward until matching '});' at the same nesting level.
  let i = server.indexOf('=>', start);
  if (i < 0) { fail('Could not parse handler for ' + route); continue; }
  // Find the opening { after =>
  const braceOpen = server.indexOf('{', i);
  if (braceOpen < 0) { fail('No body for handler ' + route); continue; }
  let depth = 1, j = braceOpen + 1;
  while (j < server.length && depth > 0) {
    const c = server[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    j++;
  }
  const block = server.slice(start, j);
  if (!/try\s*\{/.test(block) || !/catch\s*\(/.test(block)) {
    fail('Agent handler missing try/catch: ' + route);
  } else {
    trycatchOK++;
  }
}
if (trycatchOK === agentHandlers.length) ok(trycatchOK + '/' + agentHandlers.length + ' agent handlers use try/catch');
else fail(trycatchOK + '/' + agentHandlers.length + ' agent handlers use try/catch (some missing)');

// 12. Only one ReactDOM.createRoot
const renders = (html.match(/ReactDOM\.createRoot\(/g) || []).length;
if (renders !== 1) fail('Expected exactly 1 ReactDOM.createRoot, found ' + renders);
else ok('Exactly 1 ReactDOM.createRoot');

console.log('');
console.log('==================================');
if (FAILURES.length) {
  console.log('PASS 3 FAILED: ' + FAILURES.length + ' issue(s)');
  process.exit(1);
}
console.log('PASS 3 (manual audit): ALL CHECKS PASSED');
console.log('==================================');
