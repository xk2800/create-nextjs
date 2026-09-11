#!/usr/bin/env bun
import * as p from '@clack/prompts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkgPath = new URL('../package.json', import.meta.url);

async function run(strings, ...values) {
  console.log(`\n$ ${String.raw({ raw: strings }, ...values)}`);
  return Bun.$(strings, ...values);
}

function nextVersion(current, type) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (type === 'major') return `${major + 1}.0.0`;
  if (type === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// Commit subjects in a range, newest first, with merges and bare version-tag
// commits ("v0.1.1") stripped out — used for the release notes.
async function commitMessagesBetween(range) {
  let log;
  try {
    log = (await Bun.$`git log ${range} --oneline --no-merges`.text()).trim();
  } catch {
    return null; // range invalid, e.g. previous tag doesn't exist locally
  }
  if (!log) return [];
  return log
    .split('\n')
    .map((line) => line.replace(/^[0-9a-f]+\s+/, ''))
    .filter((msg) => !/^v?\d+\.\d+\.\d+$/.test(msg));
}

async function generateReleaseNotes(fromTag, toTag) {
  let messages = await commitMessagesBetween(`${fromTag}..${toTag}`);
  if (messages === null) {
    console.warn(`Could not diff ${fromTag}..${toTag} — falling back to full history for ${toTag}.`);
    messages = (await commitMessagesBetween(toTag)) ?? [];
  }
  if (!messages.length) return `No changes since ${fromTag}.`;
  return messages.map((m) => `- ${m}`).join('\n');
}

async function isGhAvailable() {
  try {
    await Bun.$`gh --version`.quiet();
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const pkg = await Bun.file(pkgPath).json();
  p.intro('release');
  console.log(`Current version: ${pkg.version}`);

  const bumpType = await p.select({
    message: 'Select version bump type',
    options: [
      { value: 'patch', label: `patch  (${pkg.version} → ${nextVersion(pkg.version, 'patch')})`, hint: 'Bug fixes' },
      { value: 'minor', label: `minor  (${pkg.version} → ${nextVersion(pkg.version, 'minor')})`, hint: 'New features' },
      { value: 'major', label: `major  (${pkg.version} → ${nextVersion(pkg.version, 'major')})`, hint: 'Breaking changes' },
    ],
  });
  if (p.isCancel(bumpType)) return p.cancel('Aborted.');

  const status = (await Bun.$`git status --porcelain`.text()).trim();
  if (status) {
    console.log('\nUncommitted changes:');
    console.log(status);
    const proceed = await p.confirm({
      message: '`bun pm version` requires a clean working tree. Continue anyway?',
      initialValue: false,
    });
    if (p.isCancel(proceed) || !proceed) return p.cancel('Aborted.');
  }

  const target = nextVersion(pkg.version, bumpType);
  const confirmBump = await p.confirm({
    message: `Bump ${pkg.version} → ${target} (creates a git commit + tag)?`,
  });
  if (p.isCancel(confirmBump) || !confirmBump) return p.cancel('Aborted.');

  const previousTag = `v${pkg.version}`;
  const newTag = `v${target}`;

  await run`bun pm version ${bumpType}`;

  const doPublish = await p.confirm({ message: 'Publish to npm now? (bun publish)' });
  if (!p.isCancel(doPublish) && doPublish) {
    await run`bun publish`;
  } else {
    p.note('bun publish', 'Skipped publish — run when ready');
  }

  const doPush = await p.confirm({ message: 'Push the version commit and tag to origin?' });
  let pushed = false;
  if (!p.isCancel(doPush) && doPush) {
    await run`git push`;
    await run`git push --tags`;
    pushed = true;
  } else {
    p.note('git push && git push --tags', 'Skipped push — run when ready');
  }

  const notes = await generateReleaseNotes(previousTag, newTag);
  const notesFile = join(tmpdir(), `release-notes-${newTag}.md`);
  await Bun.write(notesFile, notes);

  // A pushed git tag alone does NOT create a GitHub Release — that's a
  // separate object `gh release create` publishes, referencing the tag.
  const manualCmd = `gh release create ${newTag} --title ${newTag} --notes-file "${notesFile}"`;
  if (!(await isGhAvailable())) {
    p.note(manualCmd, `GitHub CLI ('gh') not found — install it or run manually`);
  } else if (!pushed) {
    p.note(manualCmd, `Skipped — ${newTag} isn't on origin yet. Push first, then run`);
  } else {
    const doRelease = await p.confirm({ message: `Create a GitHub Release for ${newTag}?` });
    if (!p.isCancel(doRelease) && doRelease) {
      await run`gh release create ${newTag} --title ${newTag} --notes-file ${notesFile}`;
    } else {
      p.note(manualCmd, 'Skipped release — run when ready');
    }
  }

  p.outro(`Released ${newTag}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
