/**
 * Set the Admin and Super Admin passwords (stored as bcrypt hashes).
 *
 *   npm run logins:set                         from ADMIN_PASSWORD / SUPER_ADMIN_PASSWORD in .env
 *   npm run logins:set -- --role ADMIN         asks for the password (not shown, not stored in plain text)
 *
 * After it runs, the plain passwords can be removed from .env.
 */
import 'dotenv/config';
import readline from 'node:readline';
import { closeDb } from '../src/db';
import { ensureLoginAccounts } from '../src/lib/login';

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
  const env: Record<string, string | undefined> = { ...process.env };
  if (ri >= 0) {
    const role = (argv[ri + 1] ?? '').toUpperCase().replace('-', '_');
    if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') throw new Error('--role must be ADMIN or SUPER_ADMIN');
    const pw = await ask(`New ${role === 'ADMIN' ? 'Admin' : 'Super Admin'} password: `);
    if (pw.length < 8) throw new Error('Use at least 8 characters.');
    env.ADMIN_PASSWORD = role === 'ADMIN' ? pw : undefined;
    env.SUPER_ADMIN_PASSWORD = role === 'SUPER_ADMIN' ? pw : undefined;
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
