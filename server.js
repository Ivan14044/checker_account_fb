import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import cors from 'cors';
import fs from 'fs';
import crypto from 'crypto';
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
app.set('trust proxy', 1); // за прокси Render — чтобы req.ip был реальным

// CORS: по умолчанию закрыт фиксированным allowlist прод-доменов (фронт на
// GitHub Pages + сам Render-домен). Переопределяется env ALLOWED_ORIGINS
// (через запятую). Запросы без Origin (curl/сервер-сервер) и localhost (dev)
// разрешены всегда.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://ivan14044.github.io',
  'https://checker-account-fb.onrender.com',
];
const ENV_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = ENV_ALLOWED_ORIGINS.length ? ENV_ALLOWED_ORIGINS : DEFAULT_ALLOWED_ORIGINS;
function isOriginAllowed(origin) {
  if (!origin) return true;                                                       // curl / server-to-server
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;  // локальная разработка
  return ALLOWED_ORIGINS.includes(origin);
}
app.use(cors({
  origin(origin, cb) { cb(null, isOriginAllowed(origin)); },
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ───────── простой in-memory rate-limit (без зависимостей) ─────────
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_LIMIT_MAX       = Number(process.env.RATE_LIMIT_MAX) || 60;
const rateHits = new Map(); // ip → number[] (таймстемпы запросов в окне)
function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || 'unknown';
  const arr = (rateHits.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX) {
    res.set('Retry-After', String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Too many requests' });
  }
  arr.push(now);
  rateHits.set(ip, arr);
  next();
}
// периодическая чистка устаревших записей, чтобы Map не рос бесконечно
const rateSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of rateHits) {
    const fresh = arr.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length) rateHits.set(ip, fresh); else rateHits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS);
rateSweep.unref?.();

// ───────── Checker upstream (check.fb.tools) ─────────
// Публичный, без авторизации. Принимает массив строк (FBID / profile URL /
// cookies) в поле inputData и возвращает по каждой строке статус живости.
// Ответ: { data: [{ id, account, uid, status:{name,message}, origin, profileLink }],
//          info: { valid, invalid, errors, noExist, checkedTime } }
const CHECK_URL         = process.env.CHECK_URL || 'https://check.fb.tools/api/check/facebook';
const CHECK_BATCH_SIZE  = 50;
const CHECK_TIMEOUT_MS  = 30_000;
const CHECK_RETRY_COUNT = 1;
const CHECK_RETRY_DELAY = 1_500;

// SSE: сколько upstream-батчей крутится параллельно.
const STREAM_UPSTREAM_CONCURRENCY = 4;

// FB ID: 10... или 61..., далее 10–23 алфавитно-цифровых символа
const FB_ID_REGEX = /\b(?:10|61)[0-9A-Za-z]{10,23}\b/g;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch с таймаутом и ретраями.
async function fetchWithRetry(url, options) {
  let lastErr;
  for (let attempt = 0; attempt <= CHECK_RETRY_COUNT; attempt++) {
    if (attempt > 0) await sleep(CHECK_RETRY_DELAY);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
    // если снаружи пришёл свой signal — пробрасываем abort
    const onOuterAbort = () => ctrl.abort();
    if (options?.signal) {
      if (options.signal.aborted) ctrl.abort();
      else options.signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    try {
      const resp = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      if (options?.signal) options.signal.removeEventListener?.('abort', onOuterAbort);
      if (!resp.ok) {
        lastErr = new Error(`HTTP ${resp.status}`);
        continue;
      }
      return resp;
    } catch (err) {
      clearTimeout(timer);
      if (options?.signal) options.signal.removeEventListener?.('abort', onOuterAbort);
      // внешняя отмена — не ретраим
      if (options?.signal?.aborted) throw err;
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
  for (let i = 0; i < unique.length; i += CHECK_BATCH_SIZE) {
    batches.push(unique.slice(i, i + CHECK_BATCH_SIZE));
  }
  return { unique, batches };
}

// Достаём первый FB ID из строки (для отображения в UI).
function firstFbId(line) {
  if (!line) return null;
  const m = String(line).match(FB_ID_REGEX);
  return m && m[0] ? m[0] : null;
}

// Один батч строк → check.fb.tools → { line: { status, uid, profileLink } }
// status ∈ 'valid'|'invalid'|'noexist'|'error'.
async function checkOneBatch(batch, signal) {
  const result = Object.create(null);
  for (const l of batch) result[l] = { status: 'error', uid: null, profileLink: null };

  let resp;
  try {
    resp = await fetchWithRetry(CHECK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ inputData: batch }),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.error('[check] batch failed:', err?.message || err);
    return result;
  }

  let body;
  try {
    body = await resp.json();
  } catch (err) {
    console.error('[check] bad json:', err?.message || err);
    return result;
  }

  // data — массив { account, uid, status:{name}, origin, profileLink, ... }.
  // origin == исходная строка, которую мы отправили (для URL/cookies отличается
  // от account/uid); по нему и маппим, с откатом на account.
  if (body && Array.isArray(body.data)) {
    for (const item of body.data) {
      const key = (typeof item?.origin === 'string') ? item.origin
                : (typeof item?.account === 'string') ? item.account
                : null;
      if (key !== null && result[key] !== undefined) {
        result[key] = {
          status: item?.status?.name || 'error',
          uid: typeof item?.uid === 'string' ? item.uid
             : typeof item?.account === 'string' ? item.account : null,
          profileLink: typeof item?.profileLink === 'string' ? item.profileLink : null,
        };
      }
    }
  }

  return result;
}

// Бинарная классификация для UI: только 'valid' = valid.
function isValidStatus(status) {
  return status === 'valid';
}

function emptyBreakdown() {
  return { valid: 0, invalid: 0, noexist: 0, error: 0 };
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
      for (const l of batch) result[l] = part[l]?.status || 'error';
    })
  );
  return result;
}

// ───────── TOTP (RFC 6238) для 2FA-генератора ─────────
// Base32-secret → 6-значный код. Без внешних зависимостей (node:crypto).
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  if (!clean) throw new Error('empty secret');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if (bytes.length === 0) throw new Error('empty secret');
  return Buffer.from(bytes);
}

function generateTOTP(secret, { digits = 6, period = 30, timestamp = Date.now() } = {}) {
  const key = base32Decode(secret);
  const epoch = Math.floor(timestamp / 1000);
  let counter = Math.floor(epoch / period);
  const buf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  const otp = String(code % 10 ** digits).padStart(digits, '0');
  const timeRemaining = period - (epoch % period);
  return { otp, timeRemaining };
}

// ───────── маршруты ─────────

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, time: Date.now(), upstream: 'check.fb.tools' });
});

// 2FA: GET /api/otp/:secret → { ok, data:{ otp, timeRemaining } }
app.get('/api/otp/:secret', rateLimit, (req, res) => {
  const secret = String(req.params.secret || '').trim();
  if (!secret) return res.status(400).json({ ok: false, message: 'Missing secret' });
  try {
    const { otp, timeRemaining } = generateTOTP(secret);
    res.json({ ok: true, data: { otp, timeRemaining } });
  } catch (_err) {
    res.status(400).json({ ok: false, message: 'Invalid secret' });
  }
});

// Совместимость со старым фронтом: один ID → один ответ.
app.get('/api/get_uid/:id', rateLimit, async (req, res) => {
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
// → { valid: [...lines], invalid: [...lines], total, breakdown:{valid,invalid,noexist,error} }
app.post('/api/check', rateLimit, async (req, res) => {
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
    const breakdown = emptyBreakdown();
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
//   batch  { results: [{line, id, uid, profileLink, valid, status}, ...], done, total }
//   end    { total, valid, invalid, breakdown }
//   error  { message }
app.post('/api/check/stream', rateLimit, async (req, res) => {
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
  const breakdown = emptyBreakdown();

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
        for (const line of batch) part[line] = { status: 'error', uid: null, profileLink: null };
      }
      if (cancelled) return;

      const results = batch.map((line) => {
        const meta = part[line] || { status: 'error', uid: null, profileLink: null };
        const status = meta.status || 'error';
        const valid = isValidStatus(status);
        if (valid) validCount++; else invalidCount++;
        if (breakdown[status] !== undefined) breakdown[status]++;
        return {
          line,
          id: meta.uid || firstFbId(line),
          uid: meta.uid || null,
          profileLink: meta.profileLink || null,
          valid,
          status,
        };
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
  console.log(`[check] upstream: ${CHECK_URL}`);
});
