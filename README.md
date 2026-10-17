# @xk2800/create-nextjs

Interactive CLI that scaffolds a new project from the [`xk2800/nextjs-template`](https://github.com/xk2800/nextjs-template) repo — prompts for project name, DB driver, and optional modules, then clones, configures `.env.development`, and installs.

Both the CLI and the template repo it clones are **public**, so `npx`/`bunx` works with no account, token, or `.npmrc` setup.

## Prerequisites

- [Bun](https://bun.com) installed
- Git installed

## Using it

```bash
npx @xk2800/create-nextjs
# or
bunx @xk2800/create-nextjs
```

Run it from the parent directory you want the new project folder created in. You'll be prompted for:
- **Project name** — becomes the folder name and `package.json` name.
- **Database driver** — `pg` (local/self-hosted Postgres) or `neon` (Neon serverless).
- **Optional modules** — Doppler secrets, Resend email.

It clones the template, strips `.git` and reinitializes it, rewrites `package.json`, generates a fresh `BETTER_AUTH_SECRET`, and runs `bun install` for you.

## After scaffolding

```bash
cd <project-name>
# fill in DATABASE_URL (and Google OAuth vars if using that provider) in .env.development
bun run doctor        # checks env, auth secret, DB connection and pending migrations
bun run migrate:dev
bun dev
```

## Upgrading the template in an existing app

Run from the app's root folder:

```bash
bunx @xk2800/create-nextjs upgrade            # latest release
bunx @xk2800/create-nextjs upgrade 0.9.0      # a specific version
bunx -p @xk2800/create-nextjs create-nextjs-beta upgrade   # latest beta
```

It bumps `@xk2800/nextjs-template` (keeping your `^`/exact pin style), runs `drizzle-kit generate` so any template schema change gets its own migration, offers to apply it with your `migrate:dev` / `db:migrate` script (off by default — it touches the database), then type-checks the app so breaking API changes show up immediately.

To try unpublished template changes in a real app first, run `create-nextjs-beta-local upgrade` from this repo's checkout (`bun /path/to/create-nextjs/src/beta-local.mjs upgrade`). It packs `../nextjs-template` and installs it as a `file:` dependency — don't commit that; run a normal `upgrade` once the template is published.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npx` reports 404 / package not found | Package not published yet, or version doesn't exist | Check <https://www.npmjs.com/package/@xk2800/create-nextjs> |
| `git clone` fails with a permission/auth error | No network access to GitHub, or the template repo isn't public (yet) | Confirm `xk2800/nextjs-template` is public; check your network/proxy |
| CLI crashes with `ERR_TTY_INIT_FAILED` | Running in a non-interactive shell (CI runner, some IDE task panels) | Run it in a real terminal — the interactive prompts need a TTY |
