/**
 * Personal sign-in from the command line (lib/members/setup).
 *
 *   npm run members:invite -- --email <email> --name "<name>" --account-admin
 *   npm run members:invite -- --email <email> --name "<name>" --project <project id or code> [--project-admin]
 *        Adds the member (Invited) and prints a one-time invite link (72 hours, single use).
 *   npm run members:migrate
 *        The first Account Admin from INITIAL_ACCOUNT_ADMIN_EMAIL (and INITIAL_ACCOUNT_ADMIN_NAME) in .env,
 *        and the Responsible Persons as Invited members with Member access on their projects.
 *   npm run members:invite -- --bootstrap
 *        (the launcher) the first Account Admin from .env, only when no Account Admin exists yet.
 *
 * No password is set or printed here: each person sets their own from the link.
 */
import 'dotenv/config';
import { eq, or } from 'drizzle-orm';
import { closeDb, db } from '../src/db';
import { projects } from '../src/db/schema';
import { hasAccountAdmin, inviteFromCommandLine, migrateResponsible } from '../src/lib/members/setup';

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function nameFromEmail(email: string) {
  return email
    .split('@')[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

async function initialAdmin(onlyIfNone: boolean) {
  const email = process.env.INITIAL_ACCOUNT_ADMIN_EMAIL?.trim();
  if (!email) {
    console.log('INITIAL_ACCOUNT_ADMIN_EMAIL is not set in .env: no Account Admin was created.');
    return;
  }
  if (onlyIfNone && (await hasAccountAdmin())) {
    console.log('An Account Admin already exists.');
    return;
  }
  const name = process.env.INITIAL_ACCOUNT_ADMIN_NAME?.trim() || nameFromEmail(email);
  const r = await inviteFromCommandLine({ email, name, accountAdmin: true });
  if (r.invite) {
    console.log(`Account Admin ${email}: open this link once to set the password (valid until ${r.invite.expiresAt}):`);
    console.log(`  ${r.invite.link}`);
  } else console.log(`Account Admin ${email} already has a password.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0]?.startsWith('--') ? 'invite' : argv[0];
  if (command === 'migrate') {
    await initialAdmin(false);
    const r = await migrateResponsible();
    console.log(`Responsible Persons: ${r.created} added as Invited members, ${r.existing} already members, ${r.grants} project access entries.`);
    if (r.placeholders) console.log(`${r.placeholders} of them have an address the importer made up (…@….local): correct the email in Settings → Members before sending the link.`);
    return;
  }
  if (argv.includes('--bootstrap')) return initialAdmin(true);
  const email = arg(argv, '--email');
  const name = arg(argv, '--name');
  if (!email || !name) throw new Error('Give --email and --name (and --account-admin, or --project <id or code>).');
  const accountAdmin = argv.includes('--account-admin');
  const projectRef = arg(argv, '--project');
  if (!accountAdmin && !projectRef) throw new Error('Give --account-admin, or --project <id or code>.');
  let projectId: string | null = null;
  if (projectRef) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(or(eq(projects.id, projectRef), eq(projects.projectCode, projectRef))).limit(1);
    if (!p) throw new Error(`No project "${projectRef}".`);
    projectId = p.id;
  }
  const r = await inviteFromCommandLine({ email, name, accountAdmin, projectId, projectAdmin: argv.includes('--project-admin') });
  if (r.invite) {
    console.log(`${r.created ? 'Added' : 'Updated'} ${email}. One-time invite link (valid until ${r.invite.expiresAt}):`);
    console.log(`  ${r.invite.link}`);
  } else console.log(`${email} already has a password: access updated, no link needed.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
