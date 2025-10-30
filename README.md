FB Account Checker
==================

Minimal web app to validate Facebook account IDs via a Node.js proxy to `https://check.fb.tools/api/check/account`.

Run
---

1) Install deps: `npm install`

2) Start dev server: `npm run dev`

Open: `http://localhost:3000`.

How it works
------------

- Extracts IDs by regex: `\b(10|61)[0-9A-Za-z]{10,23}\b` from pasted lines.
- Sends `{ inputData: [ids], checkFriends: false, userLang: 'en' }` to `/api/check/account` (server proxies the external API).
- Splits results into "Валидные" and "Невалидные/Заблокированные".

Notes
-----

- Large lists are processed in chunks of 100 IDs per request.

Deploy (Render)
---------------

Option A — One-click via dashboard:

1) Push this project to your GitHub (see commands below).
2) Go to Render (`https://dashboard.render.com`) → New → Web Service.
3) Connect the repo.
4) Settings:
   - Environment: Node
   - Build Command: `npm install`
   - Start Command: `npm run start`
   - Node Version: 18
5) Create Web Service → wait for deploy → open the URL.

Option B — render.yaml:

Render reads `render.yaml` and sets everything for you. On Render, choose "Blueprint" and point to this repo.

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

