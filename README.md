FB Account Checker
==================

Minimal web app to validate Facebook account IDs. Backend is a Node.js service that batches IDs and queries `https://check.fb.tools/api/check/account` (the same upstream used by the main dashboard panel).

Run
---

1) Install deps: `npm install`

2) Start dev server: `npm run dev`

Open: `http://localhost:3000`.

How it works
------------

- Extracts IDs by regex: `\b(10|61)[0-9A-Za-z]{10,23}\b` from pasted lines / cookies / social URLs.
- The frontend (`public/script.js`) calls `GET /api/get_uid/:id` per ID. The server **coalesces** concurrent requests into upstream batches of up to 50 IDs and POSTs them to `check.fb.tools`. The `{ "uid": null }` / `{ "uid": "<id>" }` response shape is preserved — the frontend keeps working unchanged.
- Splits results into "Валидные" and "Невалидные/Заблокированные".

API endpoints
-------------

- `GET /api/ping` — health check / wake-up.
- `POST /api/check/stream` — **streaming bulk check (preferred)**. Body: `{ "ids": [...] }`. Emits Server-Sent Events: `start { total, batches }` → `batch { results: [{id, valid}], done, total }` per upstream batch → `end { total, valid, invalid }`. Heartbeat comments every 15 s. The frontend uses this to draw a smooth live progress bar with no extra HTTP overhead.
- `POST /api/check` — bulk one-shot lookup. Body: `{ "ids": [...] }`. Returns `{ valid, invalid, total }`. Used as fallback if SSE is unavailable.
- `POST /api/check/extract` — extract FB IDs from arbitrary blobs (cookies / social URLs / raw lines) and validate. Body: `{ "rows": [{ id?, login?, id_soc_account?, social_url?, cookies?, line?, text? }] }`. A row is considered valid if **any** of its extracted FB IDs is valid (mirrors `AccountValidationService::checkItems` from the main panel).
- `GET /api/get_uid/:id` — single-ID lookup, kept for backward compatibility. Concurrent calls are coalesced into one upstream batch.

Notes
-----

- Upstream batches: 50 IDs per request, 2 retries with 1 s delay, 15 s timeout — matches the main panel's `Config.php` constants.
- Streaming runs up to 4 upstream batches in parallel inside one HTTP request from the browser.
- App icon: `public/favicon.svg` (animated gradient + checkmark). Apple touch icon and PWA manifest included.

Deploy (Render) — Вариант 1: всё на одном домене
------------------------------------------------

Сайт и API работают с одного URL (например `https://checker-account-fb.onrender.com`). Репозиторий уже в GitHub.

**Шаг 1.** Откройте https://dashboard.render.com и войдите (через GitHub удобнее).

**Шаг 2.** Создайте сервис:
- Нажмите **New** → **Web Service**.
- В списке репозиториев выберите **checker_account_fb** (или подключите GitHub, если репо ещё не виден).
- Нажмите **Connect**.

**Шаг 3.** Настройки (часто подставляются из `render.yaml`):
- **Name:** `checker-account-fb` (или любое).
- **Environment:** Node.
- **Build Command:** `npm install`
- **Start Command:** `npm run start`
- **Node Version:** 18 (в разделе Environment Variables добавьте `NODE_VERSION` = `18`, если есть поле).

**Шаг 4.** Нажмите **Create Web Service**. Дождитесь окончания сборки и деплоя (1–3 минуты).

**Шаг 5.** Откройте выданный URL вида `https://checker-account-fb.onrender.com` — это и есть ваш единый адрес: там и интерфейс, и проверка аккаунтов.

**Свой домен (по желанию):** В карточке сервиса → **Settings** → **Custom Domains** → Add → введите свой домен и настройте CNAME/A-записи по подсказкам Render.

Push to GitHub
--------------

```bash
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/Ivan14044/checker_account_fb.git
git push -u origin main
```

