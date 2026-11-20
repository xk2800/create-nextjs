// The file edits that turn a template checkout into a new project. Split out of
// index.mjs so test/patch.test.mjs can run them without prompts, git or network.
import * as p from '@clack/prompts';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { TEMPLATE_PKG, LOCAL, LOCAL_TGZ } from './common.mjs';

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
  for (const [, sub, src] of tsup.matchAll(/["']([^"']+)["']\s*:\s*["']([^"']+\.ts)["']/g)) {
    provided.push([src, `${TEMPLATE_PKG}/${sub.replace(/\/index$/, '')}`]);
  }
  // An empty match means the config format changed: fail rather than ship apps with no shims (no update path).
  if (!provided.length) throw new Error('Template changed: no entries found in tsup.config.ts. Please report this.');
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

// cloneDir is a scratch dir inside targetDir when targetDir already had (ignorable) files,
// otherwise the same folder. Either way the user's own files and .git must survive.
export function moveIntoTarget(cloneDir, targetDir) {
  if (cloneDir === targetDir) {
    rmSync(join(targetDir, '.git'), { recursive: true, force: true }); // the template's own history
    return;
  }
  for (const entry of readdirSync(cloneDir)) {
    if (entry === '.git') continue;
    const dest = join(targetDir, entry);
    if (existsSync(dest)) {
      // Keep the user's file, but still add the template's rules: they keep .env.development (the auth secret) and node_modules out of the initial commit.
      if (entry === '.gitignore' || entry === '.gitattributes') appendFileSync(dest, '\n' + readFileSync(join(cloneDir, entry), 'utf-8'));
      continue;
    }
    renameSync(join(cloneDir, entry), dest);
  }
  rmSync(cloneDir, { recursive: true, force: true });
}

// After a failed scaffold: delete the new project folder, but never the user's own "." folder.
export function removeFailed(cloneDir, targetDir, isUserFolder) {
  if (!isUserFolder) rmSync(targetDir, { recursive: true, force: true });
  else if (cloneDir !== targetDir) rmSync(cloneDir, { recursive: true, force: true }); // scratch dir inside "."
}

export function patchTemplate(targetDir, { pkgName, templateVersion, modules, dbDriver, adminEmail }) {
  // Template-maintainer files (CI, docs site, Storybook, QA scripts...). The template lists them in
  // .create-nextjs-ignore so a new one is dropped without a CLI release.
  // shortcut: the fallback duplicates that list for template tags without the file (latest 0.7.0, beta 0.7.2-beta.7);
  // delete it once both npm dist-tags point at a version that has .create-nextjs-ignore.
  const ignoreFile = join(targetDir, '.create-nextjs-ignore');
  const maintainerOnly = existsSync(ignoreFile)
    ? [...readFileSync(ignoreFile, 'utf-8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')), '.create-nextjs-ignore']
    : ['.github', 'PUBLISHING.md', 'docs', 'scripts/bump-version.ts', 'scripts/bump-version.test.ts', '.storybook', 'stories',
      'SPEC.md', 'REVIEW-CHECKLIST.md', 'features-test.md', 'Dockerfile-old', 'Dockerfile.storybook', 'scripts/loadtest-throttle.ts',
      'scripts/test-2fa.ts', 'scripts/test-new-device.ts', 'brag-output', 'gemini files'];
  for (const f of maintainerOnly) {
    const path = resolve(targetDir, f);
    // An entry like "..", "/" or "." would delete outside (or all of) the new project.
    if (!path.startsWith(resolve(targetDir) + sep)) throw new Error(`.create-nextjs-ignore: "${f}" is not inside the project`);
    rmSync(path, { recursive: true, force: true });
  }
  for (const file of ['README.md', 'CLAUDE.md']) {
    const path = join(targetDir, file);
    // Also drop CLAUDE.md's "update docs/SPEC/features-test" rule — it points at files deleted above.
    if (existsSync(path)) writeFileSync(path, readFileSync(path, 'utf-8').replace(/^.*bun run storybook.*\n/gm, '').replace(/^3\. Any feature added, changed or removed:.*\n/m, ''));
  }
  const tplPkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf-8'));
  for (const [file, specifier] of packageProvidedFiles(targetDir, tplPkg)) shim(join(targetDir, file), specifier);
  // The package ships its components as .tsx source, so Next must compile them,
  // and Tailwind v4 skips node_modules when scanning for class names.
  // Fail loudly if the template changed and a pattern no longer matches.
  const edit = (file, pattern, replacement) => {
    const path = join(targetDir, file);
    const before = readFileSync(path, 'utf-8');
    const after = before.replace(pattern, replacement);
    // throw, not exit: index.mjs's catch removes the half-built folder
    if (after === before) throw new Error(`Template changed: could not patch ${file}. Please report this.`);
    writeFileSync(path, after);
  };
  edit('next.config.ts', /(const nextConfig: NextConfig = \{\n)/, `$1  transpilePackages: ["${TEMPLATE_PKG}"],\n`);
  edit('app/globals.css', '@import "tailwindcss";\n', `@import "tailwindcss";\n@source "../node_modules/${TEMPLATE_PKG}";\n`);
  // The `exports` map, tsup, and tsconfig.build.json only exist so the
  // template repo can itself be published as a library — a scaffolded app
  // consumes that library and never builds a dist/ of its own.
  rmSync(join(targetDir, 'tsup.config.ts'), { force: true });
  rmSync(join(targetDir, 'tsconfig.build.json'), { force: true });
  // Keep CHANGELOG.md but reset it — the cloned one is the template's own
  // version history, not the new project's.
  writeFileSync(join(targetDir, 'CHANGELOG.md'), '# Changelog\n\nAll notable changes to this project will be documented here.\n');
  // data/changelog.json feeds /changelog and the UpdateModal; the cloned one is the
  // template's release history. Reseed it (UpdateModal reads changelog[0], so not []),
  // and drop the template's older history page.
  rmSync(join(targetDir, 'app/changelog-template'), { recursive: true, force: true });
  rmSync(join(targetDir, 'data/changelog-template.json'), { force: true });
  writeFileSync(join(targetDir, 'data/changelog.json'), JSON.stringify([{
    version: '0.1.0',
    date: new Date().toISOString().slice(0, 10),
    type: 'feature',
    title: 'Initial release',
    changes: ['Project created with @xk2800/create-nextjs'],
  }], null, 2) + '\n');
  // The /features page showcases the template itself, not the new project —
  // drop it and every link to it (the landing-page button, header, footer).
  rmSync(join(targetDir, 'app/features'), { recursive: true, force: true });
  for (const [file, pattern] of [
    ['app/page.tsx', /\s*<Button asChild variant="outline">\s*<Link href="\/features">[\s\S]*?<\/Button>/],
    ['components/site/site-header.tsx', /\s*<Link\s+href="\/features"[\s\S]*?<\/Link>/],
    ['components/site/site-footer.tsx', /\s*<Link\s+href="\/features"[\s\S]*?<\/Link>/],
  ]) {
    // Cosmetic: a leftover link 404s but the app works, so warn instead of failing.
    if (existsSync(join(targetDir, file))) try { edit(file, pattern, ''); } catch (err) { p.log.warn(err.message); }
  }
  if (!modules.includes('docker')) {
    rmSync(join(targetDir, 'Dockerfile'), { force: true });
    rmSync(join(targetDir, '.dockerignore'), { force: true });
  }

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
  delete pkg.scripts.storybook;
  delete pkg.scripts['build-storybook'];
  for (const dep of ['storybook', '@storybook/nextjs-vite', '@storybook/addon-docs', 'vite']) delete pkg.devDependencies?.[dep];
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
  // Replaces the whole line (so `KEY=""` or `KEY= # note` still work) and fails loudly if the key
  // is gone: a silent miss ships a blank auth secret. Function replacement keeps `$` in values literal.
  const setEnv = (key, value) => {
    const line = new RegExp(`^${key}=.*$`, 'm');
    if (!line.test(env)) throw new Error(`Template changed: no ${key}= line in .env.development.example. Please report this.`);
    env = env.replace(line, () => `${key}=${value}`);
  };
  setEnv('PORT', port);
  setEnv('BASE_URL', `http://localhost:${port}`);
  setEnv('BETTER_AUTH_URL', `http://localhost:${port}`);
  setEnv('BETTER_AUTH_SECRET', authSecret);
  if (dbDriver !== 'pg') {
    // The example has no DB_DRIVER line (zod defaults to pg), so add one under DATABASE_URL.
    if (/^DB_DRIVER=/m.test(env)) setEnv('DB_DRIVER', dbDriver);
    else { setEnv('DATABASE_URL', ''); env = env.replace(/^DATABASE_URL=$/m, () => `DATABASE_URL=\nDB_DRIVER=${dbDriver}`); }
  }
  if (adminEmail) setEnv('ADMIN_EMAIL', adminEmail);
  writeFileSync(join(targetDir, '.env.development'), env);
}
