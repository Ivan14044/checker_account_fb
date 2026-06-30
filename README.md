FB Account Checker
==================

Minimal web app to validate Facebook accounts. The backend is a Node.js service
that batches **full account strings** (cookies + access token + …) and queries
`https://npprservices.pro/api/services/fbchecker` with `checkToken: 1`, so the
upstream actually verifies the live session via the embedded `access_token`
rather than just looking up a bare ID.

Run
---

1) Install deps: `npm install`

2) Set the upstream token (see **Configuration** below): create a `.env` with
   `NPPR_TOKEN=...`

3) Start dev server: `npm run dev`

Open: `http://localhost:3000`.

Configuration
-------------

- `NPPR_TOKEN` — **required**. The API token for `npprservices.pro`. Without it
  every check fails (the server logs a warning on boot and returns `error` for
  each line). Read from `.env` locally; on Render it is set in the dashboard
  (declared as `sync: false` in `render.yaml`).
- `PORT` — optional, defaults to `3000`.
- `NODE_VERSION` — `18` (set on Render via `render.yaml`).

How it works
------------

- The frontend (`public/script.js`) extracts FB IDs with the regex
  `\b(?:10|61)[0-9A-Za-z]{10,23}\b` purely to **deduplicate** input lines and
  to show a short ID label per row. The *whole line* (cookies/token/…) is what
  gets sent upstream — that is what enables real session validation.
- Lines that share the same FB ID are deduped: the first occurrence is checked,
  the rest are listed under "Дубли".
- Each upstream batch returns a per-line status: `active`, `banned`,
  `notFound`, `withoutToken`, `duplicate`, or `error`. Only `active` counts as
  **valid**; everything else is shown as "Невалидные/Заблокированные".

API endpoints
-------------

- `GET /api/ping` — health check / wake-up. Returns `{ ok, time, upstream,
  tokenConfigured }`.
- `POST /api/check/stream` — **streaming bulk check (preferred)**. Body:
  `{ "lines": [...] }` (legacy `{ "ids": [...] }` also accepted). Emits
  Server-Sent Events:
  `start { total, batches }` →
  `batch { results: [{ line, id, valid, status }], done, total }` per upstream
  batch →
  `end { total, valid, invalid, breakdown }`.
  Heartbeat comments every 15 s. The frontend uses this to draw a live progress
  bar with no extra HTTP overhead.
- `POST /api/check` — bulk one-shot lookup. Body: `{ "lines": [...] }` (or
  `{ "ids": [...] }`). Returns `{ valid, invalid, total, breakdown }`. Used as a
  fallback if SSE is unavailable.
- `GET /api/get_uid/:id` — single-ID lookup, kept only for backward
  compatibility. **Note:** under the NPPR upstream a bare ID has no embedded
  token, so it resolves to `notFound`/`withoutToken` and effectively always
  returns `{ "uid": null }`. The current frontend no longer uses it.

Notes
-----

- Upstream batches: **50** lines per request, **1** retry with a **1.5 s**
  delay, **30 s** timeout (`NPPR_*` constants in `server.js`).
- Streaming runs up to **4** upstream batches in parallel inside one HTTP
  request from the browser (`STREAM_UPSTREAM_CONCURRENCY`).

Deploy
------

There are two deploy targets and they work together:

- **Render** (full Node service, backend + static UI) — driven by `render.yaml`.
- **GitHub Pages** (static `public/` only) — driven by
  `.github/workflows/pages.yml`. The static UI hosted on `*.github.io`
  automatically calls the Render backend: `public/config.js` points
  `PROXY_BASE` at `https://checker-account-fb.onrender.com` when running on
  `github.io`, and at the same origin otherwise.

### Render — single domain (UI + API on one URL)

The site and API run from one URL (e.g. `https://checker-account-fb.onrender.com`).

**Step 1.** Open https://dashboard.render.com and sign in (GitHub is easiest).

**Step 2.** Create the service:
- **New** → **Web Service**.
- Pick the **checker_account_fb** repo (connect GitHub if it isn't listed yet).
- **Connect**.

**Step 3.** Settings (usually filled in from `render.yaml`):
- **Name:** `checker-account-fb` (or anything).
- **Environment:** Node.
- **Build Command:** `npm install`
- **Start Command:** `npm run start`
- **Environment Variables:** add `NPPR_TOKEN` (required) and `NODE_VERSION=18`.

**Step 4.** **Create Web Service** and wait for the build/deploy (1–3 min).

**Step 5.** Open the issued URL — that single address serves both the UI and the
account checks.

**Custom domain (optional):** service card → **Settings** → **Custom Domains** →
Add, then set the CNAME/A records per Render's hints.
