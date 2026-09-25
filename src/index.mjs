#!/usr/bin/env node
import * as p from '@clack/prompts';
import { execa } from 'execa';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Override for local testing: CREATE_NEXTJS_REPO=/path/to/local/clone
const REPO = process.env.CREATE_NEXTJS_REPO || 'https://github.com/xk2800/nextjs-template.git';

// Harmless artifacts (a stray .git from `git init`, editor/OS cruft) that
// shouldn't block scaffolding into "." — same allowlist create-vite uses.
const IGNORE_FILES = new Set(['.git', '.DS_Store', '.gitignore', '.gitattributes', '.idea', '.vscode', 'Thumbs.db']);

// Some template files import via the template's own package name
// (`@xk2800/nextjs-template/...`), relying on Node's self-reference
// resolution through package.json's `exports` map. That breaks the moment
// pkg.name is changed below — and there's no `dist/` build in a scaffold for
// it to resolve to anyway. Map each subpath to its real source file (from
// tsup.config.ts's entry list) and rewrite imports to the @/* alias instead.
// Sorted longest-key-first so e.g. "auth/helpers" is matched before "auth".
const SELF_IMPORT_MAP = Object.entries({
  'auth/helpers': 'lib/auth-helpers',
  auth: 'server/auth',
  'auth-client': 'lib/auth-client',
  'db/schema': 'server/db/schema',
  db: 'server/db',
  'config/env': 'config/env',
  'types/auth/loginSchema': 'types/auth/loginSchema',
  'types/auth/signupSchema': 'types/auth/signupSchema',
  'activity/logger': 'lib/activity-logger',
  'activity/queries': 'lib/activity-queries',
  'sessions/queries': 'lib/session-queries',
  'admin/queries': 'lib/admin-queries',
  'users/queries': 'lib/user-queries',
  'settings/queries': 'lib/settings-queries',
  'lib/utils': 'lib/utils',
  'lib/formatters': 'lib/formatters',
}).sort((a, b) => b[0].length - a[0].length);

function rewriteSelfImports(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.next', 'dist'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { rewriteSelfImports(full); continue; }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    const original = readFileSync(full, 'utf-8');
    let content = original;
    for (const [from, to] of SELF_IMPORT_MAP) content = content.replaceAll(`@xk2800/nextjs-template/${from}`, `@/${to}`);
    content = content.replaceAll('@xk2800/nextjs-template/components/', '@/components/');
    if (content !== original) writeFileSync(full, content);
  }
}

const ownPkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const ownPkg = JSON.parse(readFileSync(ownPkgPath, 'utf-8'));

p.intro('@xk2800/create-nextjs');

// npx/bunx can hand you a stale cached copy of this CLI — offer to re-run
// with the real latest instead of silently scaffolding with old code.
try {
  const res = await fetch(`https://registry.npmjs.org/${ownPkg.name}/latest`);
  if (res.ok) {
    const { version: latest } = await res.json();
    if (latest !== ownPkg.version) {
      const useLatest = await p.confirm({
        message: `A new version is available (${ownPkg.version} → ${latest}). Run that instead?`,
      });
      if (!p.isCancel(useLatest) && useLatest) {
        const runner = process.versions.bun ? 'bunx' : 'npx';
        const { exitCode } = await execa(runner, [`${ownPkg.name}@latest`], { stdio: 'inherit', reject: false });
        process.exit(exitCode ?? 0);
      }
    }
  }
} catch {
  // offline or registry unreachable — proceed with whatever version is running
}

const projectName = await p.text({ message: 'Project name', placeholder: 'my-app' });
const targetDir = join(process.cwd(), projectName);
const pkgName = projectName === '.' ? basename(resolve(targetDir)) : projectName;

if (projectName === '.') {
  if (readdirSync(targetDir).some((f) => !IGNORE_FILES.has(f))) {
    p.cancel(`${targetDir} is not empty`); process.exit(1);
  }
} else if (existsSync(targetDir)) {
  p.cancel(`${targetDir} already exists`); process.exit(1);
}

const dbDriver = await p.select({
  message: 'Database driver',
  options: [
    { value: 'pg', label: 'pg — local/self-hosted Postgres (Docker)' },
    { value: 'neon', label: 'neon — Neon serverless (production)' },
  ],
});

const modules = await p.multiselect({
  message: 'Optional modules (space to toggle, enter to confirm)',
  options: [
    { value: 'doppler', label: 'Doppler secret management' },
    { value: 'resend', label: 'Resend email (transactional mail)' },
    { value: 'docker', label: 'Docker (Dockerfile + .dockerignore)' },
  ],
  required: false,
});

// --- clone ---
// `git clone` refuses to write into a directory that already contains
// anything — even just a stray .git from a prior `git init` or attempt. When
// targetDir has ignorable leftovers, clone/extract into a scratch dir next to
// them and merge in, instead of failing outright.
const hasLeftovers = existsSync(targetDir) && readdirSync(targetDir).length > 0;
const cloneDir = hasLeftovers ? join(targetDir, `.create-nextjs-${Date.now()}`) : targetDir;

const s = p.spinner();
s.start('Cloning template');
try {
  await execa('git', ['clone', '--depth', '1', REPO, cloneDir]);
} catch (err) {
  if (err.code === 'ENOENT') {
    // git not available — fall back to a release tarball
    s.message('git not found, downloading release tarball');
    const res = await fetch('https://api.github.com/repos/xk2800/nextjs-template/tarball/master', {
      headers: process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {},
      redirect: 'follow',
    });
    if (!res.ok) { s.stop('failed'); p.cancel(`download failed: ${res.status}`); process.exit(1); }
    writeFileSync('template.tar.gz', Buffer.from(await res.arrayBuffer()));
    await execa('mkdir', ['-p', cloneDir]);
    await execa('tar', ['-xzf', 'template.tar.gz', '--strip-components=1', '-C', cloneDir]);
    rmSync('template.tar.gz');
  } else {
    s.stop('failed');
    p.cancel(err.message);
    process.exit(1);
  }
}
if (cloneDir !== targetDir) {
  for (const entry of readdirSync(cloneDir)) {
    if (entry === '.git') continue;
    renameSync(join(cloneDir, entry), join(targetDir, entry));
  }
  rmSync(cloneDir, { recursive: true, force: true });
}
rmSync(join(targetDir, '.git'), { recursive: true, force: true });
rmSync(join(targetDir, '.github'), { recursive: true, force: true }); // template-maintainer usage, not for scaffolded projects
rmSync(join(targetDir, 'PUBLISHING.md'), { force: true }); // template-maintainer doc, not for scaffolded projects
rmSync(join(targetDir, 'scripts/bump-version.ts'), { force: true }); // template-maintainer tool, not for scaffolded projects
rewriteSelfImports(targetDir);
// The `exports` map, tsup, and tsconfig.build.json only exist so the
// template repo can itself be published as a library — a scaffolded app runs
// straight off its own source (via @/*) and never builds a dist/ from these.
rmSync(join(targetDir, 'tsup.config.ts'), { force: true });
rmSync(join(targetDir, 'tsconfig.build.json'), { force: true });
// Keep CHANGELOG.md but reset it — the cloned one is the template's own
// version history, not the new project's.
writeFileSync(join(targetDir, 'CHANGELOG.md'), '# Changelog\n\nAll notable changes to this project will be documented here.\n');
if (!modules.includes('docker')) {
  rmSync(join(targetDir, 'Dockerfile'), { force: true });
  rmSync(join(targetDir, '.dockerignore'), { force: true });
}
await execa('git', ['init'], { cwd: targetDir });
s.stop('Cloned');

// --- doctor script ---
// Not part of the template — this CLI's own env/DB-connection sanity check.
const ownDoctorPath = fileURLToPath(new URL('./doctor.ts', import.meta.url));
writeFileSync(join(targetDir, 'scripts/doctor.ts'), readFileSync(ownDoctorPath, 'utf-8'));

// --- package.json ---
const pkgPath = join(targetDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
pkg.name = pkgName;
pkg.version = '0.1.0';
pkg.scripts.doctor = 'bun --env-file=.env.development scripts/doctor.ts';
pkg.scripts.build = 'next build';
pkg.scripts.typecheck = 'tsc --noEmit';
delete pkg.scripts['bump-version'];
delete pkg.scripts['build:lib'];
delete pkg.scripts.prepublishOnly;
delete pkg.devDependencies?.tsup;
delete pkg.publishConfig;
delete pkg.repository;
delete pkg.files;
delete pkg.sideEffects;
delete pkg.exports;
delete pkg.typesVersions;
delete pkg.main;
delete pkg.module;
delete pkg.types;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// --- .env.development ---
// Built against the template's real .env.development.example, not assumed
// key names: the secret var is BETTER_AUTH_SECRET, there is no DB_DRIVER line
// (it's a zod default of "pg", only written here when overridden), and
// BETTER_AUTH_URL/BASE_URL ship blank — leaving them blank breaks the OAuth
// callback on first `bun dev`, so prefill localhost.
const port = 3000;
const authSecret = randomBytes(32).toString('base64');
let env = readFileSync(join(targetDir, '.env.development.example'), 'utf-8');
env = env
  .replace(/^PORT=$/m, `PORT=${port}`)
  .replace(/^BASE_URL=$/m, `BASE_URL=http://localhost:${port}`)
  .replace(/^BETTER_AUTH_URL=$/m, `BETTER_AUTH_URL=http://localhost:${port}`)
  .replace(/^BETTER_AUTH_SECRET=$/m, `BETTER_AUTH_SECRET=${authSecret}`);
if (dbDriver !== 'pg') {
  env = env.replace(/^DATABASE_URL=$/m, `DATABASE_URL=\nDB_DRIVER=${dbDriver}`);
}
writeFileSync(join(targetDir, '.env.development'), env);

// --- install ---
s.start('Installing dependencies');
await execa('bun', ['install'], { cwd: targetDir });
s.stop('Installed');

// --- squash migrations ---
// The template ships its own dev migration history (one file per schema
// change made while building it) — meaningless for a brand-new project.
// Regenerate a single migration from the current schema instead. `generate`
// only diffs the schema against the migrations folder, no DB connection needed.
s.start('Squashing migrations into a single initial migration');
rmSync(join(targetDir, 'server/drizzle'), { recursive: true, force: true });
await execa('bunx', ['drizzle-kit', 'generate'], { cwd: targetDir });
s.stop('Migrations squashed');

// --- initial commit ---
// reject: false — a missing git user.name/email shouldn't abort a finished scaffold.
await execa('git', ['add', '-A'], { cwd: targetDir });
const commit = await execa('git', ['commit', '-m', 'initial commit'], { cwd: targetDir, reject: false });
if (commit.exitCode !== 0) p.log.warn(`Skipped initial commit: ${commit.stderr || commit.stdout}`);

const notes = ['Fill in DATABASE_URL (and Google OAuth vars if using them) in .env.development'];
if (modules.includes('resend')) notes.push('Add RESEND_API_KEY to .env.development to send real email');
if (modules.includes('doppler')) notes.push('Run `doppler setup` — see README "Secrets management with Doppler"');
if (modules.includes('docker')) notes.push('docker build -t ' + pkgName + ' .   # see Dockerfile');
notes.push('bun run doctor   # verify env + DB connection before migrating');
notes.push('bun run migrate:dev');
p.note(notes.join('\n'), 'Next steps');
p.outro(`cd ${projectName} && bun dev`);
