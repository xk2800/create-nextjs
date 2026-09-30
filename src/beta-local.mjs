#!/usr/bin/env node
// Same CLI, scaffolding from a local nextjs-template working copy instead of
// npm/GitHub. Defaults to ../nextjs-template next to this repo;
// override with CREATE_NEXTJS_LOCAL=/path/to/nextjs-template.
import { fileURLToPath } from 'node:url';
process.env.CREATE_NEXTJS_LOCAL ||= fileURLToPath(new URL('../../nextjs-template', import.meta.url));
await import('./index.mjs');
