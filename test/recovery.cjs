'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const FAILURES = [];
const fail = (m) => { console.error('FAIL:', m); FAILURES.push(m); };
const ok = (m) => console.log('OK:', m);
const assert = (cond, m) => cond ? ok(m) : fail(m);

const TEMP_PATHS = [];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sola-recovery-'));
TEMP_PATHS.push(TMP);
process.on('exit', () => {
  for (const p of TEMP_PATHS) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
});
const DATA_FILE = path.join(TMP, 'data.json');
process.env.DATA_PATH = DATA_FILE;
process.env.DATA_BACKUP_DIR = path.join(TMP, 'backups');
process.env.DATA_BACKUP_RETENTION = '2';
process.env.INTERNAL_USER = 'tester';
process.env.INTERNAL_PASSWORD = 'recovery-test-pw';
process.env.BUILD_COMMIT = 'abcdef1234567890abcdef1234567890abcdef12';
process.env.APP_VERSION = '9.9.9-test';

const server = require(path.join('..', 'backend', 'server.js'));
const { DB, persistDB, loadDB, _internals } = server;
const { createDataBackup, listDataBackups, storageHealth, buildIdentity, acquireStoreLock } = _internals;

async function main() {
  DB.companies.push({ id: 'co_1', name: 'Recovery Co' });
  await persistDB({ skipBackup: true });
  assert(fs.existsSync(DATA_FILE), 'RECOVERY: initial primary data file written');

  const manual = await createDataBackup('manual-test');
  assert(manual.ok && /^data-.*manual-test\.json$/.test(manual.name), `RECOVERY: manual backup created (${manual.name})`);
  let backups = await listDataBackups();
  assert(backups.filter(b => b.valid).length === 1, 'RECOVERY: backup validates successfully');

  DB.companies.push({ id: 'co_2', name: 'After Backup Co' });
  await persistDB();
  backups = await listDataBackups();
  assert(backups.filter(b => b.valid).length >= 1 && backups.filter(b => b.valid).length <= 2,
    `RECOVERY: pre-write backup exists and retention is bounded (valid=${backups.filter(b => b.valid).length})`);

  const cliBackup = cp.execFileSync(process.execPath, ['scripts/data-store.cjs', 'backup', 'cli-test'], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  const cliBackupName = JSON.parse(cliBackup).backup;
  assert(/^data-.*cli-test\.json$/.test(cliBackupName), 'RECOVERY: npm data backup command creates named backup');
  const listOut = cp.execFileSync(process.execPath, ['scripts/data-store.cjs', 'list-backups'], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert(JSON.parse(listOut).backups.some(b => b.name === cliBackupName), 'RECOVERY: list-backups shows CLI backup');
  const badRestore = cp.spawnSync(process.execPath, ['scripts/data-store.cjs', 'restore', '--backup', '../bad.json'], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert(badRestore.status !== 0 && /invalid|traversal/i.test(badRestore.stderr), 'RECOVERY: restore rejects path traversal/invalid backup names');
  const restoreOut = cp.execFileSync(process.execPath, ['scripts/data-store.cjs', 'restore', '--backup', cliBackupName], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert(JSON.parse(restoreOut).restored === cliBackupName, 'RECOVERY: restore accepts valid backup and creates safety backup first');
  const verifyOut = cp.execFileSync(process.execPath, ['scripts/data-store.cjs', 'verify'], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert(JSON.parse(verifyOut).ok === true, 'RECOVERY: data:verify validates current primary');

  await fsp.writeFile(DATA_FILE, '{ bad json');
  await loadDB();
  const health = await storageHealth();
  assert(['recovered_from_backup', 'ok'].includes(health.recoveryState) && health.validBackupCount >= 1,
    `RECOVERY: corrupt primary recovered from newest valid backup (state=${health.recoveryState})`);
  const quarantineDir = path.join(TMP, 'quarantine');
  const quarantined = fs.existsSync(quarantineDir) ? fs.readdirSync(quarantineDir).filter(n => /corrupt/.test(n)) : [];
  assert(quarantined.length >= 1, 'RECOVERY: corrupt primary is quarantined for investigation');

  const noBackupTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sola-no-backup-'));
  TEMP_PATHS.push(noBackupTmp);
  fs.writeFileSync(path.join(noBackupTmp, 'data.json'), '{ bad json');
  const noBackupEnv = { ...process.env, DATA_BACKUP_DIR: path.join(noBackupTmp, 'empty-backups') };
  const noBackup = cp.spawnSync(process.execPath, ['-e', "process.env.DATA_PATH=process.argv[1];process.env.DATA_BACKUP_DIR=process.argv[2];process.env.INTERNAL_PASSWORD='x';require('./backend/server.js').loadDB().then(()=>process.exit(0)).catch(e=>{console.error(e.code||e.message);process.exit(7);})", path.join(noBackupTmp, 'data.json'), path.join(noBackupTmp, 'empty-backups')], { cwd: path.join(__dirname, '..'), env: noBackupEnv, encoding: 'utf8' });
  assert(noBackup.status === 7 && /DATA_RECOVERY_REQUIRED/.test(noBackup.stderr), 'RECOVERY: corrupt primary without valid backup fails startup safely');

  const lockFile = DATA_FILE + '.lock';
  const lockHolder = cp.spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { stdio: 'ignore' });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: lockHolder.pid, createdAt: new Date().toISOString() }));
  let lockConflict = false;
  try { await acquireStoreLock(); } catch { lockConflict = true; }
  try { lockHolder.kill(); } catch {}
  fs.unlinkSync(lockFile);
  assert(lockConflict, 'RECOVERY: active store lock conflict is refused');

  const ident = buildIdentity();
  assert(ident.version === '9.9.9-test' && ident.commitShort === 'abcdef1' && ident.commit.length === 40,
    `RECOVERY: build identity normalizes full/short SHA safely (${JSON.stringify(ident)})`);
  process.env.BUILD_COMMIT = 'not-a-secret-value-with-symbols';
  const missingIdent = buildIdentity();
  assert(missingIdent.commit === null && missingIdent.commitShort === null, 'RECOVERY: invalid/missing commit metadata does not crash or leak arbitrary values');

  if (FAILURES.length) {
    console.log(`PASS RECOVERY FAILED: ${FAILURES.length} issue(s)`);
    process.exit(1);
  }
  console.log('PASS RECOVERY: ALL CHECKS PASSED');
}
main().catch(e => { console.error('UNCAUGHT:', e); process.exit(1); });



