# ColorBlendr Community Themes

Community-made themes for [ColorBlendr](https://github.com/Mahmud0808/ColorBlendr).
Themes are pure data (colors and Material You settings) — nothing executable.

- `themes/*.json` — one file per theme, schema-validated by CI on every PR
- `index.json` — auto-built list the app downloads (via jsDelivr CDN), with
  vote and download counts baked in daily
- `worker/` — Cloudflare Worker handling anonymous votes, in-app uploads
  (queued for owner approval), and the admin review endpoints
- `scripts/` — CI validation and index builder

## Submitting a theme

Use **Share current theme** inside the ColorBlendr app, or open a PR adding a
`themes/<id>.json` file by hand. In-app submissions land in a private review
queue first; only ones the maintainer approves become pull requests here.
Every submission is human-reviewed before merge.

## One-time setup (maintainer)

### 1. This repository

- Repo settings → Actions → General → Workflow permissions → **Read and write**.

### 2. Cloudflare Worker (free tier)

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Install and log in to the CLI (needs Node.js):
   ```
   npm install -g wrangler
   wrangler login
   ```
3. From the `worker/` directory, create the database and load the schema:
   ```
   wrangler d1 create colorblendr-themes
   ```
   Copy the printed `database_id` into `wrangler.toml`, then:
   ```
   wrangler d1 execute colorblendr-themes --file schema.sql --remote
   ```
4. Turnstile (bot protection for uploads): dashboard → **Turnstile** →
   Add widget → type **Invisible**, domain can be anything (e.g. `colorblendr.app`).
   Note the **site key** (goes in the app) and **secret key**:
   ```
   wrangler secret put TURNSTILE_SECRET
   ```
5. GitHub bot token: GitHub → Settings → Developer settings →
   Fine-grained tokens → New. Repository access: **only** `ColorBlendr-Themes`.
   Permissions: Contents **Read and write**, Pull requests **Read and write**.
   ```
   wrangler secret put GITHUB_TOKEN
   ```
6. Admin key (authorizes the ColorBlendr Dev review app; generate a strong
   one and keep it in your password manager — rerun the same command anytime
   to rotate it):
   ```
   openssl rand -hex 32
   wrangler secret put ADMIN_KEY
   ```
7. Deploy:
   ```
   wrangler deploy
   ```
   Note the printed URL, e.g. `https://colorblendr-themes.<subdomain>.workers.dev`.

### 3. Connect the pieces

1. GitHub repo → Settings → Secrets and variables → Actions → **Variables** →
   add `WORKER_URL` = the worker URL (no trailing slash).
2. In the ColorBlendr app source, set the worker URL and Turnstile site key
   constants, and confirm `COMMUNITY_INDEX_URL` points at
   `https://cdn.jsdelivr.net/gh/<owner>/ColorBlendr-Themes@main/index.json`.
3. Run the **Build index** workflow once manually (Actions tab) to produce the
   first `index.json`.

## Moderation

- In-app submissions sit in the worker's private queue — nothing appears on
  GitHub until approved. Review them with the **ColorBlendr Dev** companion
  app (`devapp` module in the ColorBlendr repo): enter the admin key once,
  then preview (tap a card to copy its config for the main app's theme
  tester), approve, or reject. Approving opens the PR via the bot token.
- Curl fallback: `curl -H "x-admin-key: KEY" <worker-url>/admin/pending`,
  then POST `{"id": "..."}` to `/admin/approve` or `/admin/reject`.
- Abusive uploaders can be blocked permanently (and unblocked) from the Dev
  app — identity is the anonymous salted device hash also used for votes,
  with a reason and date stored so blocks stay identifiable; raw device IDs
  and IP addresses are never stored anywhere.
- Admin auth is brute-force hardened: 256-bit key, constant-time comparison,
  and a lockout of 5 failed attempts per hour keyed by a salted IP hash
  (raw IPs are never stored).
- Approved PRs are validated by CI as schema-valid; you review the colors
  and merge.
- To remove a theme: delete its file — the next index build drops it and the
  app stops showing it.
