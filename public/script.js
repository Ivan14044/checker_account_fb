const inputEl = document.getElementById('input');
const validEl = document.getElementById('valid');
const invalidEl = document.getElementById('invalid');
const dupesEl = document.getElementById('dupes');
const checkBtn = document.getElementById('checkBtn');
const statsEl = document.getElementById('stats');
const preloader = document.getElementById('preloader');
const errorEl = document.getElementById('error');
const toastEl = document.getElementById('toast');

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
    await warmUp(`${base}/api/ping`);
  }catch(_e){ /* ignore, request below will surface error */ }

  // The remote API accepts an array in "inputData".
  const payload = { inputData: ids, checkFriends: false, userLang: 'en' };

  const url = `${base}/api/check/account`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const text = await response.text();

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
  const attempts = 3;
  let lastErr;
  for(let i=0;i<attempts;i++){
    try{
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3500);
      const r = await fetch(pingUrl, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if(r.ok) return;
    }catch(err){ lastErr = err; }
    await new Promise(res => setTimeout(res, 800 * (i + 1)));
  }
  if(lastErr) throw lastErr;
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
    statsEl.innerHTML = `Итог — <span class=\"ok\">валидных: ${uniqueValid.length} (${pv}%)</span>, <span class=\"bad\">заблокировано: ${uniqueBlocked.length} (${pb}%)</span>${dupInfo}`;
    const resultsBlock = document.getElementById('results');
    if(resultsBlock) resultsBlock.classList.remove('hidden');
  }catch(err){
    statsEl.textContent = 'Ошибка проверки: ' + String(err);
    if(errorEl){
      errorEl.textContent = 'Ошибка: ' + String(err);
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
    showToast('Скопировано в буфер обмена', 'success');
  }).catch(() => {
    showToast('Не удалось скопировать', 'info');
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
    showToast('Очищено', 'info');
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


