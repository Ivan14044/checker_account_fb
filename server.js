import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ───────── Конфиг (повторяет includes/Config.php основной панели) ─────────
const FB_CHECK_URL         = 'https://check.fb.tools/api/check/account';
const FB_CHECK_TIMEOUT_MS  = 15_000;
const FB_CHECK_CONNECT_MS  = 5_000;
const FB_CHECK_BATCH_SIZE  = 50;
const FB_CHECK_RETRY_COUNT = 2;
const FB_CHECK_RETRY_DELAY = 1_000;

// FB ID: 10... или 61..., далее 10–23 алфавитно-цифровых символа
const FB_ID_REGEX = /\b(?:10|61)[0-9A-Za-z]{10,23}\b/g;

// Окно склейки одиночных GET /api/get_uid/:id в один upstream POST
const COALESCE_WINDOW_MS = 50;
const COALESCE_MAX_BATCH = FB_CHECK_BATCH_SIZE;

// ───────── утилиты ─────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Извлечение FB ID из произвольного блоба (cookies / social_url / login и т.п.).
// Аналог AccountValidationService::extractFbIds.
function extractFbIds(input) {
  if (!input) return [];
  const text = Array.isArray(input) ? input.filter(Boolean).join('\n') : String(input);
  const seen = new Set();
  for (const m of text.matchAll(FB_ID_REGEX)) seen.add(m[0]);
  return [...seen];
}

// fetch с таймаутом и ретраями. Аналог логики в AccountValidationService::runParallel.
async function fetchWithRetry(url, options) {
  let lastErr;
  for (let attempt = 0; attempt <= FB_CHECK_RETRY_COUNT; attempt++) {
    if (attempt > 0) await sleep(FB_CHECK_RETRY_DELAY);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FB_CHECK_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) {
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }
      return resp;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr || new Error('upstream request failed');
}

// Массовая проверка через check.fb.tools. На вход — массив FB ID.
// На выход — { id: true|false }. Аналог AccountValidationService::checkFbIdsBulk.
async function checkFbIdsBulk(fbIds) {
  const result = Object.create(null);
  if (!Array.isArray(fbIds) || fbIds.length === 0) return result;

  const unique = [...new Set(fbIds.map(String).filter(Boolean))];
  for (const id of unique) result[id] = false;

  const batches = [];
  for (let i = 0; i < unique.length; i += FB_CHECK_BATCH_SIZE) {
    batches.push(unique.slice(i, i + FB_CHECK_BATCH_SIZE));
  }

  // Параллельно (эквивалент curl_multi на PHP).
  await Promise.all(
    batches.map(async (batch) => {
      let resp;
      try {
        resp = await fetchWithRetry(FB_CHECK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            inputData: batch,
            checkFriends: false,
            userLang: 'ru',
          }),
        });
      } catch (err) {
        console.error('[check.fb.tools] batch failed:', err?.message || err);
        return;
      }
      let body;
      try {
        body = await resp.json();
      } catch (err) {
        console.error('[check.fb.tools] bad json:', err?.message || err);
        return;
      }
      if (!body || !Array.isArray(body.data)) return;
      for (const entry of body.data) {
        const acc = String(entry?.account ?? '');
        const status = String(entry?.status?.name ?? '');
        if (acc) result[acc] = status === 'valid';
      }
    })
  );

  return result;
}

// ───────── склейка одиночных запросов ─────────
// 25 параллельных GET /api/get_uid/:id от фронта склеиваются в один POST на check.fb.tools.
const pending = new Map(); // id -> Array<(valid:boolean) => void>
let flushTimer = null;
let flushing = false;

async function flushBatch() {
  flushTimer = null;
  if (flushing) return;
  flushing = true;
  try {
    while (pending.size > 0) {
      const slice = [...pending.entries()].slice(0, COALESCE_MAX_BATCH);
      const ids = slice.map(([id]) => id);
      const waiters = slice.map(([, w]) => w);
      for (const id of ids) pending.delete(id);

      let map = {};
      try {
        map = await checkFbIdsBulk(ids);
      } catch (err) {
        console.error('[coalescer] checkFbIdsBulk failed:', err?.message || err);
      }

      ids.forEach((id, i) => {
        const valid = map[id] === true;
        for (const resolve of waiters[i]) resolve(valid);
      });
    }
  } finally {
    flushing = false;
  }
}

function scheduleLookup(id) {
  return new Promise((resolve) => {
    let waiters = pending.get(id);
    if (!waiters) {
      waiters = [];
      pending.set(id, waiters);
    }
    waiters.push(resolve);

    if (pending.size >= COALESCE_MAX_BATCH) {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flushBatch();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushBatch, COALESCE_WINDOW_MS);
    }
  });
}

// ───────── маршруты ─────────

// Health check / wake-up. Контракт сохранён.
app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// Обратная совместимость со старым фронтом public/script.js.
// Внутри: больше НЕ ходим на getuid.live — склеиваем параллельные запросы
// в один POST на check.fb.tools (как в основной панели).
// Фронт ждёт JSON со свойством `uid`: `uid !== null` => валидный.
app.get('/api/get_uid/:id', async (req, res) => {
  const raw = String(req.params.id || '').trim();
  if (!raw) return res.status(400).json({ error: 'Missing id' });
  // отсекаем мусор, не отправляя его наверх
  if (!/^(?:10|61)[0-9A-Za-z]{10,23}$/.test(raw)) {
    return res.json({ uid: null });
  }
  try {
    const valid = await scheduleLookup(raw);
    res.json({ uid: valid ? raw : null });
  } catch (err) {
    res.status(500).json({ error: 'Check failed', details: String(err) });
  }
});

// Массовая проверка по списку FB ID. Аналог /api/accounts/validate/check.
// POST { ids: ["10...", "61...", ...] }
// → { valid: [...], invalid: [...], total }
app.post('/api/check', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x) => String(x).trim()) : [];
  const filtered = ids.filter((id) => /^(?:10|61)[0-9A-Za-z]{10,23}$/.test(id));
  if (filtered.length === 0) {
    return res.json({ valid: [], invalid: [], total: 0 });
  }
  try {
    const map = await checkFbIdsBulk(filtered);
    const valid = [];
    const invalid = [];
    for (const id of filtered) {
      if (map[id] === true) valid.push(id);
      else invalid.push(id);
    }
    res.json({ valid, invalid, total: filtered.length });
  } catch (err) {
    res.status(500).json({ error: 'Check failed', details: String(err) });
  }
});

// Парсинг произвольных данных (cookies / social_url / любые поля) и проверка.
// Аналог AccountValidationService::prepareItems + checkItems из основной панели.
//
// POST { rows: [{ id?, login?, id_soc_account?, social_url?, cookies?, line?, text? }, ...] }
// → {
//     items:   [{ index, id, login, fb_ids: [...] }],
//     skipped: [{ index, id, login }],            // строки без FB ID
//     valid:   [{ ...item }],                     // хотя бы один FB ID валиден
//     invalid: [{ ...item }],                     // все FB ID невалидны
//     total
//   }
app.post('/api/check/extract', async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length === 0) {
    return res.json({ items: [], skipped: [], valid: [], invalid: [], total: 0 });
  }

  const items = [];
  const skipped = [];
  const allIds = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? {};
    const sources = [
      row.id_soc_account,
      row.social_url,
      row.cookies,
      row.line,
      row.text,
    ];
    const ids = extractFbIds(sources);
    if (ids.length === 0) {
      skipped.push({ index: i, id: row.id ?? null, login: row.login ?? null });
      continue;
    }
    items.push({
      index: i,
      id: row.id ?? null,
      login: row.login ?? null,
      fb_ids: ids,
    });
    for (const id of ids) allIds.add(id);
  }

  let map = {};
  try {
    map = await checkFbIdsBulk([...allIds]);
  } catch (err) {
    return res.status(500).json({ error: 'Check failed', details: String(err) });
  }

  const valid = [];
  const invalid = [];
  for (const item of items) {
    const isValid = item.fb_ids.some((id) => map[id] === true);
    (isValid ? valid : invalid).push(item);
  }

  res.json({
    items,
    skipped,
    valid,
    invalid,
    total: items.length,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
