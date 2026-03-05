FB Account Checker
==================

Minimal web app to validate Facebook account IDs via a Node.js proxy to `https://getuid.live/get_uid/{id}`.

Run
---

1) Install deps: `npm install`

2) Start dev server: `npm run dev`

Open: `http://localhost:3000`.

How it works
------------

- Extracts IDs by regex: `\b(10|61)[0-9A-Za-z]{10,23}\b` from pasted lines.
- For each ID calls GET `/api/get_uid/:id` (server proxies `https://getuid.live/get_uid/:id`). Response `{"uid":null}` = blocked, otherwise = valid.
- Splits results into "Валидные" and "Невалидные/Заблокированные".

Notes
-----

- Large lists are processed in batches (parallel requests, 20 at a time).

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

