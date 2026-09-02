/**
 * Admin bootstrap CLI — the missing first step.
 *
 * `register()` hard-codes `role: 'analyst'` on purpose (01_PRD FR-9.2: nobody self-assigns a
 * privileged role over HTTP), and every route under `/api/v1/admin` — including the one that
 * grants roles — sits behind `rbac('admin')`. Both decisions are right, and together they
 * mean the FIRST admin can never come into existence: granting admin requires an admin.
 *
 * A fresh deployment therefore reaches a state where the admin screens are unreachable by
 * anyone, and the only way out is hand-editing the database. That is the gap this closes.
 *
 * It is a local CLI, not a route. Privilege escalation has to come from something that
 * already proves operator access to the machine and the database — not from anything an
 * unauthenticated caller can reach. There is no HTTP path here by design, and adding one
 * would reintroduce exactly the hole FR-9.2 closes.
 *
 *   pnpm --filter @varuna/api admin:grant -- --email someone@example.org
 *   pnpm --filter @varuna/api admin:grant -- --email someone@example.org --role analyst
 *   pnpm --filter @varuna/api admin:grant -- --email someone@example.org --password 'NewPass!23'
 *   pnpm --filter @varuna/api admin:grant -- --list
 */
import mongoose from 'mongoose';
import { hash as argonHash } from '@node-rs/argon2';
import { ROLES, type Role } from '@varuna/shared';
import { env } from '../../env.js';
import { UserModel } from './model.js';
import { ARGON_OPTS } from './service.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { dbName: env.MONGODB_DB_NAME });

  if (process.argv.includes('--list')) {
    const users = await UserModel.find({}, { email: 1, role: 1, createdAt: 1 })
      .sort({ createdAt: 1 })
      .lean();
    if (users.length === 0) {
      console.log('\nNo users exist yet. Register one in the web app first, then re-run.\n');
    } else {
      console.log(`\n${users.length} user(s):\n`);
      for (const u of users) console.log(`  ${String(u.role).padEnd(8)}  ${u.email}`);
      console.log('');
    }
    await mongoose.disconnect();
    return;
  }

  const email = arg('email')?.trim().toLowerCase();
  if (!email) {
    console.error(
      '\nUsage: admin:grant -- --email <address> [--role admin|analyst|viewer] [--password <new>]\n' +
        '       admin:grant -- --list\n',
    );
    await mongoose.disconnect();
    process.exit(2);
  }

  const role = (arg('role') ?? 'admin') as Role;
  if (!ROLES.includes(role)) {
    console.error(`\n"${role}" is not a role. Valid roles: ${ROLES.join(', ')}\n`);
    await mongoose.disconnect();
    process.exit(2);
  }

  const user = await UserModel.findOne({ email });
  if (!user) {
    // Deliberately NOT creating the account here. A typo in an email address would otherwise
    // silently produce a second, empty admin account rather than telling the operator that
    // the one they meant does not exist.
    console.error(
      `\nNo user with email "${email}". Register through the web app first, then re-run this ` +
        'to grant the role.\n',
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  const before = user.role;
  user.role = role;

  const password = arg('password');
  if (password) {
    if (password.length < 12) {
      console.error('\nRefusing a password under 12 characters.\n');
      await mongoose.disconnect();
      process.exit(2);
    }
    user.passwordHash = await argonHash(password, ARGON_OPTS);
  }

  await user.save();

  console.log(
    `\n  ${email}\n    role      ${before} -> ${user.role}` +
      (password ? '\n    password  reset' : '') +
      '\n\n  Existing sessions keep the OLD role until their access token expires: the role is a ' +
      'claim inside the JWT, not a lookup on every request. Log out and back in.\n',
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
