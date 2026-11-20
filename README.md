# 🚀 @xk2800/create-nextjs

An interactive CLI that spins up a new project from the [`xk2800/nextjs-template`](https://github.com/xk2800/nextjs-template) repo.

It asks you a few questions (project name, DB driver, first admin, optional modules), then downloads the template, sets up `.env.development`, and installs everything for you. ✨

> 🔓 Both the CLI and the template are **public**, so `npx` / `bunx` just works. No account, token, or `.npmrc` needed.

---

## 📋 Prerequisites

- 🥟 [Bun](https://bun.com) installed
- 🌱 Git (recommended). Without it, the CLI downloads a release tarball instead and skips the initial commit.

---

## ⚡ Quick start

```bash
npx @xk2800/create-nextjs
# or
bunx @xk2800/create-nextjs
```

🧪 Want the latest beta instead of the stable release? Add `--beta`:

```bash
bunx @xk2800/create-nextjs --beta
```

📁 Run it from the **parent** folder where you want your new project folder to be created.

### 💬 What it asks you

| Prompt | What it does |
|---|---|
| 📛 **Project name** | Becomes the folder name and the `package.json` name. Use `.` to scaffold into the current folder (it must be empty apart from harmless files like `.git`, `.gitignore`, `.DS_Store`, `.vscode`). |
| 🗄️ **Database driver** | `pg` (local/self-hosted Postgres) or `neon` (Neon serverless). |
| 👑 **First admin email** | Optional. Saved as `ADMIN_EMAIL` in `.env.development`. Whoever signs up with it becomes the first admin ([details below](#first-admin)). |
| 🧩 **Optional modules** | Doppler secrets, Resend email, Docker (`Dockerfile` + `.dockerignore`). |

### 🛠️ What happens next

1. 📥 **Clones the template** at the tag matching the latest published `@xk2800/nextjs-template` (or `beta`), so your local files line up with the installed package.
2. 🧹 **Cleans up** template-maintainer files (CI, docs, Storybook, the `/features` showcase page…) and resets `CHANGELOG.md` / `data/changelog.json`.
3. 🔗 **Swaps in shims.** Every file the template package already provides becomes a one-line re-export from `@xk2800/nextjs-template`, so you get fixes just by bumping the package (see [Upgrading](#upgrading)). Want to customise one? Replace its shim with your own code. It then stops receiving updates.
4. ⚙️ **Configures your app.** Rewrites `package.json` and writes `.env.development` with a fresh `BETTER_AUTH_SECRET`, `localhost:3000` URLs, your DB driver and admin email.
5. 📦 **Installs & commits.** Runs `bun install`, squashes the template's migration history into one initial migration, and makes an initial git commit.

> 🛟 **If anything fails**, the half-built project folder is removed. Your own folder is never deleted when using `.`.
>
> 🔄 The CLI also checks npm for a newer version of itself and offers to re-run with it, since `npx` / `bunx` can serve a stale cached copy.

---

## 🎉 After scaffolding

```bash
cd <project-name>
# ✏️  fill in DATABASE_URL (and Google OAuth vars if using that provider) in .env.development
bun run doctor        # 🩺 checks env, auth secret, DB connection and pending migrations
bun run migrate:dev   # 🗄️ apply migrations
bun dev               # 🏃 start the dev server
```

---

<a id="first-admin"></a>

## 👑 First admin

If you entered an admin email, sign in with it and that account is promoted to admin.

- ✅ **Google sign-in is the reliable route**, since Google reports the email as verified.
- 📧 **Email/password** only works if you can receive the verification email (needs `RESEND_API_KEY`) and click the link.
- ⚠️ **Watch out:** if you sign up with email/password and *don't* verify, then later sign in with Google using the same address, you are **not** promoted. So sign in with Google first.
- 🔒 This only works while no admin exists yet.
- 🗑️ Once you're in, **delete `ADMIN_EMAIL`** from `.env.development` and any deployed env. It's only needed once.

💡 Left the prompt blank? All of this is skipped, and you can set the role in the database by hand.

---

<a id="upgrading"></a>

## ⬆️ Upgrading the template in an existing app

Run from your app's root folder:

```bash
bunx @xk2800/create-nextjs upgrade            # latest release
bunx @xk2800/create-nextjs upgrade 0.9.0      # a specific version
bunx -p @xk2800/create-nextjs create-nextjs-beta upgrade   # latest beta
```

What it does:

1. 📦 Bumps `@xk2800/nextjs-template` (keeping your `^` / exact pin style).
2. 🧬 Runs `drizzle-kit generate` so any template schema change gets its own migration.
3. 🗄️ Offers to apply it with your `migrate:dev` / `db:migrate` script (off by default, since it touches the database).
4. 🔍 Type-checks the app so breaking API changes show up immediately.

### 🧪 Testing unpublished template changes

Run `create-nextjs-beta-local upgrade` from this repo's checkout:

```bash
bun /path/to/create-nextjs/src/beta-local.mjs upgrade
```

It packs `../nextjs-template` and installs it as a `file:` dependency.

> ⚠️ Don't commit that! Run a normal `upgrade` once the template is published.

---

## 🩹 Troubleshooting

| 😵 Symptom | 🤔 Cause | ✅ Fix |
|---|---|---|
| `npx` reports 404 / package not found | Package not published yet, or version doesn't exist | Check <https://www.npmjs.com/package/@xk2800/create-nextjs> |
| `git clone` fails with a permission/auth error | No network access to GitHub, or the template repo isn't public (yet) | Confirm `xk2800/nextjs-template` is public; check your network/proxy |
| `Template changed: … Please report this.` | The template's files no longer match what the CLI patches | Open an issue on this repo |
| CLI crashes with `ERR_TTY_INIT_FAILED` | Running in a non-interactive shell (CI runner, some IDE task panels) | Run it in a real terminal. The interactive prompts need a TTY |

---

## 👩‍💻 Developing this CLI

```bash
bun install
bun test                          # 🧪 patch logic against a fixture template, no network
bun src/beta-local.mjs            # 🏗️ scaffold from ../nextjs-template (override with CREATE_NEXTJS_LOCAL)
bun run release                   # 🚢 bump version, tag and publish
```
