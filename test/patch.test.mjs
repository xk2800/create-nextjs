import { test, expect } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchTemplate } from '../src/patch.mjs';
import { TEMPLATE_PKG, LOCAL } from '../src/common.mjs';

const opts = { pkgName: 'my-app', templateVersion: '1.2.3', modules: [], dbDriver: 'neon', adminEmail: 'a@b.co' };

// Copy a template into a temp dir, patch it, hand back a reader for the result.
function scaffold(src) {
  const dir = mkdtempSync(join(tmpdir(), 'create-nextjs-test-'));
  cpSync(src, dir, { recursive: true, filter: (f) => !/[/\\](node_modules|\.git|\.next|dist)$/.test(f) });
  patchTemplate(dir, opts);
  const read = (f) => readFileSync(join(dir, f), 'utf-8');
  return { dir, read, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function expectCommon(read) {
  expect(read('next.config.ts')).toContain(`transpilePackages: ["${TEMPLATE_PKG}"]`);
  expect(read('app/globals.css')).toContain(`@source "../node_modules/${TEMPLATE_PKG}";`);
  expect(read('.env.development')).toMatch(/^BETTER_AUTH_SECRET=\S{40,}$/m);
  const pkg = JSON.parse(read('package.json'));
  expect(pkg.name).toBe('my-app');
  expect(pkg.exports).toBeUndefined();
}

test('patches the fixture template', () => {
  const { dir, read, done } = scaffold(join(import.meta.dir, 'fixture'));
  try {
    expectCommon(read);
    // shims: tsup entry (single-quoted), exports .ts entry, shipped component
    expect(read('server/auth/index.ts')).toBe(`export * from '${TEMPLATE_PKG}/server/auth';\nexport { default } from '${TEMPLATE_PKG}/server/auth';\n`);
    expect(read('lib/util.ts')).toBe(`export * from '${TEMPLATE_PKG}/lib/util';\n`);
    expect(read('components/ui/button.tsx')).toBe(`export * from '${TEMPLATE_PKG}/components/ui/button';\n`);
    expect(read('app/page.tsx')).not.toContain('/features');
    expect(read('.env.development')).toContain('DATABASE_URL=\nDB_DRIVER=neon\n');
    expect(read('.env.development')).toContain('ADMIN_EMAIL=a@b.co');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies[TEMPLATE_PKG]).toBe(LOCAL ? 'file:./nextjs-template-local.tgz' : '^1.2.3');
    expect(pkg.scripts.test).toBe('bun test');
    expect(pkg.scripts['dev:doppler']).toBeUndefined();
    expect(pkg.devDependencies.tsup).toBeUndefined();
    for (const gone of ['.github', 'maintainer notes', '.create-nextjs-ignore', 'tsup.config.ts']) expect(existsSync(join(dir, gone))).toBe(false);
  } finally { done(); }
});

test('fails loudly when a required patch no longer matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-nextjs-test-'));
  try {
    cpSync(join(import.meta.dir, 'fixture'), dir, { recursive: true });
    writeFileSync(join(dir, 'next.config.ts'), 'export default {};\n');
    expect(() => patchTemplate(dir, opts)).toThrow('could not patch next.config.ts');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('refuses .create-nextjs-ignore entries outside the project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'create-nextjs-test-'));
  try {
    cpSync(join(import.meta.dir, 'fixture'), dir, { recursive: true });
    writeFileSync(join(dir, '.create-nextjs-ignore'), '..\n');
    expect(() => patchTemplate(dir, opts)).toThrow('not inside the project');
    expect(existsSync(dir)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Catches real template drift: CREATE_NEXTJS_LOCAL=../nextjs-template bun test
test.skipIf(!LOCAL)('patches the real template at CREATE_NEXTJS_LOCAL', () => {
  const { dir, read, done } = scaffold(LOCAL);
  try {
    expectCommon(read);
    for (const gone of ['.github', 'gemini files', '.create-nextjs-ignore']) expect(existsSync(join(dir, gone))).toBe(false);
  } finally { done(); }
});
