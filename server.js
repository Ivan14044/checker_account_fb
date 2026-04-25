import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import cors from 'cors';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Локальный .env (на Render env-переменные задаются в dashboard).
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch (_) { /* ignore */ }

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ───────── NPPR Services API ─────────
// https://npprservices.pro/api/services/fbchecker
// Принимает ПОЛНЫЕ строки аккаунтов (cookies + token + ...). С checkToken:1
// верифицирует через access_token внутри строки → реальная валидация сессии.
const NPPR_URL          = 'https://npprservices.pro/api/services/fbchecker';
const NPPR_TOKEN        = process.env.NPPR_TOKEN || '';
const NPPR_BATCH_SIZE   = 50;
const NPPR_TIMEOUT_MS   = 30_000;
const NPPR_RETRY_COUNT  = 1;
const NPPR_RETRY_DELAY  = 1_500;

// SSE: сколько upstream-батчей крутится параллельно.
const STREAM_UPSTREAM_CONCURRENCY = 4;

// FB ID: 10... или 61..., далее 10–23 алфавитно-цифровых символа
const FB_ID_REGEX = /\b(?:10|61)[0-9A-Za-z]{10,23}\b/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch с таймаутом и ретраями.
async function fetchWithRetry(url, options) {
  let lastErr;
  for (let attempt = 0; attempt <= NPPR_RETRY_COUNT; attempt++) {
    if (attempt > 0) await sleep(NPPR_RETRY_DELAY);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NPPR_TIMEOUT_MS);
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

// Чанковка по уникальным строкам.
function chunkLines(lines) {
  const seen = new Set();
  const unique = [];
  for (const l of lines) {
    if (typeof l !== 'string' || !l) continue;
    if (seen.has(l)) continue;
    seen.add(l);
    unique.push(l);
  }
  const batches = [];
  for (let i = 0; i < unique.length; i += NPPR_BATCH_SIZE) {
    batches.push(unique.slice(i, i + NPPR_BATCH_SIZE));
  }
  return { unique, batches };
}

// Достаём первый FB ID из строки (для отображения в UI).
function firstFbId(line) {
  if (!line) return null;
  const m = String(line).match(FB_ID_REGEX);
  return m && m[0] ? m[0] : null;
}

// Один батч строк → NPPR → { line: 'active'|'banned'|'notFound'|'withoutToken'|'duplicate'|'error' }
async function checkOneBatch(batch, signal) {
  const result = Object.create(null);
  for (const l of batch) result[l] = 'error';

  if (!NPPR_TOKEN) {
    console.error('[NPPR] NPPR_TOKEN env var is not set');
    return result;
  }

  let resp;
  try {
    resp = await fetchWithRetry(NPPR_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        token: NPPR_TOKEN,
        accs: batch,
        checkToken: 1,
      }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.error('[NPPR] batch failed:', err?.message || err);
    return result;
  }

  let body;
  try {
    body = await resp.json();
  } catch (err) {
    console.error('[NPPR] bad json:', err?.message || err);
    return result;
  }

  // active — объект { lineString: fbId }
  if (body && body.active && typeof body.active === 'object') {
    for (const line of Object.keys(body.active)) result[line] = 'active';
  }
  // banned / notFound — массив строк
  const markArray = (arr, label) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (typeof item === 'string') {
        if (result[item] !== 'active') result[item] = label;
      }
    }
  };
  markArray(body?.banned, 'banned');
  markArray(body?.notFound, 'notFound');
  markArray(body?.duplicates, 'duplicate');
  // withoutToken — лишь информативно: ставим только если ничего другого ещё не выставлено
  if (Array.isArray(body?.withoutToken)) {
    for (const item of body.withoutToken) {
      if (typeof item === 'string' && result[item] === 'error') {
        result[item] = 'withoutToken';
      }
    }
  }

  return result;
}

// Бинарная классификация для UI: только 'active' = valid.
function isValidStatus(status) {
  return status === 'active';
}

// Массовая проверка — на вход массив строк, на выход { line: status }.
async function checkLinesBulk(lines) {
  const result = Object.create(null);
  if (!Array.isArray(lines) || lines.length === 0) return result;
  const { unique, batches } = chunkLines(lines);
  for (const l of unique) result[l] = 'error';
  await Promise.all(
    batches.map(async (batch) => {
      const part = await checkOneBatch(batch);
      for (const l of batch) result[l] = part[l] || 'error';
    })
  );
  return result;
}

// ───────── маршруты ─────────

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, time: Date.now(), upstream: 'nppr', tokenConfigured: !!NPPR_TOKEN });
});

// Совместимость со старым фронтом: один ID → один ответ.
// Под NPPR это работает в "deg мode" (без токена аккаунт уйдёт в notFound).
app.get('/api/get_uid/:id', async (req, res) => {
  const raw = String(req.params.id || '').trim();
  if (!raw) return res.status(400).json({ error: 'Missing id' });
  if (!/^(?:10|61)[0-9A-Za-z]{10,23}$/.test(raw)) {
    return res.json({ uid: null });
  }
  try {
    const map = await checkLinesBulk([raw]);
    res.json({ uid: isValidStatus(map[raw]) ? raw : null });
  } catch (err) {
    res.status(500).json({ error: 'Check failed', details: String(err) });
  }
});

// Массовая проверка.
// POST { lines: [...full account strings...] }  ← основной режим
//   или { ids: [...] }                          ← legacy
// → { valid: [...lines], invalid: [...lines], total, breakdown: {active,banned,notFound,withoutToken,duplicate,error} }
app.post('/api/check', async (req, res) => {
  const body = req.body || {};
  const rawInput = Array.isArray(body.lines) ? body.lines
                  : Array.isArray(body.ids)  ? body.ids
                  : [];
  const lines = rawInput.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (lines.length === 0) {
    return res.json({ valid: [], invalid: [], total: 0, breakdown: {} });
  }
  try {
    const map = await checkLinesBulk(lines);
    const valid = [];
    const invalid = [];
    const breakdown = { active: 0, banned: 0, notFound: 0, withoutToken: 0, duplicate: 0, error: 0 };
    for (const line of lines) {
      const status = map[line] || 'error';
      if (breakdown[status] !== undefined) breakdown[status]++;
      if (isValidStatus(status)) valid.push(line);
      else invalid.push(line);
    }
    res.json({ valid, invalid, total: lines.length, breakdown });
  } catch (err) {
    res.status(500).json({ error: 'Check failed', details: String(err) });
  }
});

// SSE-стрим. POST { lines: [...] } (или { ids: [...] }).
// Events:
//   start  { total, batches }
//   batch  { results: [{line, id, valid, status}, ...], done, total }
//   end    { total, valid, invalid, breakdown }
//   error  { message }
app.post('/api/check/stream', async (req, res) => {
  const body = req.body || {};
  const rawInput = Array.isArray(body.lines) ? body.lines
                  : Array.isArray(body.ids)  ? body.ids
                  : [];
  const lines = rawInput.map((x) => String(x ?? '').trim()).filter(Boolean);
  const { unique, batches } = chunkLines(lines);

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);

  const ctrl = new AbortController();
  let cancelled = false;
  const onClose = () => {
    cancelled = true;
    ctrl.abort();
    clearInterval(heartbeat);
  };
  // close на ServerResponse — req.on('close') в современном Node стреляет
  // сразу после полного чтения тела, а не при разрыве соединения.
  res.on('close', onClose);

  send('start', { total: unique.length, batches: batches.length });
  if (unique.length === 0) {
    send('end', { total: 0, valid: 0, invalid: 0, breakdown: {} });
    clearInterval(heartbeat);
    return res.end();
  }

  let done = 0;
  let validCount = 0;
  let invalidCount = 0;
  const breakdown = { active: 0, banned: 0, notFound: 0, withoutToken: 0, duplicate: 0, error: 0 };

  let nextBatch = 0;
  async function worker() {
    while (!cancelled && nextBatch < batches.length) {
      const idx = nextBatch++;
      const batch = batches[idx];
      let part;
      try {
        part = await checkOneBatch(batch, ctrl.signal);
      } catch (err) {
        if (cancelled || err?.name === 'AbortError') return;
        part = Object.create(null);
        for (const line of batch) part[line] = 'error';
      }
      if (cancelled) return;

      const results = batch.map((line) => {
        const status = part[line] || 'error';
        const valid = isValidStatus(status);
        if (valid) validCount++; else invalidCount++;
        if (breakdown[status] !== undefined) breakdown[status]++;
        return { line, id: firstFbId(line), valid, status };
      });
      done += batch.length;
      send('batch', { results, done, total: unique.length });
    }
  }

  try {
    const workers = Array.from(
      { length: Math.min(STREAM_UPSTREAM_CONCURRENCY, batches.length) },
      () => worker()
    );
    await Promise.all(workers);
    if (!cancelled) {
      send('end', { total: unique.length, valid: validCount, invalid: invalidCount, breakdown });
    }
  } catch (err) {
    send('error', { message: String(err?.message || err) });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (!NPPR_TOKEN) console.warn('[NPPR] WARNING: NPPR_TOKEN env var is not set — checks will fail');
});
