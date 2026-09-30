/**
 * Project Drawing Status — one-click launcher (the copy of the Design Goals &
 * Delivery Control System with role-based sign-in).
 *
 * Started by START-PROJECT-DRAWING-STATUS.bat. It runs beside the original
 * application: its own folder, database, port (PORT, 3100 by default) and
 * session secret. Everything the launcher does lives here
 * rather than in the batch file, because this is testable and batch is not.
 *
 * What it does, in order:
 *   1. already running?  → just open the browser and stop
 *   2. Node.js version
 *   3. dependencies      → never installs silently; asks once
 *   4. configuration     → .env and DATABASE_URL
 *   5. database          → connects, applies pending migrations ONLY when
 *                          genuinely pending. Never resets. Never imports Excel.
 *   5b. version history  → saves every new version of the application files
 *                          (scripts/versions.mjs) and backs up the database
 *                          before applying database updates
 *   6. build             → builds only when missing or older than the source.
 *                          The last working build is kept aside while a new one
 *                          is prepared; if the new one fails, the last working
 *                          one is put back and started instead
 *   7. start + wait for the server to actually answer, then open the browser
 *
 * It deliberately does NOT: reset the database, delete data, re-import the
 * Excel workbooks, or rebuild on every launch.
 *
 * No path in this file is specific to any machine: the project root is derived
 * from the file's own location.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { currentVersion, lastWorking, saveVersion, updateVersion } from './versions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IS_WINDOWS = process.platform === 'win32';
const APP_NAME = 'PROJECT DRAWING STATUS';

/**
 * The launcher builds and serves from its OWN directory, never `.next`.
 *
 * `next dev` and `next build` cannot share a build directory: starting the dev
 * server deletes the production BUILD_ID and rewrites the compiled server
 * output, which leaves the production server loading chunks that no longer
 * exist ("Cannot find module './372.js'"). Keeping them apart means a
 * developer can run `npm run dev` while the launcher is running, and neither
 * damages the other.
 *
 * next.config.mjs reads this variable, so it applies to both `next build` and
 * `next start` below.
 */
const DIST_NAME = process.env.NEXT_DIST_DIR || '.next-prod';
process.env.NEXT_DIST_DIR = DIST_NAME;
const DIST_DIR = path.resolve(ROOT, DIST_NAME);
/** Written only after a build finishes, so an interrupted build is detectable. */
const BUILD_MARKER = path.join(DIST_DIR, '.launcher-build.json');
/** The last working build, kept while a new one is prepared. */
const PREVIOUS_DIR = path.resolve(ROOT, `${DIST_NAME}-previous`);

process.chdir(ROOT);

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

const DOTS = 30;
let stepOpen = false;

function banner() {
  const line = '='.repeat(44);
  console.log('');
  console.log(line);
  console.log(` ${APP_NAME}`);
  console.log(line);
  console.log('');
}

function step(label) {
  stepOpen = true;
  process.stdout.write(`  ${label} ${'.'.repeat(Math.max(3, DOTS - label.length))} `);
}

function ok(note) {
  if (!stepOpen) return;
  stepOpen = false;
  console.log(note ? `OK   ${note}` : 'OK');
}

/** Close the current step line with a non-OK word, e.g. MISSING. */
function stepResult(word, note) {
  if (!stepOpen) return;
  stepOpen = false;
  console.log(note ? `${word}   ${note}` : word);
}

function say(text = '') {
  if (stepOpen) {
    console.log('');
    stepOpen = false;
  }
  console.log(text);
}

/** Stop with a message a non-technical user can act on. */
function stop(title, lines) {
  if (stepOpen) {
    console.log('FAILED');
    stepOpen = false;
  }
  console.log('');
  console.log('-'.repeat(60));
  console.log(`  ${title}`);
  console.log('-'.repeat(60));
  for (const l of lines) console.log(`  ${l}`);
  console.log('-'.repeat(60));
  console.log('');
  process.exitCode = 1;
  throw new LauncherStop();
}

class LauncherStop extends Error {}

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

// ---------------------------------------------------------------------------
// .env (parsed here, because dotenv may not be installed yet)
// ---------------------------------------------------------------------------

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function redact(url) {
  // Only rewrite what we understand. Parsing a non-postgres value through URL
  // would reshape it and make the error message misleading.
  if (!/^postgres(ql)?:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

async function probeHealth(port, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.sourceOfTruth === 'DATABASE' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort(preferred) {
  for (let p = preferred; p < preferred + 20; p += 1) {
    if (await portIsFree(p)) return p;
  }
  return preferred;
}

function openBrowser(url) {
  try {
    if (IS_WINDOWS) {
      // The empty "" is the window title start.exe expects before the URL.
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Running project commands without depending on the npm shim
// ---------------------------------------------------------------------------

const BIN = {
  next: path.join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'),
  tsx: path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
};

/** Run a project command to completion, showing its output. */
function runNode(args, { label } = {}) {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (res.error) throw new Error(`${label ?? args[0]} could not be started: ${res.error.message}`);
  return res.status ?? 1;
}

function npmCommand() {
  return IS_WINDOWS ? 'npm.cmd' : 'npm';
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function checkNode() {
  step('Checking Node.js');
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major) || major < 20) {
    stop('Node.js is too old', [
      `This application needs Node.js 20 or newer. Found ${process.version}.`,
      '',
      'Please contact IT and ask for the current Node.js LTS runtime.',
    ]);
  }
  ok(`v${process.versions.node}`);
}

const REQUIRED_PACKAGES = ['next', 'react', 'pg', 'drizzle-orm', 'zod', 'xlsx', 'tsx', 'bcryptjs'];

async function checkDependencies() {
  step('Checking dependencies');
  const missing = REQUIRED_PACKAGES.filter(
    (name) => !fs.existsSync(path.join(ROOT, 'node_modules', ...name.split('/'))),
  );
  if (missing.length === 0) {
    ok();
    return;
  }

  // Never install silently on startup: an unattended `npm install` can change
  // versions under the user and takes minutes. Ask once, explicitly.
  stepResult('MISSING');
  say('');
  say(`  ${missing.length} required package(s) are not installed: ${missing.join(', ')}`);
  say('');
  say('  A one-time installation is needed. It downloads the application\'s');
  say('  dependencies from the npm registry and usually takes 1-3 minutes.');
  say('  It does not touch the database and does not change your data.');
  say('');
  const answer = (await ask('  Install them now? [Y/N] ')).toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    stop('Dependencies are not installed', [
      'The application cannot start without them.',
      '',
      'Ask IT to run this once, in this folder:',
      '',
      `    cd "${ROOT}"`,
      '    npm install',
    ]);
  }
  say('');
  say('  Installing. Please wait, and do not close this window...');
  say('');
  const res = spawnSync(npmCommand(), ['install'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: IS_WINDOWS,
  });
  if ((res.status ?? 1) !== 0) {
    stop('Installation failed', [
      'The dependencies could not be installed.',
      'This is usually a network or proxy problem.',
      '',
      'Please send the messages above to IT.',
    ]);
  }
  step('Checking dependencies');
  const stillMissing = REQUIRED_PACKAGES.filter(
    (name) => !fs.existsSync(path.join(ROOT, 'node_modules', ...name.split('/'))),
  );
  if (stillMissing.length) {
    stop('Dependencies are still incomplete', [
      `Missing after installation: ${stillMissing.join(', ')}`,
      'Please send this message to IT.',
    ]);
  }
  ok('installed');
}

function checkConfiguration() {
  step('Checking configuration');
  const envPath = path.join(ROOT, '.env');
  const examplePath = path.join(ROOT, '.env.example');

  if (!fs.existsSync(envPath)) {
    if (fs.existsSync(examplePath)) fs.copyFileSync(examplePath, envPath);
    stop('The application is not configured yet', [
      'A settings file has been created for you:',
      '',
      `    ${envPath}`,
      '',
      'Open it in Notepad and set DATABASE_URL to your PostgreSQL',
      'connection, for example:',
      '',
      '    DATABASE_URL="postgresql://postgres:PASSWORD@localhost:5432/design_control"',
      '',
      'Then start the application again.',
    ]);
  }

  const env = readEnvFile(envPath);
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  // Sign-in: every session cookie is signed with SESSION_SECRET. One is made
  // for this copy on its first start (never shared with the original app).
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    const secret = crypto.randomBytes(36).toString('base64url');
    fs.appendFileSync(envPath, `${fs.readFileSync(envPath, 'utf8').endsWith('\n') ? '' : '\n'}# Signs the sign-in cookies of this copy. Made by the launcher; keep it private.\nSESSION_SECRET=${secret}\n`);
    process.env.SESSION_SECRET = secret;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    stop('No database connection is configured', [
      'DATABASE_URL is not set in:',
      `    ${envPath}`,
      '',
      'Set it to your PostgreSQL connection and start again.',
    ]);
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    stop('The database setting is not a PostgreSQL connection', [
      `DATABASE_URL is currently: ${redact(url)}`,
      '',
      'This application uses PostgreSQL. The setting should look like:',
      '    DATABASE_URL="postgresql://postgres:PASSWORD@localhost:5432/design_control"',
      '',
      `Edit ${envPath} and start again.`,
    ]);
  }
  if (/REPLACE_WITH_YOUR_PASSWORD/i.test(url)) {
    stop('The database password has not been set', [
      `DATABASE_URL in ${envPath} still contains the placeholder`,
      'REPLACE_WITH_YOUR_PASSWORD.',
      '',
      'Replace it with the password for your PostgreSQL "postgres" user,',
      'then start the application again.',
    ]);
  }
  ok(redact(url));
}

/**
 * Connect, and apply migrations only when the migration journal actually has
 * entries the database has not recorded. The database is never reset here, and
 * the Excel workbooks are never re-imported — that stays an administrative
 * command (`npm run migrate:excel`).
 */
async function checkDatabase() {
  step('Checking database');
  let pg;
  try {
    pg = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'pg', 'lib', 'index.js')).href);
  } catch {
    pg = await import('pg');
  }
  const Client = pg.default?.Client ?? pg.Client;

  const url = process.env.DATABASE_URL;
  const target = new URL(url);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });

  try {
    await client.connect();
  } catch (err) {
    const code = err && err.code;
    const host = `${target.hostname}:${target.port || 5432}`;
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      stop('The database server is not reachable', [
        `Could not reach PostgreSQL at ${host}.`,
        '',
        'Most likely the PostgreSQL service is not running.',
        'On Windows: press Start, type "Services", find',
        '"postgresql-x64-..." and make sure it is Running.',
        '',
        'If the database is on a company server, check the network',
        'and that the address in .env is correct.',
      ]);
    }
    if (code === '28P01' || code === '28000') {
      stop('The database password is wrong', [
        `PostgreSQL at ${host} refused the user "${decodeURIComponent(target.username)}".`,
        '',
        'Check the password in the .env file in this folder,',
        'then start the application again.',
      ]);
    }
    if (code === '3D000' && process.env.CLONE_FROM_DATABASE_URL) {
      await client.end().catch(() => {});
      cloneDatabase(url, process.env.CLONE_FROM_DATABASE_URL);
      return checkDatabase();
    }
    if (code === '3D000') {
      stop('The database does not exist yet', [
        `PostgreSQL at ${host} has no database called`,
        `"${decodeURIComponent(target.pathname.replace(/^\//, ''))}".`,
        '',
        'Ask IT to run this once, in this folder:',
        '',
        `    cd "${ROOT}"`,
        '    npm run db:setup',
      ]);
    }
    stop('The database could not be opened', [
      `PostgreSQL at ${host} reported:`,
      `    ${err && err.message ? err.message : String(err)}`,
      '',
      'Please send this message to IT.',
    ]);
  }

  let needsSetup = false;
  let detail = '';
  try {
    const tables = await client.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const names = tables.rows.map((r) => r.table_name);

    if (!names.includes('projects')) {
      needsSetup = true;
      detail = 'first run - creating tables';
    } else {
      // Pending migrations: journal entries the database has not recorded.
      const journalPath = path.join(ROOT, 'drizzle', 'meta', '_journal.json');
      if (fs.existsSync(journalPath)) {
        const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        const expected = (journal.entries ?? []).map((e) => Number(e.when));
        let applied = [];
        try {
          const rows = await client.query('select created_at from drizzle.__drizzle_migrations');
          applied = rows.rows.map((r) => Number(r.created_at));
        } catch {
          applied = [];
        }
        const pending = expected.filter((w) => !applied.includes(w));
        if (pending.length > 0) {
          needsSetup = true;
          detail = `applying ${pending.length} database update(s)`;
        }
      }
    }

    if (!needsSetup) {
      const counts = await client.query(
        `select (select count(*)::int from projects) as projects,
                (select count(*)::int from goals) as goals`,
      );
      const { projects, goals } = counts.rows[0];
      detail =
        projects === 0
          ? 'empty - no projects imported yet'
          : `${projects} projects, ${goals.toLocaleString()} goals`;
    }
  } finally {
    await client.end().catch(() => {});
  }

  if (needsSetup) {
    ok(detail);
    say('');
    say(`  Preparing the database (${detail}). This runs once.`);
    say('');
    if (!/first run/.test(detail)) backupBeforeUpdate(currentVersionSafe());
    backedUpThisRun = true;
    const code = runNode([BIN.tsx, path.join('scripts', 'db-setup.ts')], { label: 'db:setup' });
    if (code !== 0) {
      stop('The database could not be prepared', [
        'The setup step reported an error above.',
        '',
        'Nothing was deleted. Please send the messages above to IT.',
      ]);
    }
    say('');
    step('Checking database');
    // Re-read after setup: a freshly created database has no projects yet, and
    // that is precisely when the user needs to be told about the Excel import.
    const after = new Client({ connectionString: url, connectionTimeoutMillis: 8000 });
    let projects = 0;
    try {
      await after.connect();
      const res = await after.query('select count(*)::int as n from projects');
      projects = res.rows[0].n;
    } catch {
      projects = 0;
    } finally {
      await after.end().catch(() => {});
    }
    ok(projects === 0 ? 'ready - no projects imported yet' : `ready - ${projects} projects`);
    return { empty: projects === 0 };
  }

  ok(detail);
  return { empty: detail.startsWith('empty') };
}

/**
 * Newest modification time under the paths that affect a production build.
 * Cheap: a few hundred files, milliseconds.
 */
function newestSourceTime() {
  const roots = ['src', 'public', 'drizzle'].map((d) => path.join(ROOT, d));
  const files = [
    'package.json',
    'next.config.mjs',
    'tailwind.config.ts',
    'postcss.config.mjs',
    'tsconfig.json',
  ].map((f) => path.join(ROOT, f));
  let newest = 0;
  const visit = (p) => {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      let entries = [];
      try {
        entries = fs.readdirSync(p);
      } catch {
        return;
      }
      for (const e of entries) visit(path.join(p, e));
    } else if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  };
  for (const r of roots) visit(r);
  for (const f of files) visit(f);
  return newest;
}

/**
 * Build only when there is no usable production build, or when the source has
 * changed since the last one. Never on every launch.
 *
 * The decision uses a marker file written *after* the build completes, so a
 * build that was interrupted (the window was closed) is treated as missing
 * rather than trusted.
 */
function buildState() {
  const buildId = path.join(DIST_DIR, 'BUILD_ID');
  if (!fs.existsSync(buildId)) return { needed: true, reason: 'first run - preparing the application' };
  if (!fs.existsSync(BUILD_MARKER)) {
    return { needed: true, reason: 'the last preparation did not finish' };
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(BUILD_MARKER, 'utf8'));
  } catch {
    return { needed: true, reason: 'the last preparation did not finish' };
  }
  if (Number(marker.sourceNewest) < newestSourceTime()) {
    return { needed: true, reason: 'the application was updated' };
  }
  return { needed: false };
}

function cleanBuild() {
  try {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
  } catch {
    /* a locked file here is not fatal; the build overwrites anyway */
  }
}

function usableBuild(dir) {
  return fs.existsSync(path.join(dir, 'BUILD_ID')) && fs.existsSync(path.join(dir, '.launcher-build.json'));
}

function moveDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Prepare (build) the application when needed. The last working build is
 * moved aside first; if the new build fails it is put back, and the result
 * says so, so the launcher can start the last working version instead of
 * leaving the user with nothing.
 */
function checkBuild({ force = false } = {}) {
  step('Checking application');
  const state = force ? { needed: true, reason: 'rebuilding the application' } : buildState();

  if (!state.needed) {
    ok('up to date');
    return { built: false, fallback: false };
  }

  ok('needs preparing');
  say('');
  say(`  ${state.reason}. This takes a minute or two and happens only once.`);
  say('  Please do not close this window.');
  say('');

  const kept = usableBuild(DIST_DIR);
  if (kept) moveDir(DIST_DIR, PREVIOUS_DIR);

  // Record the source time BEFORE building, so an edit made during the build
  // is not mistaken for "already built".
  const sourceNewest = newestSourceTime();
  const code = runNode([BIN.next, 'build'], { label: 'next build' });
  say('');
  if (code !== 0 || !fs.existsSync(path.join(DIST_DIR, 'BUILD_ID'))) {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    if (usableBuild(PREVIOUS_DIR)) {
      moveDir(PREVIOUS_DIR, DIST_DIR);
      say('-'.repeat(60));
      say('  The new version could not be prepared (the reason is shown above).');
      say('  The last version that worked is started instead, so you can');
      say('  keep working. Your data has not been touched.');
      say('');
      say('  To put the application files back to that version as well,');
      say('  close this window and double-click ROLLBACK.bat.');
      say('  Please send the messages above to IT.');
      say('-'.repeat(60));
      say('');
      return { built: false, fallback: true };
    }
    stop('The application could not be prepared', [
      'The preparation step reported an error above.',
      '',
      'Your data has not been touched.',
      'To go back to the last version that worked, double-click ROLLBACK.bat.',
      'Please send the messages above to IT.',
    ]);
  }
  fs.writeFileSync(
    BUILD_MARKER,
    JSON.stringify({ completedAt: new Date().toISOString(), sourceNewest }, null, 2),
  );
  step('Checking application');
  ok('ready');
  return { built: true, fallback: false };
}

/**
 * Version history: save the application files as a version when they have
 * changed. Never stops the launcher; a problem here is reported and skipped.
 */
function currentVersionSafe() {
  try {
    return currentVersion();
  } catch {
    return null;
  }
}

function checkVersion() {
  step('Checking version');
  try {
    const { version, created } = saveVersion({ note: 'application files received', status: 'new' });
    ok(created ? `new version saved (${version.id})` : `${version.id}`);
    return version;
  } catch (e) {
    ok(`history not saved: ${e && e.message ? e.message : e}`);
    return null;
  }
}

let backedUpThisRun = false;

/**
 * One-time data repairs (scripts/data-repair.ts): corrections of data an
 * earlier version imported wrongly. Backed up first; a repair that fails
 * leaves the data as it was (each import is one transaction) and the
 * application still starts.
 */
function checkDataRepairs(version) {
  step('Checking data');
  const check = spawnSync(process.execPath, [BIN.tsx, path.join('scripts', 'data-repair.ts'), '--check'], { cwd: ROOT, env: process.env, encoding: 'utf8' });
  const out = `${check.stdout ?? ''}`.trim();
  if (check.status !== 0 || !out.startsWith('PENDING')) {
    ok(check.status === 0 ? 'up to date' : 'not checked');
    return;
  }
  ok('corrections to apply');
  say('');
  say('  Correcting data imported by an earlier version (project names and');
  say('  hierarchy, "Updated On" dates, drawing numbers). This runs once.');
  say('');
  if (!backedUpThisRun) backupBeforeUpdate(version);
  backedUpThisRun = true;
  const code = runNode([BIN.tsx, path.join('scripts', 'data-repair.ts')], { label: 'data:repair' });
  say('');
  if (code !== 0) {
    say('  Some corrections could not be applied (see above). Nothing was');
    say('  half-written; the application starts with the data as it was.');
    say('  Please send the messages above to IT.');
    say('');
  }
}

/**
 * PG_BIN_DIR when .env leaves it empty: the newest PostgreSQL under Program
 * Files (Windows), so backups and the first-start clone find pg_dump.
 */
function detectPgBin() {
  if (process.env.PG_BIN_DIR || !IS_WINDOWS) return;
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map((r) => path.join(r, 'PostgreSQL'));
  for (const root of roots) {
    let versions = [];
    try {
      versions = fs.readdirSync(root).filter((v) => fs.existsSync(path.join(root, v, 'bin', 'pg_dump.exe')));
    } catch {
      continue;
    }
    versions.sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a));
    if (versions.length) {
      process.env.PG_BIN_DIR = path.join(root, versions[0], 'bin');
      return;
    }
  }
}

/**
 * First start of the copy: its own database, cloned from the original one
 * (CLONE_FROM_DATABASE_URL) with pg_dump / pg_restore. The original database
 * is only read.
 */
function cloneDatabase(targetUrl, sourceUrl) {
  step('Creating the database of this copy');
  const bin = (name) => {
    const dir = process.env.PG_BIN_DIR;
    const exe = IS_WINDOWS ? `${name}.exe` : name;
    return dir ? path.join(dir, exe) : exe;
  };
  const target = new URL(targetUrl);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  const admin = new URL(targetUrl);
  admin.pathname = '/postgres';
  const dumpFile = path.join(ROOT, 'backups', `clone-source-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
  fs.mkdirSync(path.dirname(dumpFile), { recursive: true });
  const run = (exe, args, label) => {
    const r = spawnSync(bin(exe), args, { encoding: 'utf8', env: process.env });
    if (r.error || r.status !== 0) {
      stop(`The database of this copy could not be created (${label})`, [
        (r.error?.message ?? r.stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' ') || 'Unknown error',
        '',
        'Check PG_BIN_DIR and CLONE_FROM_DATABASE_URL in .env.',
        'The original database was only read and is unchanged.',
      ]);
    }
    return r;
  };
  run('pg_dump', ['--format=custom', '--no-owner', `--file=${dumpFile}`, sourceUrl], 'copying the original');
  run('psql', [admin.toString(), '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${dbName.replace(/"/g, '')}"`], 'creating it');
  run('pg_restore', ['--no-owner', `--dbname=${targetUrl}`, dumpFile], 'restoring the copy');
  ok(`${dbName} (cloned)`);
}

/** Admin and Super Admin passwords from .env, stored as hashes (idempotent). */
function checkLogins() {
  if (!process.env.ADMIN_PASSWORD && !process.env.SUPER_ADMIN_PASSWORD) return;
  step('Checking sign-in');
  const res = spawnSync(process.execPath, [BIN.tsx, path.join('scripts', 'logins-set.ts')], { cwd: ROOT, env: process.env, encoding: 'utf8' });
  ok(res.status === 0 ? 'passwords stored as hashes' : 'not checked');
}

/** Back up the database before database updates are applied, and note it on the version. */
function backupBeforeUpdate(version) {
  say('  Backing up the database before updating it...');
  const res = spawnSync(process.execPath, [BIN.tsx, path.join('scripts', 'backup.ts'), 'before-update'], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const m = /Created\s*:\s*(.+\.dump)/.exec(out);
  if (res.status === 0 && m) {
    const file = path.basename(m[1].trim());
    say(`  Saved ${file}`);
    if (version) {
      try {
        updateVersion(version.id, { databaseBackupBefore: file });
      } catch {
        /* the backup itself exists; only the note is missing */
      }
    }
  } else {
    say('  The database could not be backed up first (see below). The update');
    say('  only adds to the database, so it continues; set PG_BIN_DIR in .env');
    say('  so that backups work.');
    for (const l of out.trim().split(/\r?\n/).slice(-4)) say(`    ${l}`);
  }
  say('');
}

async function startServer(port, { allowRetry = false } = {}) {
  step('Starting server');
  const child = spawn(process.execPath, [BIN.next, 'start', '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  const capture = (buf) => {
    serverOutput += buf.toString();
    if (serverOutput.length > 8000) serverOutput = serverOutput.slice(-8000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  // Wait until the server actually answers, rather than guessing with a delay.
  const deadline = Date.now() + 120_000;
  let health = null;
  while (Date.now() < deadline) {
    if (exited) break;
    health = await probeHealth(port, 1200);
    if (health) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  if (!health) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    // A damaged build directory shows up here: missing chunks, or no BUILD_ID.
    // Rather than hand a non-technical user a webpack stack trace, rebuild once.
    if (allowRetry) {
      stepResult('FAILED');
      return { ok: false, output: serverOutput };
    }
    stop('The application did not start', [
      exited ? `The server stopped unexpectedly (code ${exitCode}).` : 'The server did not respond in time.',
      '',
      serverOutput.trim() ? 'It reported:' : 'It produced no output.',
      ...serverOutput.trim().split(/\r?\n/).slice(-12).map((l) => `    ${l}`),
      '',
      'Please send this message to IT.',
    ]);
  }

  ok();
  return { ok: true, child, health };
}

function shutdown(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (IS_WINDOWS) {
      // next start spawns workers; kill the whole tree.
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* nothing more we can do */
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  banner();

  const env = readEnvFile(path.join(ROOT, '.env'));
  const preferredPort = Number(process.env.PORT || env.PORT || 3100) || 3100;

  // If it is already running, do not start a second copy.
  const already = await probeHealth(preferredPort, 1200);
  if (already) {
    const url = `http://localhost:${preferredPort}`;
    say('  The application is already running.');
    say('');
    say(`  Opening ${url}`);
    openBrowser(url);
    say('');
    say('  You can close this window. The application keeps running in its');
    say('  own window.');
    say('');
    return;
  }

  say('Starting application...');
  say('');

  checkNode();
  await checkDependencies();
  checkConfiguration();
  detectPgBin();
  const version = checkVersion();
  const db = await checkDatabase();
  if (!db.empty) checkDataRepairs(version);
  checkLogins();

  let child;
  let health;
  let port = preferredPort;

  let fallback = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const b = checkBuild({ force: attempt === 2 && !fallback });
    fallback = fallback || b.fallback;

    port = await findFreePort(preferredPort);
    if (port !== preferredPort) {
      say('');
      say(`  Note: port ${preferredPort} is in use by another program,`);
      say(`  so this application will use port ${port} instead.`);
      say('');
    }

    const result = await startServer(port, { allowRetry: attempt === 1 });
    if (result.ok) {
      child = result.child;
      health = result.health;
      break;
    }

    // First attempt failed. The overwhelmingly common cause is a damaged or
    // half-written build directory, so clear it and prepare the application
    // once more before giving up.
    say('');
    say('  The application files look damaged. Repairing them now.');
    say('  This happens once and does not affect your data.');
    say('');
    cleanBuild();
  }

  const url = `http://localhost:${port}`;

  // Record how this version did, for ROLLBACK.bat.
  try {
    if (version) {
      if (fallback) {
        updateVersion(version.id, { status: 'failed', failedAt: new Date().toISOString() });
      } else {
        updateVersion(version.id, { status: 'working', workingAt: new Date().toISOString() });
      }
    }
  } catch {
    /* history is best effort */
  }
  const running = fallback ? lastWorking(version?.id) : version;

  say('');
  say('='.repeat(44));
  say('  The application is running.');
  say('');
  say(`  Address : ${url}`);
  say(`  Database: ${health.projects} projects`);
  if (running) say(`  Version : ${running.id}${fallback ? ' (the last version that worked)' : ''}`);
  say('='.repeat(44));
  say('');

  if (db.empty) {
    say('  Note: the database has no projects yet. To load the Excel');
    say('  workbooks, an administrator runs this once, in this folder:');
    say('');
    say('      npm run migrate:excel');
    say('');
  }

  say('  Opening your web browser...');
  openBrowser(url);
  say('');
  say('  KEEP THIS WINDOW OPEN while you use the application.');
  say('  Closing this window stops the application.');
  say('');

  const stopAll = () => {
    say('');
    say('  Stopping the application...');
    shutdown(child);
    process.exit(0);
  };
  process.on('SIGINT', stopAll);
  process.on('SIGTERM', stopAll);
  process.on('SIGHUP', stopAll);

  await new Promise((resolve) => {
    child.on('exit', (code) => {
      say('');
      say(`  The application has stopped (code ${code}).`);
      resolve();
    });
  });
}

main().catch((err) => {
  if (err instanceof LauncherStop) {
    process.exitCode = process.exitCode || 1;
    return;
  }
  console.log('');
  console.log('-'.repeat(60));
  console.log('  The application could not be started');
  console.log('-'.repeat(60));
  console.log(`  ${err && err.message ? err.message : String(err)}`);
  console.log('');
  console.log('  Please send this message to IT.');
  console.log('-'.repeat(60));
  console.log('');
  process.exitCode = 1;
});
