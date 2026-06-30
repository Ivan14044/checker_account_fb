FB Account Checker + 2FA
========================

Web app with two modules:

1. **Checker** — validate Facebook accounts (Live / Blocked / Doesn't exist).
2. **2FA** — TOTP code generator (RFC 6238) from a Base32 secret.

The backend is a small Node.js/Express service. The Checker proxies to
`https://check.fb.tools/api/check/facebook` (public, **no token required**); the
2FA generator computes TOTP locally with `node:crypto`. The frontend is plain
JS/HTML/CSS in `public/` (no build step).

Run
---

1) Install deps: `npm install`

2) Start dev server: `npm run dev`

Open: `http://localhost:3000`. Switch between **Checker** and **2FA** from the
top nav.

Configuration
-------------

No tokens needed. Optional env vars:

- `PORT` — defaults to `3000`.
- `CHECK_URL` — override the upstream checker endpoint (defaults to
  `https://check.fb.tools/api/check/facebook`).
- `ALLOWED_ORIGINS` — comma-separated CORS allowlist. **Unset → defaults to the
  project's prod origins** (`https://ivan14044.github.io`,
  `https://checker-account-fb.onrender.com`). Requests with no `Origin`
  (curl/server-to-server) and `localhost`/`127.0.0.1` (dev) are always allowed.
  Set this to override the list, e.g. when using a custom domain.
- `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` — per-IP rate limit on the API
  routes (defaults: `60` requests per `60000` ms). `/api/ping` is not limited.
- `NODE_VERSION` — `18` (set on Render via `render.yaml`).

How it works
------------

### Checker

- The whole input line (FBID, profile URL, or cookies) is sent upstream. The
  frontend extracts an FB ID with `\b(?:10|61)[0-9A-Za-z]{10,23}\b` to
  **deduplicate** rows; lines without a numeric ID but with `facebook.com/`,
  `instagram.com/`, or a `c_user=` cookie are still checked (e.g. username
  URLs like `facebook.com/zuck`).
- Each upstream batch returns, per input string, a `status.name`:
  `valid` (Live) / `invalid` (Blocked) / `noexist` (Doesn't exist) / `error`.
  Only `valid` counts as valid; everything else is shown as
  "Невалидные/Заблокированные".
- Results are mapped back by the upstream `origin` field (the exact string we
  sent), which differs from `account`/`uid` for URL/cookie inputs.

### 2FA

- TOTP per RFC 6238: SHA-1, 6 digits, 30 s period. Base32 secret in, 6-digit
  code out.
- On the page (`public/2fa.html`) the code is computed **in the browser** via
  Web Crypto — the secret never leaves the device. The backend also exposes a
  public API (below). Verified against the RFC 6238 test vectors.

API endpoints
-------------

- `GET /api/ping` — health check / wake-up. Returns `{ ok, time, upstream }`.
- `POST /api/check/stream` — **streaming bulk check (preferred)**. Body:
  `{ "lines": [...] }` (legacy `{ "ids": [...] }` also accepted). Emits SSE:
  `start { total, batches }` →
  `batch { results: [{ line, id, uid, profileLink, valid, status }], done, total }` →
  `end { total, valid, invalid, breakdown }`.
  Heartbeat comments every 15 s.
- `POST /api/check` — bulk one-shot. Body: `{ "lines": [...] }`. Returns
  `{ valid, invalid, total, breakdown: { valid, invalid, noexist, error } }`.
  Fallback when SSE is unavailable.
- `GET /api/get_uid/:id` — single-ID lookup (legacy compatibility).
- `GET /api/otp/:secret` — 2FA TOTP for a Base32 secret. Returns
  `{ ok: true, data: { otp, timeRemaining } }`, or `{ ok: false, message }` for
  an invalid secret.

Notes
-----

- Upstream batches: **50** lines per request, **1** retry with **1.5 s** delay,
  **30 s** timeout (`CHECK_*` constants in `server.js`).
- Streaming runs up to **4** upstream batches in parallel per browser request
  (`STREAM_UPSTREAM_CONCURRENCY`).

Deploy
------

Two targets work together:

- **Render** (full Node service, backend + static UI) — `render.yaml`.
- **GitHub Pages** (static `public/` only) — `.github/workflows/pages.yml`. On
  `*.github.io` the static UI calls the Render backend for the Checker via
  `public/config.js` (`PROXY_BASE`). The 2FA page works on Pages with no
  backend (fully client-side).

### Render — single domain (UI + API on one URL)

1. Open https://dashboard.render.com and sign in (GitHub is easiest).
2. **New** → **Web Service**, pick the **checker_account_fb** repo, **Connect**.
3. Settings (usually filled from `render.yaml`): Environment **Node**, Build
   `npm install`, Start `npm run start`, env `NODE_VERSION=18`.
4. **Create Web Service**, wait for the deploy (1–3 min).
5. Open the issued URL — it serves both the UI and the API.

**Custom domain (optional):** service card → **Settings** → **Custom Domains**.
