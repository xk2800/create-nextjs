// `create-nextjs upgrade [version]` — run inside an app scaffolded from the
// template. Bumps @xk2800/nextjs-template, generates a migration if the
// template's schema changed, offers to apply it, and type-checks the app so
// breaking changes show up straight away.
//
// Same env switches as scaffolding: CREATE_NEXTJS_TAG picks the npm dist-tag
// (`create-nextjs-beta upgrade` → beta), CREATE_NEXTJS_LOCAL installs a packed
// local template working copy (`create-nextjs-beta-local upgrade`) so
// unpublished template changes can be tried in a real app before releasing.
import * as p from '@clack/prompts';
import { execa } from 'execa';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const TEMPLATE_PKG = '@xk2800/nextjs-template';
const TEMPLATE_TAG = process.env.CREATE_NEXTJS_TAG || 'latest';
const LOCAL = process.env.CREATE_NEXTJS_LOCAL;
const LOCAL_TGZ = 'nextjs-template-local.tgz';

const cwd = process.cwd();
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const pkgPath = join(cwd, 'package.json');
const pkg = existsSync(pkgPath) ? readJson(pkgPath) : null;
const spec = pkg?.dependencies?.[TEMPLATE_PKG];
if (!spec) {
  p.cancel(`No ${TEMPLATE_PKG} dependency in ${pkgPath}. Run this from your app's root folder.`);
  process.exit(1);
}

const installedPath = join(cwd, 'node_modules', TEMPLATE_PKG, 'package.json');
const current = existsSync(installedPath) ? readJson(installedPath).version : spec;

let target;
if (LOCAL) {
  target = readJson(join(LOCAL, 'package.json')).version;
} else if (process.argv[3]) {
  target = process.argv[3].replace(/^v/, '');
} else {
  try {
    const res = await fetch(`https://registry.npmjs.org/${TEMPLATE_PKG}/${TEMPLATE_TAG}`);
    if (!res.ok) throw new Error(`registry responded ${res.status}`);
    target = (await res.json()).version;
  } catch (err) {
    p.cancel(`Could not look up ${TEMPLATE_PKG} on npm: ${err.message}`);
    process.exit(1);
  }
}

if (!LOCAL && target === current) {
  p.outro(`Already on ${TEMPLATE_PKG}@${current}.`);
  process.exit(0);
}

const go = await p.confirm({
  message: `Upgrade ${TEMPLATE_PKG} ${current} → ${LOCAL ? `local working copy (${target}, ${LOCAL})` : target}?`,
});
if (p.isCancel(go) || !go) { p.cancel('Cancelled'); process.exit(0); }

const s = p.spinner();

// --- install ---
if (LOCAL) {
  s.start('Building local template package');
  await execa('bun', ['run', 'build:lib'], { cwd: LOCAL });
  await execa('bun', ['pm', 'pack', '--filename', join(cwd, LOCAL_TGZ)], { cwd: LOCAL });
  s.stop('Built');
}
s.start('Installing');
// Keep the app's existing range style: ^/~ stay, an exact pin stays exact.
const prefix = spec.match(/^[\^~]/)?.[0] ?? '';
const addArgs = LOCAL
  ? ['add', `${TEMPLATE_PKG}@file:./${LOCAL_TGZ}`]
  : ['add', `${TEMPLATE_PKG}@${prefix}${target}`, ...(prefix ? [] : ['--exact'])];
const install = await execa('bun', addArgs, { cwd, reject: false });
if (install.exitCode !== 0) {
  s.stop('Install failed');
  p.cancel(install.stderr || install.stdout);
  process.exit(1);
}
s.stop(`Installed ${TEMPLATE_PKG}@${target}`);

// --- migrations ---
// `generate` only diffs the schema against the migrations folder; no DB needed.
const drizzleConfig = ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs'].find((f) => existsSync(join(cwd, f)));
let newMigrations = [];
if (drizzleConfig) {
  const outDir = join(cwd, readFileSync(join(cwd, drizzleConfig), 'utf-8').match(/out:\s*["'`](.+?)["'`]/)?.[1] ?? './drizzle');
  const sqlFiles = () => (existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.sql')) : []);
  const before = new Set(sqlFiles());
  s.start('Checking for schema changes');
  const gen = await execa('bunx', ['drizzle-kit', 'generate'], { cwd, reject: false });
  newMigrations = sqlFiles().filter((f) => !before.has(f));
  if (gen.exitCode !== 0) {
    s.stop('drizzle-kit generate failed');
    p.log.error(gen.stderr || gen.stdout);
  } else {
    s.stop(newMigrations.length ? `New migration: ${newMigrations.join(', ')}` : 'No schema changes');
  }

  // Applying touches a real database, so it's opt-in and uses the app's own script.
  const migrateScript = ['migrate:dev', 'db:migrate', 'migrate'].find((name) => pkg.scripts?.[name]);
  if (newMigrations.length && migrateScript) {
    const apply = await p.confirm({ message: `Apply it now with \`bun run ${migrateScript}\`?`, initialValue: false });
    if (!p.isCancel(apply) && apply) {
      const migrate = await execa('bun', ['run', migrateScript], { cwd, stdio: 'inherit', reject: false });
      if (migrate.exitCode !== 0) p.log.error('Migration failed. Fix the error above, then run it again.');
    }
  }
}

// --- type-check ---
s.start('Type-checking');
const tsc = pkg.scripts?.typecheck
  ? await execa('bun', ['run', 'typecheck'], { cwd, reject: false })
  : await execa('bunx', ['tsc', '--noEmit'], { cwd, reject: false });
if (tsc.exitCode === 0) {
  s.stop('No type errors');
} else {
  s.stop('Type errors after the upgrade');
  p.log.warn((tsc.stdout || tsc.stderr).split('\n').slice(0, 30).join('\n'));
}

const notes = [];
if (newMigrations.length) notes.push(`Commit the new migration: ${newMigrations.join(', ')}`);
if (tsc.exitCode !== 0) notes.push('Fix the type errors above — the template API changed');
if (LOCAL) notes.push(`Don't commit ${LOCAL_TGZ} or the file: dependency — run \`create-nextjs upgrade\` again once the template is published`);
notes.push('What changed: https://github.com/xk2800/nextjs-template/releases');
p.note(notes.join('\n'), 'Next steps');
p.outro('Upgrade done');
