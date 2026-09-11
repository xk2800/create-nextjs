# @xk2800/create-nextjs

Interactive CLI that scaffolds a new project from the private [`xk2800/nextjs-template`](https://github.com/xk2800/nextjs-template) repo — prompts for project name, DB driver, and optional modules, then clones, configures `.env.development`, and installs.

Both the CLI itself and the template it clones are **private**, so there are two separate one-time setup steps before `npx` will work. Skip them and you'll hit either a 404 or a permission error — see Troubleshooting below.

## Prerequisites

- [Bun](https://bun.com) installed
- Git installed
- A GitHub account that's been **granted access** by the repo owner to both private repos: `xk2800/create-nextjs` and `xk2800/nextjs-template`. Ask the owner to add you as a collaborator (or to the org/team with access) — no setup below will work without this.

## One-time setup

### 1. GitHub token

GitHub Packages' npm registry only supports **classic** personal access tokens (fine-grained tokens don't work here).

1. Go to <https://github.com/settings/tokens> → *Generate new token (classic)*.
2. Scopes: `read:packages` (lets npm/bun download the CLI) and `repo` (lets `git clone` reach the private template repo).
3. Export it in your shell profile (`~/.zshrc` or `~/.bashrc`):
   ```bash
   export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
   ```
   Then `source ~/.zshrc`.

### 2. `.npmrc` — tell npm/bun where `@xk2800` packages live

This has to go in your **global** `~/.npmrc`, not a project one — there's no project yet when you run `npx create-nextjs` from an empty folder.

```bash
cat >> ~/.npmrc <<'EOF'
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
@xk2800:registry=https://npm.pkg.github.com/
EOF
```

Verify it resolves:
```bash
npm whoami --registry=https://npm.pkg.github.com
# should print your GitHub username
```

### 3. Git access to the template repo

The CLI runs `git clone` against `xk2800/nextjs-template` internally — that needs your normal git credentials to already work against private GitHub repos, separately from the npm token above. Easiest path:

```bash
gh auth login
```

(If you don't use the `gh` CLI, make sure SSH or the macOS/Windows git credential manager is already authenticated for private repo access instead.)

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
bun run doctor        # confirms env + DB connection before you touch migrations
bun run migrate:dev
bun dev
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `npx` reports 404 / package not found | `@xk2800:registry` missing from `~/.npmrc` | Add the `.npmrc` lines from step 2 above |
| `npm whoami` fails or prints nothing | `GITHUB_TOKEN` not set/exported, or lacks `read:packages` | Re-check step 1; `echo $GITHUB_TOKEN` |
| `git clone` fails with a permission/auth error | Not authenticated for private git access, or not yet granted repo access | Run `gh auth login`; confirm the repo owner added you as a collaborator |
| CLI crashes with `ERR_TTY_INIT_FAILED` | Running in a non-interactive shell (CI runner, some IDE task panels) | Run it in a real terminal — the interactive prompts need a TTY |
