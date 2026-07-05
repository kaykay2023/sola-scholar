#!/usr/bin/env node
'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

try { require('dotenv').config(); } catch {}

const rawPath = process.env.DATA_PATH || path.join(__dirname, '..', 'data');
const dataFile = path.extname(rawPath).toLowerCase() === '.json' ? rawPath : path.join(rawPath, 'data.json');
const dataDir = path.dirname(dataFile);
const backupDir = process.env.DATA_BACKUP_DIR || path.join(dataDir, 'backups');
const retention = Math.max(1, parseInt(process.env.DATA_BACKUP_RETENTION || '20', 10) || 20);
const collections = [
  'companies', 'hiring_managers', 'hiring_needs', 'candidates',
  'candidate_validations', 'matches', 'outreach', 'client_reports',
  'candidate_outcomes', 'agent_learning_summaries', 'activity_logs',
  'resolution_queue', 'pipeline_runs', 'provider_call_ledger',
];

function validateDbShape(parsed) {
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && collections.some(c => Array.isArray(parsed[c]));
}
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function safeName(name) {
  const clean = String(name || '').trim();
  if (!/^data-[a-zA-Z0-9_.-]+\.json$/.test(clean)) throw new Error('backup name is invalid');
  if (clean.includes('..') || clean.includes('/') || clean.includes('\\')) throw new Error('backup path traversal rejected');
  return clean;
}
async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (!validateDbShape(parsed)) throw new Error('invalid data shape');
  return { raw, parsed };
}
async function listBackups() {
  await fsp.mkdir(backupDir, { recursive: true });
  const entries = await fsp.readdir(backupDir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !/^data-.*\.json$/.test(e.name)) continue;
    const full = path.join(backupDir, e.name);
    let valid = false;
    try { await readJson(full); valid = true; } catch {}
    const st = await fsp.stat(full);
    out.push({ name: e.name, valid, createdAt: st.mtime.toISOString(), size: st.size });
  }
  out.sort((a, b) => b.name.localeCompare(a.name));
  return out;
}
async function prune() {
  const valid = (await listBackups()).filter(b => b.valid).slice(retention);
  for (const b of valid) {
    await fsp.unlink(path.join(backupDir, b.name)).catch(() => {});
    await fsp.unlink(path.join(backupDir, b.name + '.meta.json')).catch(() => {});
  }
}
async function backup(reason = 'manual') {
  await fsp.mkdir(backupDir, { recursive: true });
  const { raw, parsed } = await readJson(dataFile);
  const name = `data-${stamp()}-${String(reason).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'manual'}.json`;
  const dest = path.join(backupDir, name);
  await fsp.writeFile(dest + '.tmp', raw);
  await fsp.rename(dest + '.tmp', dest);
  await fsp.writeFile(dest + '.meta.json.tmp', JSON.stringify({ name, reason, createdAt: new Date().toISOString(), collections: collections.filter(c => Array.isArray(parsed[c])).length }, null, 2));
  await fsp.rename(dest + '.meta.json.tmp', dest + '.meta.json');
  await prune();
  return name;
}
async function restore(name) {
  const safe = safeName(name);
  const backupFile = path.join(backupDir, safe);
  const { raw } = await readJson(backupFile);
  await backup('pre-restore');
  const preserved = path.join(dataDir, `data-${stamp()}-pre-restore-current.json`);
  await fsp.copyFile(dataFile, preserved).catch(() => {});
  await fsp.writeFile(dataFile + '.restore.tmp', raw);
  await fsp.rename(dataFile + '.restore.tmp', dataFile);
  return safe;
}
async function verify() {
  await readJson(dataFile);
  const backups = await listBackups();
  return { ok: true, validBackups: backups.filter(b => b.valid).length };
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'backup') {
    const name = await backup(process.argv[3] || 'manual');
    console.log(JSON.stringify({ ok: true, backup: name }));
  } else if (cmd === 'list-backups') {
    console.log(JSON.stringify({ ok: true, backups: await listBackups() }, null, 2));
  } else if (cmd === 'restore') {
    const idx = process.argv.indexOf('--backup');
    if (idx < 0 || !process.argv[idx + 1]) throw new Error('usage: npm run data:restore -- --backup <backup-name>');
    const restored = await restore(process.argv[idx + 1]);
    console.log(JSON.stringify({ ok: true, restored }));
  } else if (cmd === 'verify') {
    console.log(JSON.stringify(await verify()));
  } else {
    console.error('usage: node scripts/data-store.cjs <backup|list-backups|restore|verify>');
    process.exit(2);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
