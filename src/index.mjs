#!/usr/bin/env node
import * as p from '@clack/prompts';
import { execa } from 'execa';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, rmSync, cpSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Override for local testing: CREATE_NEXTJS_REPO=/path/to/local/clone
const REPO = process.env.CREATE_NEXTJS_REPO || 'https://github.com/xk2800/nextjs-template.git';

// Harmless artifacts (a stray .git from `git init`, editor/OS cruft) that
// shouldn't block scaffolding into "." — same allowlist create-vite uses.
const IGNORE_FILES = new Set(['.git', '.DS_Store', '.gitignore', '.gitattributes', '.idea', '.vscode', 'Thumbs.db']);

const TEMPLATE_PKG = '@xk2800/nextjs-template';
// npm dist-tag to scaffold from; `create-nextjs-beta` sets this to "beta".
const TEMPLATE_TAG = process.env.CREATE_NEXTJS_TAG || 'latest';
// Local template working copy to scaffold from instead of npm/GitHub;
// `create-nextjs-beta-local` sets this. Uncommitted changes are included.
const LOCAL = process.env.CREATE_NEXTJS_LOCAL && resolve(process.env.CREATE_NEXTJS_LOCAL);
const LOCAL_TGZ = 'nextjs-template-local.tgz';

// Scaffolded apps depend on the template package, so a version bump is how
// they get fixes. Every local file the package also provides is replaced by a
// one-line re-export: app code keeps importing `@/server/auth` etc. unchanged,
// but the logic now comes from node_modules. To customise a module, a user
// replaces its shim with their own code (and stops getting updates for it).
function shim(file, specifier) {
  const hasDefault = /^export default /m.test(readFileSync(file, 'utf-8'));
  writeFileSync(file, `export * from '${specifier}';\n` + (hasDefault ? `export { default } from '${specifier}';\n` : ''));
}

// Local source files the published package provides, as [file, specifier]:
// tsup entries (built to dist/), plain .ts subpath exports, and every
// component under the shipped `components/*` entries (exported as `./components/*`).
// A `files` entry can be a directory or a single .tsx file.
function packageProvidedFiles(dir, tplPkg) {
  const provided = [];
  const tsup = readFileSync(join(dir, 'tsup.config.ts'), 'utf-8');
  for (const [, sub, src] of tsup.matchAll(/"([^"]+)":\s*"([^"]+\.ts)"/g)) {
    provided.push([src, `${TEMPLATE_PKG}/${sub.replace(/\/index$/, '')}`]);
  }
  for (const [key, val] of Object.entries(tplPkg.exports ?? {})) {
    if (typeof val === 'string' && val.endsWith('.ts')) provided.push([val.slice(2), `${TEMPLATE_PKG}/${key.slice(2)}`]);
  }
  const walk = (rel) => {
    if (!statSync(join(dir, rel)).isDirectory()) {
      if (rel.endsWith('.tsx')) provided.push([rel, `${TEMPLATE_PKG}/${rel.slice(0, -4)}`]);
      return;
    }
    for (const e of readdirSync(join(dir, rel))) walk(`${rel}/${e}`);
  };
  for (const f of tplPkg.files ?? []) if (f.startsWith('components/') && existsSync(join(dir, f))) walk(f);
  return provided.filter(([f]) => existsSync(join(dir, f)));
}

const ownPkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const ownPkg = JSON.parse(readFileSync(ownPkgPath, 'utf-8'));

p.intro(`@xk2800/create-nextjs${LOCAL ? ` (template: ${LOCAL})` : TEMPLATE_TAG === 'latest' ? '' : ` (template: ${TEMPLATE_TAG})`}`);

// npx/bunx can hand you a stale cached copy of this CLI — offer to re-run
// with the real latest instead of silently scaffolding with old code.
// Skipped in local mode: that's testing this checkout, not the published CLI.
if (!LOCAL) try {
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

const projectName = await p.text({ message: 'Project name', placeholder: 'my-app', defaultValue: 'my-app' });
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
  const res = await fetch(`https://registry.npmjs.org/${TEMPLATE_PKG}/${TEMPLATE_TAG}`);
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
rmSync(join(targetDir, 'docs'), { recursive: true, force: true }); // the template's own docs site, not for scaffolded projects
rmSync(join(targetDir, 'scripts/bump-version.ts'), { force: true }); // template-maintainer tool, not for scaffolded projects
rmSync(join(targetDir, 'scripts/bump-version.test.ts'), { force: true });
const tplPkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf-8'));
for (const [file, specifier] of packageProvidedFiles(targetDir, tplPkg)) shim(join(targetDir, file), specifier);
// The package ships its components as .tsx source, so Next must compile them,
// and Tailwind v4 skips node_modules when scanning for class names.
const nextConfigPath = join(targetDir, 'next.config.ts');
writeFileSync(nextConfigPath, readFileSync(nextConfigPath, 'utf-8')
  .replace(/(const nextConfig: NextConfig = \{\n)/, `$1  transpilePackages: ["${TEMPLATE_PKG}"],\n`));
const cssPath = join(targetDir, 'app/globals.css');
writeFileSync(cssPath, readFileSync(cssPath, 'utf-8')
  .replace('@import "tailwindcss";\n', `@import "tailwindcss";\n@source "../node_modules/${TEMPLATE_PKG}";\n`));
// The `exports` map, tsup, and tsconfig.build.json only exist so the
// template repo can itself be published as a library — a scaffolded app
// consumes that library and never builds a dist/ of its own.
rmSync(join(targetDir, 'tsup.config.ts'), { force: true });
rmSync(join(targetDir, 'tsconfig.build.json'), { force: true });
// Keep CHANGELOG.md but reset it — the cloned one is the template's own
// version history, not the new project's.
writeFileSync(join(targetDir, 'CHANGELOG.md'), '# Changelog\n\nAll notable changes to this project will be documented here.\n');
// The /features page showcases the template itself, not the new project —
// drop it and every link to it (the landing-page button, header, footer).
rmSync(join(targetDir, 'app/features'), { recursive: true, force: true });
for (const [file, pattern] of [
  ['app/page.tsx', /\s*<Button asChild variant="outline">\s*<Link href="\/features">[\s\S]*?<\/Button>/],
  ['components/site/site-header.tsx', /\s*<Link\s+href="\/features"[\s\S]*?<\/Link>/],
  ['components/site/site-footer.tsx', /\s*<Link\s+href="\/features"[\s\S]*?<\/Link>/],
]) {
  const path = join(targetDir, file);
  if (existsSync(path)) writeFileSync(path, readFileSync(path, 'utf-8').replace(pattern, ''));
}
if (!modules.includes('docker')) {
  rmSync(join(targetDir, 'Dockerfile'), { force: true });
  rmSync(join(targetDir, '.dockerignore'), { force: true });
}
await execa('git', ['init'], { cwd: targetDir });
s.stop('Cloned');

// --- package.json ---
const pkgPath = join(targetDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
pkg.dependencies = { ...pkg.dependencies, [TEMPLATE_PKG]: LOCAL ? `file:./${LOCAL_TGZ}` : `^${templateVersion}` };
pkg.name = pkgName;
pkg.version = '0.1.0';
pkg.scripts.doctor = 'bun --env-file=.env.development scripts/doctor.ts';
pkg.scripts.build = 'next build';
pkg.scripts.typecheck = 'tsc --noEmit';
delete pkg.scripts['bump-version'];
delete pkg.scripts['docs:dev'];
if (pkg.scripts.test) pkg.scripts.test = pkg.scripts.test.replace(' && bun scripts/bump-version.test.ts', '');
delete pkg.scripts['build:lib'];
delete pkg.scripts.prepublishOnly;
if (!modules.includes('doppler')) {
  for (const name of Object.keys(pkg.scripts)) if (name.endsWith(':doppler')) delete pkg.scripts[name];
}
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
if (LOCAL) {
  // Pack exactly what `npm publish` would ship, and install that.
  s.start('Building local template package');
  await execa('bun', ['run', 'build:lib'], { cwd: LOCAL });
  await execa('bun', ['pm', 'pack', '--filename', join(targetDir, LOCAL_TGZ)], { cwd: LOCAL });
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
const commit = await execa('git', ['commit', '-m', 'initial commit'], { cwd: targetDir, reject: false });
if (commit.exitCode !== 0) p.log.warn(`Skipped initial commit: ${commit.stderr || commit.stdout}`);

const notes = ['Fill in DATABASE_URL (and Google OAuth vars if using them) in .env.development'];
if (modules.includes('resend')) notes.push('Add RESEND_API_KEY to .env.development to send real email');
if (modules.includes('doppler')) notes.push('Run `doppler setup` — see README "Secrets management with Doppler"');
if (modules.includes('docker')) notes.push('docker build -t ' + pkgName + ' .   # see Dockerfile');
notes.push('bun run doctor   # verify env, DB connection and pending migrations');
notes.push('bun run migrate:dev');
notes.push(`Template updates: bun update ${TEMPLATE_PKG}, then bun run generate if the schema changed`);
p.note(notes.join('\n'), 'Next steps');
p.outro(`cd ${projectName} && bun dev`);
