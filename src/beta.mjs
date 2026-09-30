#!/usr/bin/env node
// Same CLI, scaffolding from the template's "beta" npm dist-tag.
process.env.CREATE_NEXTJS_TAG = 'beta';
await import('./index.mjs');
