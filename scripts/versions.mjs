/**
 * Version history — every version of the application that reaches this
 * computer is kept, and any earlier one can be put back.
 *
 * Plain Node.js, no extra software (git is not needed on this computer).
 * Stored in the `.versions` folder of the application:
 *
 *   .versions/objects/ab/cdef…   each file's content once (gzip), by SHA-256
 *   .versions/history.json      the versions, newest last
 *   .versions/versions/<id>.json one version: its files and their hashes
 *
 * A file that did not change between versions is stored only once, so the
 * history stays small.
 *
 *   node scripts/versions.mjs list
 *   node scripts/versions.mjs save "note"
 *   node scripts/versions.mjs rollback            (asks which version)
 *   node scripts/versions.mjs rollback <id> [--with-database]
 *
 * ROLLBACK.bat runs the rollback with questions. The launcher saves a version
 * whenever the application files change, and marks it "working" once it has
 * started successfully.
 *
 * Never versioned: .env (passwords), node_modules, build output, backups,
 * import reports, and .versions itself. The database is not in the history;
 * the launcher takes a database backup before it applies database updates,
 * and a rollback can restore that backup too.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = path.join(ROOT, '.versions');
const OBJECTS = path.join(STORE, 'objects');
const MANIFESTS = path.join(STORE, 'versions');
const HISTORY = path.join(STORE, 'history.json');

/** Folders and files that are not part of a version. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.versions', 'backups', 'import-reports', '_to_delete', 'out']);
const SKIP_DIR_PREFIX = ['.next'];
const SKIP_FILES = new Set(['.env', '.env.local', 'tsconfig.tsbuildinfo', 'Thumbs.db', '.DS_Store']);
const SKIP_PATHS = [/^data\/test-/, /^data\/[^/]*\.db(-wal|-shm)?$/];
/** The rollback tool itself is never taken away by a rollback. */
const KEEP = new Set(['scripts/versions.mjs', 'ROLLBACK.bat']);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function trackedFiles() {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || SKIP_DIR_PREFIX.some((p) => e.name.startsWith(p))) continue;
        walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (SKIP_FILES.has(e.name) || SKIP_PATHS.some((re) => re.test(r))) continue;
        out.push(r);
      }
    }
  };
  walk(ROOT, '');
  return out.sort();
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const objectPath = (h) => path.join(OBJECTS, h.slice(0, 2), h.slice(2));

function storeObject(h, buf) {
  const p = objectPath(h);
  if (fs.existsSync(p)) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(buf));
  fs.renameSync(tmp, p);
}

function readObject(h) {
  return zlib.gunzipSync(fs.readFileSync(objectPath(h)));
}

/** path → sha256 of the files on disk now. */
function currentState() {
  const files = {};
  for (const f of trackedFiles()) {
    const buf = fs.readFileSync(path.join(ROOT, f));
    files[f] = { hash: sha(buf), buf };
  }
  return files;
}

const fingerprint = (files) => sha(Buffer.from(Object.entries(files).map(([f, h]) => `${h}  ${f}`).join('\n')));

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY, 'utf8'));
  } catch {
    return [];
  }
}

function writeHistory(list) {
  fs.mkdirSync(STORE, { recursive: true });
  const tmp = `${HISTORY}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, HISTORY);
}

function readManifest(id) {
  return JSON.parse(fs.readFileSync(path.join(MANIFESTS, `${id}.json`), 'utf8'));
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `v${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function appVersionLabel() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Save the files on disk as a version, unless they are exactly the latest
 * version already. Returns the version (new or existing).
 */
export function saveVersion({ note = '', status = 'saved' } = {}) {
  const state = currentState();
  const files = Object.fromEntries(Object.entries(state).map(([f, v]) => [f, v.hash]));
  const fp = fingerprint(files);
  const history = readHistory();
  const same = [...history].reverse().find((v) => v.fingerprint === fp);
  if (same && history[history.length - 1]?.fingerprint === fp) return { version: same, created: false };
  for (const v of Object.values(state)) storeObject(v.hash, v.buf);
  const id = newId();
  const version = { id, savedAt: new Date().toISOString(), note, status, fingerprint: fp, files: Object.keys(files).length, appVersion: appVersionLabel(), sameAs: same?.id ?? null };
  fs.mkdirSync(MANIFESTS, { recursive: true });
  fs.writeFileSync(path.join(MANIFESTS, `${id}.json`), JSON.stringify({ ...version, fileHashes: files }, null, 2));
  writeHistory([...history, version]);
  return { version, created: true };
}

/** Record something about a version: status (working / failed …), a database backup, a note. */
export function updateVersion(id, patch) {
  const history = readHistory();
  const i = history.findIndex((v) => v.id === id);
  if (i < 0) return null;
  history[i] = { ...history[i], ...patch };
  writeHistory(history);
  const m = readManifest(id);
  fs.writeFileSync(path.join(MANIFESTS, `${id}.json`), JSON.stringify({ ...m, ...patch }, null, 2));
  return history[i];
}

/** The version whose files are on disk now, if any. */
export function currentVersion() {
  const files = Object.fromEntries(trackedFiles().map((f) => [f, sha(fs.readFileSync(path.join(ROOT, f)))]));
  const fp = fingerprint(files);
  return [...readHistory()].reverse().find((v) => v.fingerprint === fp) ?? null;
}

export function lastWorking(beforeId) {
  const h = readHistory();
  const end = beforeId ? h.findIndex((v) => v.id === beforeId) : h.length;
  return [...h.slice(0, end < 0 ? h.length : end)].reverse().find((v) => v.status === 'working') ?? null;
}

/**
 * Put the files of a version back. The files on disk now are saved first
 * (as "before rollback"), so a rollback can itself be undone.
 */
export function restoreFiles(id) {
  const target = readManifest(id);
  const { version: safety } = saveVersion({ note: `before rolling back to ${id}`, status: 'before-rollback' });
  const now = trackedFiles();
  let written = 0;
  let removed = 0;
  for (const [f, h] of Object.entries(target.fileHashes)) {
    if (KEEP.has(f)) continue;
    const p = path.join(ROOT, f);
    if (fs.existsSync(p) && sha(fs.readFileSync(p)) === h) continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, readObject(h));
    written += 1;
  }
  for (const f of now) {
    if (f in target.fileHashes || KEEP.has(f)) continue;
    fs.rmSync(path.join(ROOT, f), { force: true });
    removed += 1;
  }
  // The compiled application belongs to the other version: prepare it again on the next start.
  for (const d of ['.next-prod', '.next-prod-candidate']) fs.rmSync(path.join(ROOT, d, '.launcher-build.json'), { force: true });
  return { written, removed, safety };
}

/** The database backup taken just before the version after `id` changed the database. */
export function databaseBackupFor(id) {
  const h = readHistory();
  const i = h.findIndex((v) => v.id === id);
  for (const v of h.slice(i + 1)) if (v.databaseBackupBefore) return v.databaseBackupBefore;
  return null;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function ask(q) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => (rl.close(), resolve(a.trim()))));
}

const STATUS = { working: 'worked', failed: 'failed to prepare', saved: 'saved', new: 'received', 'before-rollback': 'before a rollback' };

function printList(list, current) {
  if (!list.length) {
    console.log('  No versions saved yet.');
    return;
  }
  list.forEach((v, i) => {
    const when = new Date(v.savedAt).toLocaleString();
    const mark = current && v.id === current.id ? '  <- on disk now' : '';
    console.log(`  ${String(list.length - i).padStart(3)}. ${v.id}  ${when.padEnd(22)}  ${(STATUS[v.status] ?? v.status).padEnd(18)} ${v.note ?? ''}${mark}`);
  });
}

async function main() {
  const [cmd = 'list', ...rest] = process.argv.slice(2);
  const history = readHistory();
  const newestFirst = [...history].reverse();

  if (cmd === 'list') {
    console.log('');
    console.log('  Versions of the application on this computer (newest first):');
    console.log('');
    printList(newestFirst, currentVersion());
    console.log('');
    return;
  }

  if (cmd === 'save') {
    const { version, created } = saveVersion({ note: rest.join(' ') || 'saved by hand' });
    console.log(created ? `  Saved ${version.id} (${version.files} files).` : `  Nothing changed since ${version.id}.`);
    return;
  }

  if (cmd === 'mark') {
    const [id, status] = rest;
    console.log(updateVersion(id, { status }) ? `  ${id}: ${status}` : `  No version ${id}.`);
    return;
  }

  if (cmd === 'rollback') {
    const withDb = rest.includes('--with-database');
    let id = rest.find((a) => !a.startsWith('--'));
    const current = currentVersion();
    console.log('');
    console.log('  ROLL BACK TO AN EARLIER VERSION');
    console.log('');
    if (!history.length) {
      console.log('  No versions have been saved on this computer yet, so there is nothing to go back to.');
      process.exitCode = 1;
      return;
    }
    if (!id) {
      printList(newestFirst, current);
      const suggestion = lastWorking(current?.id) ?? newestFirst.find((v) => v.id !== current?.id);
      console.log('');
      const a = await ask(`  Number of the version to go back to${suggestion ? ` [Enter = ${newestFirst.length - newestFirst.indexOf(suggestion)}, the last version that worked]` : ''}: `);
      const n = a ? Number(a) : suggestion ? newestFirst.length - newestFirst.indexOf(suggestion) : NaN;
      const pick = newestFirst[newestFirst.length - n];
      if (!pick) {
        console.log('  No version chosen. Nothing was changed.');
        return;
      }
      id = pick.id;
    }
    if (id === 'last-working') id = lastWorking(current?.id)?.id;
    const target = history.find((v) => v.id === id);
    if (!target) {
      console.log(`  There is no version ${id}. Nothing was changed.`);
      process.exitCode = 1;
      return;
    }
    const backup = databaseBackupFor(target.id);
    let restoreDb = withDb;
    if (!withDb && backup && process.stdin.isTTY) {
      console.log('');
      console.log('  A database backup from just before the later updates exists:');
      console.log(`      ${backup}`);
      console.log('  Restoring it undoes every change made in the application since then.');
      restoreDb = /^y(es)?$/i.test(await ask('  Also restore the database? (yes / no) [no]: '));
    }
    const confirm = process.stdin.isTTY ? await ask(`  Go back to ${target.id}${restoreDb ? ' and restore the database' : ''}? (yes / no): `) : 'yes';
    if (!/^y(es)?$/i.test(confirm)) {
      console.log('  Nothing was changed.');
      return;
    }
    const r = restoreFiles(target.id);
    console.log('');
    console.log(`  Files put back: ${r.written} changed, ${r.removed} removed.`);
    console.log(`  The version you had before is kept as ${r.safety.id}, so this can be undone the same way.`);
    if (restoreDb) {
      if (!backup) console.log('  No database backup was recorded for that version; the database was not changed.');
      else {
        const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
        const res = spawnSync(process.execPath, [tsx, path.join('scripts', 'restore.ts'), backup], { cwd: ROOT, stdio: 'inherit' });
        console.log(res.status === 0 ? '  Database restored.' : '  The database could not be restored; the messages above say why. The files were rolled back.');
      }
    }
    console.log('');
    console.log('  Start the application again with START-PROJECT-DRAWING-STATUS.bat.');
    console.log('');
    return;
  }

  console.log('  Commands: list · save "note" · rollback [version] [--with-database] · mark <version> <status>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`  ${e?.message ?? e}`);
    process.exitCode = 1;
  });
}
