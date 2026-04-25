const inputEl      = document.getElementById('input');
const validEl      = document.getElementById('valid');
const invalidEl    = document.getElementById('invalid');
const dupesEl      = document.getElementById('dupes');
const checkBtn     = document.getElementById('checkBtn');
const stopBtn      = document.getElementById('stopBtn');
const statsEl      = document.getElementById('stats');
const preloader    = document.getElementById('preloader');
const errorEl      = document.getElementById('error');
const toastEl      = document.getElementById('toast');
const progressWrap = document.getElementById('progressWrap');
const progressBar  = document.getElementById('progressBar');
const progressLbl  = document.getElementById('progressLabel');
const ratioValid   = document.getElementById('ratioValid');
const ratioInvalid = document.getElementById('ratioInvalid');
const ratioLabel   = document.getElementById('ratioLabel');
const uploadZone   = document.getElementById('uploadZone');
const fileInput    = document.getElementById('fileInput');
const etaEl        = document.getElementById('etaEl');
const langButtons  = document.querySelectorAll('.lang-btn');
const cntValidEl   = document.getElementById('cntValid');
const cntInvalidEl = document.getElementById('cntInvalid');
const cntDoneEl    = document.getElementById('cntDone');
const cntTotalEl   = document.getElementById('cntTotal');
const resultsBlock = document.getElementById('results');

// ID regex: аккаунты начинаются с 10 или 61, затем 10–23 алфавитно-цифровых символа
const idRegex = /(\b(?:10|61)[0-9A-Za-z]{10,23}\b)/g;

// ───────── утилиты ─────────

function uniquePreserveOrder(items){
  const seen = new Set();
  const out = [];
  for(const it of items){
    if(!seen.has(it)){ seen.add(it); out.push(it); }
  }
  return out;
}

function appendLine(el, line){
  if(!el) return;
  el.value = el.value ? el.value + '\n' + line : line;
}

// плавный count-up для чисел в счётчиках
const countAnimMap = new WeakMap();
function animateCount(el, target){
  if(!el) return;
  const prev = countAnimMap.get(el);
  if(prev) cancelAnimationFrame(prev.raf);
  const start = parseInt(el.textContent || '0', 10) || 0;
  if(start === target){ el.textContent = String(target); return; }
  const dur = Math.min(450, 120 + Math.abs(target - start) * 6);
  const t0 = performance.now();
  const state = { raf: 0 };
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    const v = Math.round(start + (target - start) * eased);
    el.textContent = String(v);
    if(k < 1){ state.raf = requestAnimationFrame(step); }
    else { countAnimMap.delete(el); }
  };
  state.raf = requestAnimationFrame(step);
  countAnimMap.set(el, state);
}

// ───────── извлечение ID ─────────
//
// Под NPPR-API мы шлём ПОЛНЫЕ строки (с cookies/access_token внутри),
// а не голые ID — это даёт настоящую проверку сессии.
// Дедуп по FB ID: первая встреча — отправляется на бэк, остальные → дубли.
// Строки без FB ID игнорируются (UI их не показывал и раньше).
function extractIdsFromLines(text){
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const idToLines = new Map();   // id → [original lines]
  const lineToId  = new Map();   // primaryLine → id
  const ids = [];                 // в порядке первого появления
  for(const line of lines){
    const firstMatch = line.match(idRegex);
    if(!firstMatch || !firstMatch.length) continue;
    const id = firstMatch[0];
    if(!idToLines.has(id)){
      idToLines.set(id, []);
      ids.push(id);
      lineToId.set(line, id);
    }
    idToLines.get(id).push(line);
  }
  // primaryLines: первая строка для каждого ID — её отправляем на бэк
  const primaryLines = ids.map(id => idToLines.get(id)[0]);
  return { ids, idToLines, primaryLines, lineToId };
}

// ───────── warm-up ─────────

async function warmUp(pingUrl){
  const attempts = 5;
  let lastErr;
  for(let i = 0; i < attempts; i++){
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

// ───────── stream-проверка через SSE ─────────
// Один POST, сервер стримит результаты по 50 строк за раз.
// onBatch({results:[{line,id,valid,status}], done, total}); onEnd({total,valid,invalid,breakdown})
async function streamCheck({ base, lines, signal, onStart, onBatch, onEnd, onError }){
  const url = `${base}/api/check/stream`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ lines }),
    signal,
  });
  if(!resp.ok || !resp.body){
    throw new Error('HTTP ' + resp.status);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const handleEvent = (eventName, dataStr) => {
    let data;
    try { data = JSON.parse(dataStr); } catch(_) { return; }
    if(eventName === 'start' && onStart) onStart(data);
    else if(eventName === 'batch' && onBatch) onBatch(data);
    else if(eventName === 'end' && onEnd) onEnd(data);
    else if(eventName === 'error' && onError) onError(data);
  };

  while(true){
    const { value, done } = await reader.read();
    if(done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while((idx = buffer.indexOf('\n\n')) !== -1){
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if(!raw || raw.startsWith(':')) continue; // heartbeat / comment
      let eventName = 'message';
      let dataStr = '';
      for(const line of raw.split('\n')){
        if(line.startsWith('event:')) eventName = line.slice(6).trim();
        else if(line.startsWith('data:')) dataStr += (dataStr ? '\n' : '') + line.slice(5).trim();
      }
      if(dataStr) handleEvent(eventName, dataStr);
    }
  }
}

// ───────── обновление прогресс-бара ─────────

function updateProgress(done, total){
  const pct = total ? (done / total) * 100 : 0;
  progressBar.style.width = pct.toFixed(2) + '%';
  progressLbl.textContent = `${done} / ${total} (${Math.round(pct)}%)`;
  if(cntDoneEl)  animateCount(cntDoneEl, done);
  if(cntTotalEl) cntTotalEl.textContent = String(total);
}

function formatEta(seconds){
  const d = I18N[detectLang()] || I18N.en;
  if(seconds < 1) return d.etaLessThanOneSec || '< 1 сек';
  if(seconds < 60) return `~ ${Math.round(seconds)} ${d.etaSec || 'сек'}`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  const min = d.etaMin || 'мин';
  return s > 0 ? `~ ${m} ${min} ${s} ${d.etaSec || 'сек'}` : `~ ${m} ${min}`;
}

function updateRatio(validCount, badCount){
  if(!ratioValid || !ratioInvalid || !ratioLabel) return;
  const total = validCount + badCount;
  const pValid = total ? Math.round((validCount / total) * 100) : 0;
  const pBad   = total ? Math.round((badCount / total) * 100) : 0;
  ratioValid.style.width   = pValid + '%';
  ratioInvalid.style.width = pBad + '%';
  ratioLabel.innerHTML = `<span class="v">✓ ${validCount} (${pValid}%)</span> · <span class="x">✗ ${badCount} (${pBad}%)</span>`;
  if(cntValidEl)   animateCount(cntValidEl, validCount);
  if(cntInvalidEl) animateCount(cntInvalidEl, badCount);
}

// ───────── состояние и отмена ─────────
let abortCtrl = null;
let cancelRequested = false;

// ───────── основная кнопка «Проверить» ─────────

checkBtn.addEventListener('click', async () => {
  const { ids, idToLines, primaryLines, lineToId } = extractIdsFromLines(inputEl.value);

  // сброс предыдущих результатов
  validEl.value   = '';
  invalidEl.value = '';
  if(dupesEl) dupesEl.value = '';
  if(errorEl){ errorEl.textContent = ''; errorEl.classList.add('hidden'); }
  if(cntValidEl)   cntValidEl.textContent   = '0';
  if(cntInvalidEl) cntInvalidEl.textContent = '0';
  if(cntDoneEl)    cntDoneEl.textContent    = '0';
  if(cntTotalEl)   cntTotalEl.textContent   = '0';

  statsEl.textContent = `Найдено ID: ${ids.length}`;
  if(ids.length === 0) return;

  // UI: старт
  cancelRequested = false;
  abortCtrl = new AbortController();
  checkBtn.classList.add('hidden');
  if(stopBtn) stopBtn.classList.remove('hidden');
  progressWrap.classList.remove('hidden');
  progressWrap.classList.add('is-running');
  updateProgress(0, ids.length);
  updateRatio(0, 0);

  if(resultsBlock) resultsBlock.classList.remove('hidden');

  const dict = showToast.messages || I18N[detectLang()];
  statsEl.textContent = dict.checking || 'Проверка…';

  const base = (window.PROXY_BASE || '').replace(/\/$/, '');
  const startTime = Date.now();

  let validCount = 0;
  let badCount   = 0;
  let doneCount  = 0;
  const seenLines = new Set();

  // дубли строк с тем же ID — видимые сразу
  for(const id of ids){
    const arr = idToLines.get(id) || [];
    arr.slice(1).forEach(l => appendLine(dupesEl, l));
  }

  // results from backend keyed by `line` (NPPR mode), но ради совместимости
  // с возможным fallback по ID — поддерживаем оба пути.
  const onResult = ({ line, id, valid }) => {
    let primary = line;
    if(!primary && id){
      const arr = idToLines.get(id) || [];
      primary = arr[0];
    }
    if(!primary) return;
    if(seenLines.has(primary)) return;
    seenLines.add(primary);
    if(valid){ appendLine(validEl,   primary); validCount++; }
    else     { appendLine(invalidEl, primary); badCount++;   }
  };

  try{
    await streamCheck({
      base,
      lines: primaryLines,
      signal: abortCtrl.signal,
      onStart: ({ total }) => {
        updateProgress(0, total || ids.length);
      },
      onBatch: ({ results, done, total }) => {
        for(const r of results) onResult(r);
        doneCount = done;
        updateProgress(done, total);
        updateRatio(validCount, badCount);
        if(etaEl){
          if(done >= 5){
            const elapsedSec = (Date.now() - startTime) / 1000;
            const rate = done / elapsedSec;
            const remaining = total - done;
            const etaSec = remaining / Math.max(rate, 0.001);
            etaEl.textContent = formatEta(etaSec);
            etaEl.classList.remove('hidden');
          }
        }
        statsEl.textContent = `${dict.checking || 'Проверка…'} ${done}/${total}`;
      },
      onError: ({ message }) => {
        if(errorEl){
          errorEl.textContent = (dict.networkError || 'Network error') + ': ' + message;
          errorEl.classList.remove('hidden');
        }
      },
    });
  }catch(err){
    const aborted = err?.name === 'AbortError' || cancelRequested;
    if(!aborted){
      // fallback: один батч через bulk endpoint
      try{
        const resp = await fetch(`${base}/api/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lines: primaryLines }),
        });
        if(resp.ok){
          const data = await resp.json();
          (data.valid   || []).forEach(line => onResult({ line, valid: true  }));
          (data.invalid || []).forEach(line => onResult({ line, valid: false }));
          doneCount = ids.length;
          updateProgress(doneCount, ids.length);
          updateRatio(validCount, badCount);
        } else {
          throw new Error('HTTP ' + resp.status);
        }
      }catch(err2){
        statsEl.textContent = (dict.networkError || 'Network error') + ': ' + String(err2);
        if(errorEl){
          errorEl.textContent = (dict.networkError || 'Network error') + ': ' + String(err2);
          errorEl.classList.remove('hidden');
        }
      }
    }
  }finally{
    checkBtn.classList.remove('hidden');
    if(stopBtn) stopBtn.classList.add('hidden');
    if(etaEl) etaEl.classList.add('hidden');
    progressWrap.classList.remove('is-running');
    progressWrap.classList.add('is-done');
    setTimeout(() => progressWrap.classList.remove('is-done'), 1200);

    const total = validCount + badCount;
    const pv = total ? Math.round((validCount / total) * 1000) / 10 : 0;
    const pb = total ? Math.round((badCount   / total) * 1000) / 10 : 0;
    const dupCount = dupesEl ? dupesEl.value.split('\n').filter(Boolean).length : 0;
    const dupInfo  = dupCount ? `, дубли строк: ${dupCount}` : '';

    if(cancelRequested){
      statsEl.innerHTML = `<span class="summary bad">${dict.stopped || 'Остановлено'}: ${dict.validWord}: ${validCount}, ${dict.blockedWord}: ${badCount}</span>`;
    }else{
      statsEl.innerHTML = `<span class="summary">${dict.summaryPrefix} <span class="ok">${dict.validWord}: ${validCount} (${pv}%)</span>, <span class="bad">${dict.blockedWord}: ${badCount} (${pb}%)</span>${dupInfo}</span>`;
    }
    abortCtrl = null;
  }
});

// ───────── кнопка «Стоп» ─────────

if(stopBtn){
  stopBtn.addEventListener('click', () => {
    cancelRequested = true;
    stopBtn.disabled = true;
    if(abortCtrl){ try { abortCtrl.abort(); } catch(_) {} }
    const dict = showToast.messages || I18N[detectLang()];
    statsEl.textContent = dict.stopping || 'Останавливаем…';
    setTimeout(() => { stopBtn.disabled = false; }, 600);
  });
}

// ───────── счётчик строк при вводе ─────────

function updateInputStats(){
  const linesCount = inputEl.value.split(/\r?\n/).filter(l => l.trim().length > 0).length;
  const { ids } = extractIdsFromLines(inputEl.value);
  statsEl.textContent = `Строк: ${linesCount}, найдено ID: ${ids.length}`;
}

inputEl.addEventListener('input', updateInputStats);

// ───────── загрузка файла (drag-and-drop + выбор) ─────────

function loadFileIntoInput(file){
  if(!file) return;
  const ok = file.type?.startsWith('text/') || /\.(txt|csv)$/i.test(file.name || '');
  if(!ok && file.type) return;
  const reader = new FileReader();
  reader.onload = () => {
    inputEl.value = reader.result;
    updateInputStats();
    keepStartVisible(inputEl);
  };
  reader.readAsText(file, 'UTF-8');
}

if(uploadZone && fileInput){
  uploadZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if(f) loadFileIntoInput(f);
    fileInput.value = '';
  });
  ['dragenter','dragover'].forEach(ev => {
    uploadZone.addEventListener(ev, e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
  });
  ['dragleave','drop'].forEach(ev => {
    uploadZone.addEventListener(ev, e => {
      e.preventDefault();
      uploadZone.classList.remove('dragover');
      if(ev === 'drop' && e.dataTransfer?.files?.[0]) loadFileIntoInput(e.dataTransfer.files[0]);
    });
  });
}

// ───────── старт: фоновый warm-up + инициализация UI ─────────

window.addEventListener('DOMContentLoaded', () => {
  updateInputStats();
  const base = (window.PROXY_BASE || '').replace(/\/$/, '');
  warmUp(`${base}/api/ping`).catch(() => {});
});

window.addEventListener('load', () => {
  if(preloader) preloader.classList.add('hidden');
});

// ───────── GitHub Pages: предупреждение если нет PROXY_BASE ─────────

try{
  const isGhPages = /github\.io$/.test(location.hostname);
  if(isGhPages && (!window.PROXY_BASE || window.PROXY_BASE === '')){
    if(errorEl){
      errorEl.textContent = 'Для GitHub Pages укажите URL backend-прокси в public/config.js (window.PROXY_BASE).';
      errorEl.classList.remove('hidden');
    }
  }
}catch(_){ }

// ───────── фикс прокрутки textarea ─────────

function keepStartVisible(el){ el.scrollLeft = 0; }
inputEl.addEventListener('input',  () => keepStartVisible(inputEl));
inputEl.addEventListener('paste',  () => setTimeout(() => keepStartVisible(inputEl), 0));
inputEl.addEventListener('keyup',  () => keepStartVisible(inputEl));

// ───────── копирование / сохранение ─────────

function copyField(id){
  const el = document.getElementById(id);
  if(!el) return;
  navigator.clipboard.writeText(el.value || '').then(() => {
    const dict = showToast.messages || I18N[detectLang()];
    showToast(dict.copied, 'success');
  }).catch(() => showToast('Clipboard error', 'info'));
}
function saveField(id){
  const el = document.getElementById(id);
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

// ───────── очистить всё ─────────

const clearAllBtn = document.getElementById('clearAll');
if(clearAllBtn){
  clearAllBtn.addEventListener('click', () => {
    inputEl.value   = '';
    validEl.value   = '';
    invalidEl.value = '';
    if(dupesEl) dupesEl.value = '';
    statsEl.textContent = '';
    if(errorEl){ errorEl.textContent = ''; errorEl.classList.add('hidden'); }
    progressWrap.classList.add('hidden');
    progressWrap.classList.remove('is-running','is-done');
    updateProgress(0, 0);
    updateRatio(0, 0);
    if(cntValidEl)   cntValidEl.textContent   = '0';
    if(cntInvalidEl) cntInvalidEl.textContent = '0';
    if(cntDoneEl)    cntDoneEl.textContent    = '0';
    if(cntTotalEl)   cntTotalEl.textContent   = '0';
    if(resultsBlock) resultsBlock.classList.add('hidden');
    updateInputStats();
    keepStartVisible(inputEl);
    const dict = showToast.messages || I18N[detectLang()];
    showToast(dict.cleared, 'info');
  });
}

// ───────── тема ─────────
document.documentElement.setAttribute('data-theme', 'light');

// ───────── toast ─────────

let toastTimer;
function showToast(message, variant){
  if(!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.remove('success', 'info');
  if(variant) toastEl.classList.add(variant);
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

// ───────── i18n ─────────

const I18N = {
  ru: {
    heroTitle:    'Чекер аккаунтов Facebook',
    heroP1:       'Этот инструмент позволяет быстро проверить состояние ваших Facebook‑аккаунтов.',
    heroP2:       'Вставьте список аккаунтов в поле ввода и нажмите кнопку «Проверить аккаунты». Система определит, какие аккаунты активны, заблокированы или требуют подтверждения.',
    inputLabel:   'Вставьте строки (по одной на строке):',
    uploadHint:   'Перетащите файл сюда или нажмите для выбора',
    checkBtn:     'Проверить аккаунты',
    stopBtn:      'Остановить',
    clearBtn:     'Очистить всё',
    validLabel:   'Валидные',
    invalidLabel: 'Невалидные/Заблокированные',
    dupesLabel:   'Дубли (ID повторяются)',
    copied:       'Скопировано в буфер обмена',
    cleared:      'Очищено',
    summaryPrefix:'Итог —',
    validWord:    'валидных',
    blockedWord:  'заблокировано',
    checking:     'Проверка…',
    stopping:     'Останавливаем…',
    stopped:      'Остановлено',
    waking:       'Пробуждение сервера…',
    networkError: 'Сетевой сбой. Попробуйте ещё раз',
    etaLessThanOneSec: '< 1 сек',
    etaSec: 'сек',
    etaMin: 'мин'
  },
  uk: {
    heroTitle:    'Чекер акаунтів Facebook',
    heroP1:       'Інструмент для швидкої перевірки стану ваших акаунтів Facebook.',
    heroP2:       'Вставте список акаунтів у поле та натисніть «Перевірити акаунти». Система визначить, які акаунти активні, заблоковані або потребують підтвердження.',
    inputLabel:   'Вставте рядки (по одному на рядок):',
    uploadHint:   'Перетягніть файл сюди або натисніть для вибору',
    checkBtn:     'Перевірити акаунти',
    stopBtn:      'Зупинити',
    clearBtn:     'Очистити все',
    validLabel:   'Валідні',
    invalidLabel: 'Невалідні/Заблоковані',
    dupesLabel:   'Дублі (ID повторюються)',
    copied:       'Скопійовано у буфер',
    cleared:      'Очищено',
    summaryPrefix:'Підсумок —',
    validWord:    'валідних',
    blockedWord:  'заблоковано',
    checking:     'Перевірка…',
    stopping:     'Зупиняємо…',
    stopped:      'Зупинено',
    waking:       'Пробудження сервера…',
    networkError: 'Помилка мережі. Спробуйте ще раз',
    etaLessThanOneSec: '< 1 сек',
    etaSec: 'сек',
    etaMin: 'хв'
  },
  en: {
    heroTitle:    'Facebook Accounts Checker',
    heroP1:       'A tool to quickly check the status of your Facebook accounts.',
    heroP2:       'Paste the list of accounts and click "Check accounts". The system will detect which are active, blocked or require verification.',
    inputLabel:   'Paste lines (one per line):',
    uploadHint:   'Drag file here or click to select',
    checkBtn:     'Check accounts',
    stopBtn:      'Stop',
    clearBtn:     'Clear all',
    validLabel:   'Valid',
    invalidLabel: 'Invalid/Blocked',
    dupesLabel:   'Duplicates (IDs repeated)',
    copied:       'Copied to clipboard',
    cleared:      'Cleared',
    summaryPrefix:'Summary —',
    validWord:    'valid',
    blockedWord:  'blocked',
    checking:     'Checking…',
    stopping:     'Stopping…',
    stopped:      'Stopped',
    waking:       'Warming up server…',
    networkError: 'Network error. Please retry',
    etaLessThanOneSec: '< 1 sec',
    etaSec: 'sec',
    etaMin: 'min'
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
  showToast.messages = dict;
  langButtons.forEach(b => b.classList.toggle('active', b.getAttribute('data-lang') === lang));
  try{ localStorage.setItem('lang', lang); }catch(_){ }
}

langButtons.forEach(btn => btn.addEventListener('click', () => applyLang(btn.getAttribute('data-lang'))));

const initialLang = detectLang();
applyLang(initialLang);
