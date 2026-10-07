/**
 * Set the sign-in passwords (stored as bcrypt hashes).
 *
 *   npm run logins:set                         from ADMIN_PASSWORD / SUPER_ADMIN_PASSWORD / VIEWER_PASSWORD in .env
 *   npm run logins:set -- --role ADMIN         asks for the password (not shown, not stored in plain text)
 *   npm run logins:set -- --role VIEWER        sets a Viewer password (needed before sharing a public link)
 *   npm run logins:set -- --role VIEWER --remove   Viewer back to one click, no password
 *   npm run logins:set -- --status             which roles have a password (prints JSON, no secrets)
 *
 * After it runs, the plain passwords can be removed from .env.
 */
import 'dotenv/config';
import readline from 'node:readline';
import { closeDb } from '../src/db';
import { ensureLoginAccounts, passwordStatus, removeOptionalPassword } from '../src/lib/login';

const LABEL: Record<string, string> = { ADMIN: 'Admin', SUPER_ADMIN: 'Super Admin', VIEWER: 'Viewer' };
const ENV_KEY: Record<string, string> = { ADMIN: 'ADMIN_PASSWORD', SUPER_ADMIN: 'SUPER_ADMIN_PASSWORD', VIEWER: 'VIEWER_PASSWORD' };

function ask(q: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    out._writeToOutput = (s: string) => {
      if (s.includes(q)) out.output.write(s);
    };
    rl.question(q, (a) => {
      rl.close();
      process.stdout.write('\n');
      resolve(a);
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const ri = argv.indexOf('--role');
  if (argv.includes('--status')) {
    console.log(JSON.stringify(await passwordStatus()));
    return;
  }
  const env: Record<string, string | undefined> = { ...process.env };
  if (ri >= 0) {
    const role = (argv[ri + 1] ?? '').toUpperCase().replace('-', '_');
    if (!LABEL[role]) throw new Error('--role must be ADMIN, SUPER_ADMIN or VIEWER');
    if (argv.includes('--remove')) {
      const removed = await removeOptionalPassword(role as 'VIEWER');
      console.log(removed ? `${LABEL[role]} password removed: ${LABEL[role]} signs in with one click again.` : `No ${LABEL[role]} password was set.`);
      return;
    }
    const pw = await ask(`New ${LABEL[role]} password: `);
    if (pw.length < 8) throw new Error('Use at least 8 characters.');
    const again = await ask(`Type the ${LABEL[role]} password again: `);
    if (again !== pw) throw new Error('The two passwords do not match. Nothing was changed.');
    for (const k of Object.values(ENV_KEY)) env[k] = undefined;
    env[ENV_KEY[role]] = pw;
  }
  const done = await ensureLoginAccounts(env);
  console.log(done.length ? `Password set for: ${done.join(', ')}` : 'No change (the passwords already match, or none was given).');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
