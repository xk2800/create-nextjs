// Shared by index.mjs (scaffold) and upgrade.mjs so the two can't drift apart.
import { execa } from 'execa';
import { resolve, join } from 'node:path';

export const TEMPLATE_PKG = '@xk2800/nextjs-template';
// npm dist-tag to scaffold from; `create-nextjs-beta` sets CREATE_NEXTJS_TAG, `--beta` also works.
export const TEMPLATE_TAG = process.env.CREATE_NEXTJS_TAG || (process.argv.includes('--beta') ? 'beta' : 'latest');
// Local template working copy to use instead of npm/GitHub; `create-nextjs-beta-local` sets this.
export const LOCAL = process.env.CREATE_NEXTJS_LOCAL && resolve(process.env.CREATE_NEXTJS_LOCAL);
export const LOCAL_TGZ = 'nextjs-template-local.tgz';

// Pack exactly what `npm publish` would ship into <dest>/LOCAL_TGZ.
export async function packLocal(dest) {
  await execa('bun', ['run', 'build:lib'], { cwd: LOCAL });
  await execa('bun', ['pm', 'pack', '--filename', join(dest, LOCAL_TGZ)], { cwd: LOCAL });
}
