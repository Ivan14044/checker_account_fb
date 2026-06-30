// 2FA TOTP-генератор (RFC 6238, SHA-1, 6 цифр, период 30 с).
// Расчёт полностью клиентский через Web Crypto — секрет не покидает браузер.

const secretEl   = document.getElementById('secret');
const blockEl     = document.getElementById('otpBlock');
const codeEl      = document.getElementById('otpCode');
const timerEl     = document.getElementById('otpTimer');
const progressEl  = document.getElementById('otpProgress');
const nextEl      = document.getElementById('otpNext');
const hintEl      = document.getElementById('otpHint');
const errorEl     = document.getElementById('error');
const toastEl     = document.getElementById('toast');
const langButtons = document.querySelectorAll('.lang-btn');

const PERIOD = 30;
const DIGITS = 6;

// ───────── Base32 decode ─────────
function base32Decode(input){
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).toUpperCase().replace(/=+$/,'').replace(/\s+/g,'');
  if(!clean) throw new Error('empty');
  let bits = 0, value = 0;
  const bytes = [];
  for(const ch of clean){
    const idx = alphabet.indexOf(ch);
    if(idx === -1) throw new Error('bad char');
    value = (value << 5) | idx;
    bits += 5;
    if(bits >= 8){
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if(bytes.length === 0) throw new Error('empty');
  return new Uint8Array(bytes);
}

// ───────── TOTP ─────────
async function totpAt(keyBytes, counter){
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name:'HMAC', hash:'SHA-1' }, false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const code =
    ((sig[offset] & 0x7f) << 24) |
    (sig[offset + 1] << 16) |
    (sig[offset + 2] << 8) |
    sig[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

function fmt(code){
  // "123456" → "123 456"
  return code.length === 6 ? `${code.slice(0,3)} ${code.slice(3)}` : code;
}

// ───────── состояние и тикер ─────────
let keyBytes = null;      // декодированный секрет или null если невалидный
let tickTimer = null;
let lastWindow = -1;      // номер 30-сек окна, чтобы пересчитывать код только на границе

function setError(msg){
  if(!errorEl) return;
  if(msg){ errorEl.textContent = msg; errorEl.classList.remove('hidden'); }
  else   { errorEl.textContent = ''; errorEl.classList.add('hidden'); }
}

async function refresh(){
  if(!keyBytes){ blockEl.classList.add('hidden'); return; }
  const nowSec = Date.now() / 1000;
  const counter = Math.floor(nowSec / PERIOD);
  const remaining = Math.max(0, PERIOD - Math.floor(nowSec % PERIOD));

  // прогресс и таймер обновляем каждый тик
  progressEl.style.width = ((remaining / PERIOD) * 100).toFixed(1) + '%';
  const d = I18N[detectLang()] || I18N.en;
  timerEl.textContent = `${remaining} ${d.sec}`;

  // сам код пересчитываем только при смене окна
  if(counter !== lastWindow){
    lastWindow = counter;
    try{
      const cur  = await totpAt(keyBytes, counter);
      const next = await totpAt(keyBytes, counter + 1);
      codeEl.textContent = fmt(cur);
      nextEl.textContent = `${d.next}: ${fmt(next)}`;
    }catch(_){ /* секрет стал невалидным — обработается в onInput */ }
  }
}

function startTicker(){
  if(tickTimer) return;
  tickTimer = setInterval(refresh, 250);
}

function onInput(){
  const raw = secretEl.value.trim();
  if(!raw){
    keyBytes = null; lastWindow = -1;
    blockEl.classList.add('hidden');
    setError('');
    syncUrl('');
    return;
  }
  try{
    keyBytes = base32Decode(raw);
    lastWindow = -1;            // форсируем пересчёт
    blockEl.classList.remove('hidden');
    setError('');
    syncUrl(raw);
    refresh();
    startTicker();
  }catch(_){
    keyBytes = null; lastWindow = -1;
    blockEl.classList.add('hidden');
    const d = I18N[detectLang()] || I18N.en;
    setError(d.invalid);
  }
}

// секрет в query (?s=) — удобно делиться/сохранять ссылку
function syncUrl(secret){
  try{
    const u = new URL(location.href);
    if(secret) u.searchParams.set('s', secret);
    else u.searchParams.delete('s');
    history.replaceState(null, '', u);
  }catch(_){ }
}

secretEl.addEventListener('input', onInput);

// ───────── копирование ─────────
codeEl.addEventListener('click', () => {
  const code = (codeEl.textContent || '').replace(/\s/g, '');
  if(!code || code === '000000') return;
  navigator.clipboard.writeText(code).then(() => {
    const d = I18N[detectLang()] || I18N.en;
    showToast(d.copied, 'success');
  }).catch(() => showToast('Clipboard error', 'info'));
});

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
  ru: { title:'Генератор 2FA-кодов', desc:'Введите Base32-секрет (TOTP) — система покажет текущий 6-значный код по стандарту RFC 6238 (SHA-1, 30 секунд). Расчёт выполняется в браузере, секрет никуда не отправляется.', secretLabel:'Секретный ключ (Base32):', clickToCopy:'Нажмите, чтобы скопировать', hint:'Поддерживаются буквы A–Z и цифры 2–7 (Base32).', invalid:'Некорректный Base32-секрет.', copied:'Код скопирован', next:'Следующий код', sec:'c' },
  uk: { title:'Генератор 2FA-кодів', desc:'Введіть Base32-секрет (TOTP) — система покаже поточний 6-значний код за стандартом RFC 6238 (SHA-1, 30 секунд). Розрахунок виконується у браузері, секрет нікуди не надсилається.', secretLabel:'Секретний ключ (Base32):', clickToCopy:'Натисніть, щоб скопіювати', hint:'Підтримуються літери A–Z та цифри 2–7 (Base32).', invalid:'Некоректний Base32-секрет.', copied:'Код скопійовано', next:'Наступний код', sec:'с' },
  en: { title:'2FA Code Generator', desc:'Enter a Base32 TOTP secret — the tool shows the current 6-digit code per RFC 6238 (SHA-1, 30 seconds). Everything is computed in your browser; the secret is never sent anywhere.', secretLabel:'Secret key (Base32):', clickToCopy:'Click to copy', hint:'Supports letters A–Z and digits 2–7 (Base32).', invalid:'Invalid Base32 secret.', copied:'Code copied', next:'Next code', sec:'sec' }
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
  langButtons.forEach(b => b.classList.toggle('active', b.getAttribute('data-lang') === lang));
  try{ localStorage.setItem('lang', lang); }catch(_){ }
  // обновим подписи таймера/next под новый язык
  if(keyBytes){ lastWindow = -1; refresh(); }
}

langButtons.forEach(btn => btn.addEventListener('click', () => applyLang(btn.getAttribute('data-lang'))));

// ───────── init ─────────
document.documentElement.setAttribute('data-theme', 'light');
applyLang(detectLang());

// предзаполнение из URL (?s=...)
try{
  const s = new URL(location.href).searchParams.get('s');
  if(s){ secretEl.value = s; onInput(); }
}catch(_){ }
