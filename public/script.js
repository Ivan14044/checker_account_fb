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
const langButtons  = document.querySelectorAll('.lang-btn');

// ID regex: аккаунты начинаются с 10 или 61, затем 10-23 алфавитно-цифровых символа
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

// Добавить строку в конец textarea без замены всего содержимого
function appendLine(el, line){
  if(!el) return;
  el.value = el.value ? el.value + '\n' + line : line;
}

// ───────── извлечение ID ─────────

function extractIdsFromLines(text){
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [];
  const idToLines = new Map();
  for(const line of lines){
    // берём только ПЕРВЫЙ ID на строку
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

// ───────── HTTP с повторами ─────────

async function fetchWithRetry(url, options, attempts = 2, timeoutMs = 6000){
  let lastErr;
  for(let i = 0; i < attempts; i++){
    try{
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const resp = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(t);
      if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    }catch(err){
      lastErr = err;
      await new Promise(res => setTimeout(res, 600 * Math.pow(2, i)));
    }
  }
  throw lastErr || new Error('NetworkError');
}

// ───────── проверка одного ID ─────────

async function checkOneId(base, id){
  const url = `${base}/api/get_uid/${encodeURIComponent(id)}`;
  try{
    const text = await fetchWithRetry(url, { method: 'GET', headers: { Accept: 'application/json' } });
    const json = JSON.parse(text);
    return {
      id,
      valid: json != null
          && Object.prototype.hasOwnProperty.call(json, 'uid')
          && json.uid !== null
    };
  }catch(_e){
    return { id, valid: false };
  }
}

// ───────── пул воркеров ─────────
// Запускает `concurrency` параллельных воркеров, каждый берёт следующий ID из общей очереди.
// task(item, index) вызывается для каждого элемента.

async function runPool(items, concurrency, task, isCancelled){
  let idx = 0;
  async function worker(){
    while(idx < items.length){
      if(isCancelled()) return;
      const i = idx++;
      await task(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
}

// ───────── обновление прогресс-бара ─────────

function updateProgress(done, total){
  const pct = total ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = pct + '%';
  progressLbl.textContent = `${done} / ${total} (${pct}%)`;
}

// ───────── флаг отмены (внешний для обработчиков) ─────────
let cancelRequested = false;

// ───────── основная кнопка «Проверить» ─────────

checkBtn.addEventListener('click', async () => {
  const { ids, idToLines } = extractIdsFromLines(inputEl.value);

  // сброс предыдущих результатов
  validEl.value   = '';
  invalidEl.value = '';
  if(dupesEl) dupesEl.value = '';
  if(errorEl){ errorEl.textContent = ''; errorEl.classList.add('hidden'); }

  statsEl.textContent = `Найдено ID: ${ids.length}`;
  if(ids.length === 0) return;

  // UI: старт проверки
  cancelRequested = false;
  checkBtn.classList.add('hidden');
  if(stopBtn) stopBtn.classList.remove('hidden');
  progressWrap.classList.remove('hidden');
  updateProgress(0, ids.length);

  // показываем блок результатов сразу (поля пустые, но видны)
  const resultsBlock = document.getElementById('results');
  if(resultsBlock) resultsBlock.classList.remove('hidden');

  const dict = showToast.messages || I18N[detectLang()];
  statsEl.textContent = dict.checking || 'Проверка…';

  const base = (window.PROXY_BASE || '').replace(/\/$/, '');

  let doneCount  = 0;
  let validCount = 0;
  let badCount   = 0;

  // трекаем уже обработанные ID, чтобы правильно складывать дубли
  const seenIds = new Set();

  try{
    await runPool(
      ids,
      25, // количество параллельных воркеров
      async (id) => {
        const { valid } = await checkOneId(base, id);

        // определяем строки для этого ID
        const arr = idToLines.get(id) || [];
        if(arr.length > 0 && !seenIds.has(id)){
          seenIds.add(id);
          // первая строка — в нужный список
          if(valid){ appendLine(validEl, arr[0]); validCount++; }
          else      { appendLine(invalidEl, arr[0]); badCount++; }
          // остальные строки того же ID — в дубли
          arr.slice(1).forEach(l => appendLine(dupesEl, l));
        }

        doneCount++;
        updateProgress(doneCount, ids.length);
        statsEl.textContent = `${dict.checking || 'Проверка…'} ${doneCount}/${ids.length}`;
      },
      () => cancelRequested
    );
  }catch(err){
    statsEl.textContent = (dict.networkError || 'Network error') + ': ' + String(err);
    if(errorEl){
      errorEl.textContent = (dict.networkError || 'Network error') + ': ' + String(err);
      errorEl.classList.remove('hidden');
    }
  }finally{
    // UI: конец проверки
    checkBtn.classList.remove('hidden');
    if(stopBtn) stopBtn.classList.add('hidden');

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
  }
});

// ───────── кнопка «Стоп» ─────────

if(stopBtn){
  stopBtn.addEventListener('click', () => {
    cancelRequested = true;
    stopBtn.disabled = true;
    const dict = showToast.messages || I18N[detectLang()];
    statsEl.textContent = dict.stopping || 'Останавливаем…';
  });
}

// ───────── счётчик строк при вводе ─────────

function updateInputStats(){
  const linesCount = inputEl.value.split(/\r?\n/).filter(l => l.trim().length > 0).length;
  const { ids } = extractIdsFromLines(inputEl.value);
  statsEl.textContent = `Строк: ${linesCount}, найдено ID: ${ids.length}`;
}

inputEl.addEventListener('input', updateInputStats);

// ───────── старт: фоновый warm-up + инициализация UI ─────────

window.addEventListener('DOMContentLoaded', () => {
  updateInputStats();
  // фоновый пинг сервера при загрузке страницы, чтобы к моменту нажатия кнопки сервер уже был тёплым
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
    updateProgress(0, 0);
    const resultsBlock = document.getElementById('results');
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
    networkError: 'Сетевой сбой. Попробуйте ещё раз'
  },
  uk: {
    heroTitle:    'Чекер акаунтів Facebook',
    heroP1:       'Інструмент для швидкої перевірки стану ваших акаунтів Facebook.',
    heroP2:       'Вставте список акаунтів у поле та натисніть «Перевірити акаунти». Система визначить, які акаунти активні, заблоковані або потребують підтвердження.',
    inputLabel:   'Вставте рядки (по одному на рядок):',
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
    networkError: 'Помилка мережі. Спробуйте ще раз'
  },
  en: {
    heroTitle:    'Facebook Accounts Checker',
    heroP1:       'A tool to quickly check the status of your Facebook accounts.',
    heroP2:       'Paste the list of accounts and click "Check accounts". The system will detect which are active, blocked or require verification.',
    inputLabel:   'Paste lines (one per line):',
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
  showToast.messages = dict;
  langButtons.forEach(b => b.classList.toggle('active', b.getAttribute('data-lang') === lang));
  try{ localStorage.setItem('lang', lang); }catch(_){ }
}

langButtons.forEach(btn => btn.addEventListener('click', () => applyLang(btn.getAttribute('data-lang'))));

const initialLang = detectLang();
applyLang(initialLang);
