const inputEl = document.getElementById('input');
const validEl = document.getElementById('valid');
const invalidEl = document.getElementById('invalid');
const dupesEl = document.getElementById('dupes');
const checkBtn = document.getElementById('checkBtn');
const statsEl = document.getElementById('stats');
const preloader = document.getElementById('preloader');
const errorEl = document.getElementById('error');
const toastEl = document.getElementById('toast');
const langButtons = document.querySelectorAll('.lang-btn');

// ID regex: accounts start with 10 or 61 followed by 10-23 alnum chars
const idRegex = /(\b(?:10|61)[0-9A-Za-z]{10,23}\b)/g;

function uniquePreserveOrder(items){
  const seen = new Set();
  const out = [];
  for(const it of items){
    if(!seen.has(it)){
      seen.add(it);
      out.push(it);
    }
  }
  return out;
}

// Возвращает структуру с соответствием ID → исходные строки
function extractIdsFromLines(text){
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [];
  const idToLines = new Map();
  for(const line of lines){
    // Берём только ПЕРВЫЙ ID на строку, даже если совпадений несколько
    const firstMatch = line.match(idRegex);
    if(firstMatch && firstMatch.length > 0){
      const id = firstMatch[0];
      entries.push({ id, line });
      if(!idToLines.has(id)) idToLines.set(id, []);
      idToLines.get(id).push(line);
    }
  }
  const ids = uniquePreserveOrder(entries.map(e => e.id));
  return { entries, ids, idToLines };
}

async function checkIds(ids){
  if(ids.length === 0){
    return { valid: [], blocked: [] };
  }

  // Warm-up ping to wake Render free instance, with retries
  const base = (window.PROXY_BASE || '').replace(/\/$/, '');
  try{
    statsEl.textContent = (showToast.messages || I18N[detectLang()]).waking || 'Waking server...';
    await warmUp(`${base}/api/ping`);
  }catch(_e){ /* ignore, request below will surface error */ }

  // The remote API accepts an array in "inputData".
  const payload = { inputData: ids, checkFriends: false, userLang: 'en' };

  const url = `${base}/api/check/account`;
  const text = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }, 4, 12000); // up to ~36s with backoff

  // Heuristic parsing: we expect per-line statuses or a JSON string.
  // Try JSON first; if it fails, fall back to searching by status tokens.
  try{
    const json = JSON.parse(text);
    // Expect something like an array of items containing status and id
    const valid = [];
    const blocked = [];
    const items = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
    for(const item of items){
      const id = String(item.id ?? item.accountId ?? '').trim();
      const statusRaw = String(item.status ?? item.state ?? item.result ?? '').toLowerCase();
      const status = statusRaw.trim();
      if(id){
        // приоритет на невалидные
        if(/\binvalid\b/.test(status) || /\bblock(ed)?\b/.test(status) || status.includes('заблок')) blocked.push(id);
        else if(/\bvalid\b/.test(status) || status.includes('актив')) valid.push(id);
      }
    }
    if(valid.length + blocked.length > 0){
      return { valid, blocked };
    }
  }catch(_e){ /* not JSON, continue */ }

  // Fallback: match "valid/Активный" and "Blocked/Заблокирован" alongside IDs in the text
  const lower = text.toLowerCase();
  const foundIds = Array.from(text.matchAll(idRegex)).map(m => m[1]);
  const mapped = { valid: [], blocked: [] };
  for(const id of foundIds){
    const idx = text.indexOf(id);
    const windowText = lower.slice(Math.max(0, idx - 80), idx + 80);
    // сначала ищем явные признаки невалидности
    if(/\binvalid\b/.test(windowText) || /\bblocked?\b/.test(windowText) || windowText.includes('заблок')) {
      mapped.blocked.push(id);
    } else if(/\bvalid\b/.test(windowText) || windowText.includes('актив')) {
      mapped.valid.push(id);
    }
  }
  return mapped;
}

async function warmUp(pingUrl){
  const attempts = 5;
  let lastErr;
  for(let i=0;i<attempts;i++){
    try{
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(pingUrl, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if(r.ok) return;
    }catch(err){ lastErr = err; }
    await new Promise(res => setTimeout(res, 1000 * (i + 1)));
  }
  if(lastErr) throw lastErr;
}

async function fetchWithRetry(url, options, attempts = 3, timeoutMs = 10000){
  let lastErr;
  for(let i=0;i<attempts;i++){
    try{
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const resp = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(t);
      if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    }catch(err){
      lastErr = err;
      // backoff
      await new Promise(res => setTimeout(res, 1000 * Math.pow(2, i)));
    }
  }
  throw lastErr || new Error('NetworkError');
}

checkBtn.addEventListener('click', async () => {
  const { ids, idToLines } = extractIdsFromLines(inputEl.value);
  validEl.value = '';
  invalidEl.value = '';
  if(dupesEl) dupesEl.value = '';
  statsEl.textContent = `Найдено ID: ${ids.length}`;
  if(ids.length === 0) return;

  checkBtn.disabled = true;
  checkBtn.classList.add('onclic');
  if(preloader) preloader.classList.remove('hidden');
  statsEl.textContent = 'Проверка...';
  try{
    // If there are a lot, process in chunks to keep payload reasonable
    const chunkSize = 100;
    const allValid = [];
    const allBlocked = [];
    for(let i=0;i<ids.length;i+=chunkSize){
      const slice = ids.slice(i, i + chunkSize);
      const { valid, blocked } = await checkIds(slice);
      allValid.push(...valid);
      allBlocked.push(...blocked);
      statsEl.textContent = `Готово: ${Math.min(i + chunkSize, ids.length)}/${ids.length}`;
    }
    const uniqueValid = uniquePreserveOrder(allValid);
    const uniqueBlocked = uniquePreserveOrder(allBlocked);
    // Разворачиваем ID в исходные строки
    const validLines = [];
    const blockedLines = [];
    const dupLines = [];
    for(const id of uniqueValid){
      const arr = idToLines.get(id) || [];
      if(arr.length >= 1){
        // первая строка идёт в «Валидные»
        validLines.push(arr[0]);
        // остальные строки идут как дубли
        if(arr.length > 1){ dupLines.push(...arr.slice(1)); }
      }
    }
    for(const id of uniqueBlocked){
      const arr = idToLines.get(id) || [];
      if(arr.length >= 1){
        blockedLines.push(arr[0]);
        if(arr.length > 1){ dupLines.push(...arr.slice(1)); }
      }
    }
    validEl.value = validLines.join('\n');
    invalidEl.value = blockedLines.join('\n');
    if(dupesEl) dupesEl.value = dupLines.join('\n');
    const total = uniqueValid.length + uniqueBlocked.length;
    const pv = total ? Math.round((uniqueValid.length / total) * 1000) / 10 : 0;
    const pb = total ? Math.round((uniqueBlocked.length / total) * 1000) / 10 : 0;
    const dupCount = dupLines.length;
    const dupInfo = dupCount ? `, дубли строк: ${dupCount}` : '';
    const dict = showToast.messages || I18N[detectLang()];
    statsEl.innerHTML = `<span class=\"summary\">${dict.summaryPrefix} <span class=\"ok\">${dict.validWord}: ${uniqueValid.length} (${pv}%)</span>, <span class=\"bad\">${dict.blockedWord}: ${uniqueBlocked.length} (${pb}%)</span>${dupInfo}</span>`;
    const resultsBlock = document.getElementById('results');
    if(resultsBlock) resultsBlock.classList.remove('hidden');
  }catch(err){
    const dict = showToast.messages || I18N[detectLang()];
    statsEl.textContent = (dict.networkError || 'Network error') + ': ' + String(err);
    if(errorEl){
      errorEl.textContent = (dict.networkError || 'Network error') + ': ' + String(err);
      errorEl.classList.remove('hidden');
    }
  }finally{
    checkBtn.disabled = false;
    checkBtn.classList.remove('onclic');
    checkBtn.classList.add('validate');
    setTimeout(() => checkBtn.classList.remove('validate'), 1200);
    if(preloader) preloader.classList.add('hidden');
  }
});

// Показывать количество строк и число найденных ID при вводе/вставке
function updateInputStats(){
  const linesCount = inputEl.value.split(/\r?\n/).filter(l => l.trim().length > 0).length;
  const { ids } = extractIdsFromLines(inputEl.value);
  const idsCount = ids.length;
  statsEl.textContent = `Строк: ${linesCount}, найдено ID: ${idsCount}`;
}

inputEl.addEventListener('input', updateInputStats);
window.addEventListener('DOMContentLoaded', updateInputStats);
// Скрыть прелоадер после полной загрузки интерфейса
window.addEventListener('load', () => { if(preloader) preloader.classList.add('hidden'); });

// Guidance for GitHub Pages if backend is not configured
try{
  const isGhPages = /github\.io$/.test(location.hostname);
  if(isGhPages && (!window.PROXY_BASE || window.PROXY_BASE === '')){
    if(errorEl){
      errorEl.textContent = 'Для GitHub Pages укажите URL backend-прокси в public/config.js (window.PROXY_BASE).';
      errorEl.classList.remove('hidden');
    }
  }
}catch(_){ }

// Не смещать прокрутку вправо при вставке/вводе — всегда показывать начало строк
function keepStartVisible(el){
  el.scrollLeft = 0;
}
inputEl.addEventListener('input', () => keepStartVisible(inputEl));
inputEl.addEventListener('paste', () => setTimeout(() => keepStartVisible(inputEl), 0));
inputEl.addEventListener('keyup', () => keepStartVisible(inputEl));

// Копирование/Сохранение
function getFieldById(id){ return document.getElementById(id); }
function copyField(id){
  const el = getFieldById(id);
  if(!el) return;
  navigator.clipboard.writeText(el.value || '').then(() => {
    const dict = showToast.messages || I18N[detectLang()];
    showToast(dict.copied, 'success');
  }).catch(() => {
    showToast('Clipboard error', 'info');
  });
}
function saveField(id){
  const el = getFieldById(id);
  if(!el) return;
  const blob = new Blob([el.value || ''], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = id + '.txt';
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(a.href);
  a.remove();
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if(!btn) return;
  const action = btn.getAttribute('data-action');
  const target = btn.getAttribute('data-target');
  if(action === 'copy') copyField(target);
  if(action === 'save') saveField(target);
});

// Очистить всё
const clearAllBtn = document.getElementById('clearAll');
if(clearAllBtn){
  clearAllBtn.addEventListener('click', () => {
    inputEl.value = '';
    validEl.value = '';
    invalidEl.value = '';
    if(dupesEl) dupesEl.value = '';
    statsEl.textContent = '';
    if(errorEl) { errorEl.textContent = ''; errorEl.classList.add('hidden'); }
    const resultsBlock = document.getElementById('results');
    if(resultsBlock) resultsBlock.classList.add('hidden');
    updateInputStats();
    keepStartVisible(inputEl);
    const dict = showToast.messages || I18N[detectLang()];
    showToast(dict.cleared, 'info');
  });
}

// Тема: сохранение и переключение
// Тема: только светлая, без переключения
document.documentElement.setAttribute('data-theme', 'light');

// Toast helper
let toastTimer;
function showToast(message, variant){
  if(!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.remove('success','info');
  if(variant){ toastEl.classList.add(variant); }
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

// i18n
const I18N = {
  ru: {
    heroTitle: 'Чекер аккаунтов Facebook',
    heroP1: 'Этот инструмент позволяет быстро проверить состояние ваших Facebook‑аккаунтов.',
    heroP2: 'Вставьте список аккаунтов в поле ввода и нажмите кнопку «Проверить аккаунты». Система определит, какие аккаунты активны, заблокированы или требуют подтверждения.',
    inputLabel: 'Вставьте строки (по одной на строке):',
    checkBtn: 'Проверить аккаунты',
    clearBtn: 'Очистить всё',
    validLabel: 'Валидные',
    invalidLabel: 'Невалидные/Заблокированные',
    dupesLabel: 'Дубли (ID повторяются)',
    copied: 'Скопировано в буфер обмена',
    cleared: 'Очищено',
    summaryPrefix: 'Итог —',
    validWord: 'валидных',
    blockedWord: 'заблокировано',
    waking: 'Пробуждение сервера…',
    networkError: 'Сетевой сбой. Попробуйте ещё раз'
  },
  uk: {
    heroTitle: 'Чекер акаунтів Facebook',
    heroP1: 'Інструмент для швидкої перевірки стану ваших акаунтів Facebook.',
    heroP2: 'Вставте список акаунтів у поле та натисніть «Перевірити акаунти». Система визначить, які акаунти активні, заблоковані або потребують підтвердження.',
    inputLabel: 'Вставте рядки (по одному на рядок):',
    checkBtn: 'Перевірити акаунти',
    clearBtn: 'Очистити все',
    validLabel: 'Валідні',
    invalidLabel: 'Невалідні/Заблоковані',
    dupesLabel: 'Дублі (ID повторюються)',
    copied: 'Скопійовано у буфер',
    cleared: 'Очищено',
    summaryPrefix: 'Підсумок —',
    validWord: 'валідних',
    blockedWord: 'заблоковано',
    waking: 'Пробудження сервера…',
    networkError: 'Помилка мережі. Спробуйте ще раз'
  },
  en: {
    heroTitle: 'Facebook Accounts Checker',
    heroP1: 'A tool to quickly check the status of your Facebook accounts.',
    heroP2: 'Paste the list of accounts and click “Check accounts”. The system will detect which are active, blocked or require verification.',
    inputLabel: 'Paste lines (one per line):',
    checkBtn: 'Check accounts',
    clearBtn: 'Clear all',
    validLabel: 'Valid',
    invalidLabel: 'Invalid/Blocked',
    dupesLabel: 'Duplicates (IDs repeated)',
    copied: 'Copied to clipboard',
    cleared: 'Cleared',
    summaryPrefix: 'Summary —',
    validWord: 'valid',
    blockedWord: 'blocked',
    waking: 'Warming up server…',
    networkError: 'Network error. Please retry'
  }
};

function detectLang(){
  try{
    const saved = localStorage.getItem('lang');
    if(saved && I18N[saved]) return saved;
  }catch(_){ }
  const nav = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
  if(nav.startsWith('ru')) return 'ru';
  if(nav.startsWith('uk') || nav.startsWith('ua')) return 'uk';
  return 'en';
}

function applyLang(lang){
  const dict = I18N[lang] || I18N.en;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if(dict[key]) el.textContent = dict[key];
  });
  // update toasts messages references
  showToast.messages = dict;
  // update active button
  langButtons.forEach(b => b.classList.toggle('active', b.getAttribute('data-lang') === lang));
  try{ localStorage.setItem('lang', lang); }catch(_){ }
}

langButtons.forEach(btn => btn.addEventListener('click', () => applyLang(btn.getAttribute('data-lang'))));

const initialLang = detectLang();
applyLang(initialLang);


