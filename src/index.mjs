#!/usr/bin/env node
import * as p from '@clack/prompts';
import { execa } from 'execa';
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATE_PKG, TEMPLATE_TAG, LOCAL, packLocal } from './common.mjs';
import { patchTemplate, moveIntoTarget, removeFailed } from './patch.mjs';

// Override for local testing: CREATE_NEXTJS_REPO=/path/to/local/clone
const REPO = process.env.CREATE_NEXTJS_REPO || 'https://github.com/xk2800/nextjs-template.git';

// Harmless artifacts (a stray .git from `git init`, editor/OS cruft) that
// shouldn't block scaffolding into "." — same allowlist create-vite uses.
const IGNORE_FILES = new Set(['.git', '.DS_Store', '.gitignore', '.gitattributes', '.idea', '.vscode', 'Thumbs.db']);

const ownPkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const ownPkg = JSON.parse(readFileSync(ownPkgPath, 'utf-8'));

p.intro(`@xk2800/create-nextjs${LOCAL ? ` (template: ${LOCAL})` : TEMPLATE_TAG === 'latest' ? '' : ` (template: ${TEMPLATE_TAG})`}`);

// npx/bunx can hand you a stale cached copy of this CLI — offer to re-run
// with the real latest instead of silently scaffolding with old code.
// Skipped in local mode: that's testing this checkout, not the published CLI.
if (!LOCAL) try {
  const res = await fetch(`https://registry.npmjs.org/${ownPkg.name}/latest`, { signal: AbortSignal.timeout(5000) });
  if (res.ok) {
    const { version: latest } = await res.json();
    if (latest !== ownPkg.version) {
      const useLatest = await p.confirm({
        message: `A new version is available (${ownPkg.version} → ${latest}). Run that instead?`,
      });
      if (!p.isCancel(useLatest) && useLatest) {
        const runner = process.versions.bun ? 'bunx' : 'npx';
        const { exitCode } = await execa(runner, [`${ownPkg.name}@latest`, ...process.argv.slice(2)], { stdio: 'inherit', reject: false, env: { CREATE_NEXTJS_TAG: TEMPLATE_TAG } });
        process.exit(exitCode ?? 0);
      }
    }
  }
} catch {
  // offline or registry unreachable — proceed with whatever version is running
}

if (process.argv[2] === 'upgrade') {
  await import('./upgrade.mjs');
  process.exit(0);
}

try { await execa('bun', ['--version']); } catch {
  p.cancel('bun is required but was not found. Install it from https://bun.sh'); process.exit(1);
}

const projectName = await p.text({ message: 'Project name', placeholder: 'my-app', defaultValue: 'my-app',
  // Becomes both a folder path and the npm package name: no "..", slashes, spaces or capitals.
  validate: (v) => (v && !/^(\.|[a-z0-9][a-z0-9._-]*)$/.test(v) ? 'Use lowercase letters, numbers, ".", "_" or "-" (or "." for the current folder)' : undefined),
});
if (p.isCancel(projectName)) { p.cancel('Cancelled'); process.exit(0); }
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
if (p.isCancel(dbDriver)) { p.cancel('Cancelled'); process.exit(0); }

const adminEmail =await p.text({
  message: 'Email for the first admin account (leave blank to skip)',
  placeholder: 'you@example.com',
  defaultValue: '',
  validate: (v) => (v && !/^\S+@\S+\.\S+$/.test(v) ? 'Enter a valid email' : undefined),
});
if (p.isCancel(adminEmail)) { p.cancel('Cancelled'); process.exit(0); }

const modules = await p.multiselect({
  message: 'Optional modules (space to toggle, enter to confirm)',
  options: [
    { value: 'doppler', label: 'Doppler secret management' },
    { value: 'resend', label: 'Resend email (transactional mail)' },
    { value: 'docker', label: 'Docker (Dockerfile + .dockerignore)' },
  ],
  required: false,
});
if (p.isCancel(modules)) { p.cancel('Cancelled'); process.exit(0); }

// --- clone ---
// `git clone` refuses to write into a directory that already contains
// anything — even just a stray .git from a prior `git init` or attempt. When
// targetDir has ignorable leftovers, clone/extract into a scratch dir next to
// them and merge in, instead of failing outright.
const hasLeftovers = existsSync(targetDir) && readdirSync(targetDir).length > 0;
const cloneDir = hasLeftovers ? join(targetDir, `.create-nextjs-${Date.now()}`) : targetDir;

const s = p.spinner();
// Everything below runs in this try so a failed git/bun call cleans up after itself.
try {
s.start('Cloning template');
// Clone the tag of the latest published package, not a branch tip: the local
// files (routes, shims below) must line up with the package version installed.
let templateVersion;
if (LOCAL) {
  // Copy the working tree as-is (tracked + untracked, minus .gitignore'd
  // node_modules/dist/.env) so unpublished, uncommitted changes are tested.
  templateVersion = JSON.parse(readFileSync(join(LOCAL, 'package.json'), 'utf-8')).version;
  const { stdout } = await execa('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: LOCAL });
  for (const f of stdout.split('\0')) {
    if (f && existsSync(join(LOCAL, f))) cpSync(join(LOCAL, f), join(cloneDir, f));
  }
} else try {
  const res = await fetch(`https://registry.npmjs.org/${TEMPLATE_PKG}/${TEMPLATE_TAG}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  templateVersion = (await res.json()).version;
} catch (err) {
  s.stop('failed'); p.cancel(`Could not look up ${TEMPLATE_PKG} on npm: ${err.message}`); process.exit(1);
}
const templateRef = `v${templateVersion}`;
if (!LOCAL) try {
  await execa('git', ['clone', '--depth', '1', '--branch', templateRef, REPO, cloneDir]);
} catch (err) {
  if (err.code === 'ENOENT') {
    // git not available — fall back to a release tarball
    s.message('git not found, downloading release tarball');
    const res = await fetch(`https://api.github.com/repos/xk2800/nextjs-template/tarball/${templateRef}`, {
      headers: process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {},
      redirect: 'follow',
      // Covers the body download too, so longer than the registry calls' 5s.
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) { s.stop('failed'); p.cancel(`download failed: ${res.status}`); process.exit(1); }
    const tmp = mkdtempSync(join(tmpdir(), 'create-nextjs-'));
    const archive = join(tmp, 'template.tar.gz');
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    mkdirSync(cloneDir, { recursive: true });
    try {
      await execa('tar', ['-xzf', archive, '--strip-components=1', '-C', cloneDir]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else {
    s.stop('failed');
    p.cancel(err.message);
    process.exit(1);
  }
}
moveIntoTarget(cloneDir, targetDir);
patchTemplate(targetDir, { pkgName, templateVersion, modules, dbDriver, adminEmail });
await execa('git', ['init'], { cwd: targetDir });
s.stop('Cloned');

// --- install ---
if (LOCAL) {
  s.start('Building local template package');
  await packLocal(targetDir);
  s.stop('Built');
}
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
const commit = await execa('git', ['commit', '-m', 'Initial commit'], { cwd: targetDir, reject: false });
if (commit.exitCode !== 0) p.log.warn(`Skipped initial commit: ${commit.stderr || commit.stdout}`);

const notes = ['Fill in DATABASE_URL (and Google OAuth vars if using them) in .env.development'];
if (modules.includes('resend')) notes.push('Add RESEND_API_KEY to .env.development to send real email');
if (modules.includes('doppler')) notes.push('Run `doppler setup` — see README "Secrets management with Doppler"');
if (modules.includes('docker')) notes.push('docker build -t ' + pkgName + ' .   # see Dockerfile');
if (adminEmail) notes.push(
  `Sign in as ${adminEmail} with Google to become admin`,
  '  (email/password: verify the email first, needs RESEND_API_KEY)',
  '  then delete ADMIN_EMAIL from your env, it is only needed once',
);
notes.push('bun run doctor   # verify env, DB connection and pending migrations');
notes.push('bun run migrate:dev');
notes.push('Template updates: bunx @xk2800/create-nextjs upgrade');
p.note(notes.join('\n'), 'Next steps');
p.outro(`cd ${projectName} && bun dev`);
} catch (err) {
  s.stop('failed');
  removeFailed(cloneDir, targetDir, projectName === '.');
  p.cancel([err.shortMessage || err.message, err.stderr].filter(Boolean).join('\n'));
  process.exit(1);
}
