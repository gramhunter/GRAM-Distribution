import { Address } from "https://esm.sh/@ton/core@0.57.0?bundle";

const API_BASE = "https://tonapi.io/v2";
const MASTER = window.GRAM_MASTER;

const q = s => document.querySelector(s);
const metaEl   = q('#meta');
const rowsEl   = q('#rows');
const limitSel = q('#limit');
const reloadBt = q('#reload');
const prevBt   = q('#prev');
const nextBt   = q('#next');
const pageInfo = q('#pageinfo');

// token UI
const tokenInput   = q('#token');
const saveTokenBtn = q('#saveToken');
const clearTokenBtn= q('#clearToken');
const authBadge    = q('#authBadge');

// price UI
const priceBadge = q('#priceBadge');

let decimals = 9;
let totalSupply = 0n;
let page = 0;
let priceUSD = null;        // текущая цена GRAM из CoinGecko (usd)
let tagMap = new Map();     // address -> tag

// ===== token helpers =====
function getStoredToken() {
  try { return localStorage.getItem('tonapi_token') || ''; } catch { return ''; }
}
function setStoredToken(v) {
  try { v ? localStorage.setItem('tonapi_token', v) : localStorage.removeItem('tonapi_token'); } catch {}
}
function updateAuthUI() {
  const has = !!getStoredToken();
  authBadge.textContent = has ? 'Auth: token' : 'Auth: none';
  authBadge.classList.toggle('ok', has);
  authBadge.classList.toggle('warn', !has);
}
function initTokenUI() {
  tokenInput.value = getStoredToken();
  updateAuthUI();
  saveTokenBtn.onclick = () => { setStoredToken(tokenInput.value.trim()); updateAuthUI(); };
  clearTokenBtn.onclick = () => { tokenInput.value=''; setStoredToken(''); updateAuthUI(); };
}

// ===== formatters =====
function fmtGram(intLike) {
  try {
    const n = BigInt(intLike);
    const pow = 10n ** BigInt(decimals);
    const whole = n / pow;
    const frac = (n % pow).toString().padStart(decimals, '0').replace(/0+$/,'');
    
    // Форматируем целую часть с разделителями тысяч
    const formattedWhole = whole.toLocaleString();
    
    // Форматируем дробную часть (максимум 2 знака)
    let formattedFrac = '';
    if (frac) {
      formattedFrac = '.' + frac.slice(0, 2);
    }
    
    return `${formattedWhole}${formattedFrac} GRAM`;
  } catch { return '—'; }
}

// Функция для получения числа GRAM без форматирования (для расчетов)
function getGramNumber(intLike) {
  try {
    const n = BigInt(intLike);
    const pow = 10n ** BigInt(decimals);
    const whole = n / pow;
    const frac = (n % pow).toString().padStart(decimals, '0').replace(/0+$/,'');
    return frac ? parseFloat(`${whole}.${frac}`) : parseFloat(whole);
  } catch { return 0; }
}
function pct(intLike) {
  try {
    if (totalSupply === 0n) return '—';
    const n = (BigInt(intLike) * 100000n) / totalSupply;
    return (Number(n) / 1000).toFixed(3) + '%';
  } catch { return '—'; }
}
function toFriendlyNonBounceable(rawOrFriendly) {
  try {
    return Address.parse(rawOrFriendly).toString({ bounceable:false, urlSafe:true });
  } catch { return rawOrFriendly; }
}

// ===== tag and USD helpers =====
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function loadTags() {
  try {
    const res = await fetch('./tags.json?_=' + Date.now()); // избегаем кэша
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const map = new Map();

    if (Array.isArray(data)) {
      data.forEach(it => {
        const raw = it.address || it.addr;
        const label = it.tag || it.label || it.name;
        if (!raw || !label) return;
        const friendly = toFriendlyNonBounceable(raw);
        map.set(friendly, label);
        map.set(raw, label);
      });
    } else if (data && typeof data === 'object') {
      Object.entries(data).forEach(([addr, lab]) => {
        const label = typeof lab === 'string' ? lab : (lab?.tag || lab?.label || '');
        if (!label) return;
        const friendly = toFriendlyNonBounceable(addr);
        map.set(friendly, label);
        map.set(addr, label);
      });
    }
    tagMap = map;
  } catch (e) {
    console.warn('tags.json missing/invalid:', e.message);
    tagMap = new Map();
  }
}

function fmtUSD(n) {
  if (n == null || !isFinite(n)) return '$—';
  const opts = n >= 100000 ? { maximumFractionDigits: 0 } : { maximumFractionDigits: 2 };
  return '$' + n.toLocaleString(undefined, opts);
}

// ===== throttling for TonAPI =====
let lastCall = 0;
function minGapMs() { return getStoredToken() ? 500 : 4000; }
async function throttledFetch(url, options = {}) {
  const now = Date.now();
  const wait = Math.max(0, minGapMs() - (now - lastCall));
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();

  let res = await fetch(url, options);
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after")) || 4;
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    lastCall = Date.now();
    res = await fetch(url, options);
  }
  return res;
}

async function tonFetch(path) {
  const token = getStoredToken();
  const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
  const res = await throttledFetch(`${API_BASE}${path}`, { headers });
  if (res.status === 401 || res.status === 403) {
    setStoredToken(''); updateAuthUI();
    const res2 = await throttledFetch(`${API_BASE}${path}`, {});
    if (!res2.ok) throw new Error(`TonAPI error ${res2.status}`);
    return res2.json();
  }
  if (!res.ok) throw new Error(`TonAPI error ${res.status}`);
  return res.json();
}

// ===== meta =====
async function loadMeta() {
  const info = await tonFetch(`/jettons/${MASTER}`);
  const meta = info?.metadata || info?.jetton || info || {};
  decimals = Number(meta.decimals ?? 9);
  const ts = meta.total_supply ?? meta.totalSupply ?? info?.total_supply ?? 0;
  try { totalSupply = BigInt(ts); } catch { totalSupply = 0n; }
  const name  = meta.name ?? 'GRAM';
  const symbol = meta.symbol ?? 'GRAM';

  metaEl.innerHTML = `
    <div><b>${name} (${symbol})</b> • decimals: ${decimals} •
      <span class="badge ${getStoredToken() ? 'ok' : 'warn'}">
        ${getStoredToken() ? 'faster (token)' : 'slow (no token)'}
      </span>
    </div>
    <div>Общий саплай: <b>${fmtGram(totalSupply)}</b></div>
  `;
}

// ===== stats (top10/100/1000 + total holders) =====
async function loadStats() {
  const data = await tonFetch(`/jettons/${MASTER}/holders?limit=1000&offset=0`);
  const list = data.holders || data.addresses || data.items || [];
  const totalHolders = data.total ?? data.total_count ?? data.count ?? data.totalItems ?? data.total_items ?? list.length;

  list.sort((a, b) => {
    const balA = BigInt(a.balance ?? a.amount ?? a.jetton_balance ?? 0);
    const balB = BigInt(b.balance ?? b.amount ?? b.jetton_balance ?? 0);
    if (balA === balB) return 0;
    return balA > balB ? -1 : 1;
  });

  let total10=0n, total100=0n, total1000=0n;
  list.forEach((it,i)=>{
    const bal = BigInt(it.balance ?? it.amount ?? it.jetton_balance ?? 0);
    if (i<10) total10 += bal;
    if (i<100) total100 += bal;
    if (i<1000) total1000 += bal;
  });

  const pctStr = x => totalSupply===0n ? '—' : (Number((x*100000n)/totalSupply)/1000).toFixed(3) + '%';
  const pctNum = x => totalSupply===0n ? 0 : Math.min(100, Number((x*10000n)/totalSupply)/100);

  q("#statAddresses").textContent = Number(totalHolders).toLocaleString();
  q("#statTop10").textContent = pctStr(total10);
  q("#statTop100").textContent = pctStr(total100);
  q("#statTop1000").textContent = pctStr(total1000);

  q("#barTop10").style.width = pctNum(total10) + "%";
  q("#barTop100").style.width = pctNum(total100) + "%";
  q("#barTop1000").style.width = pctNum(total1000) + "%";
}

// ===== table =====
async function loadHolders() {
  const limit = Number(limitSel.value);
  const offset = page * limit;

  rowsEl.innerHTML = `<tr><td colspan="4" class="muted">Загрузка…</td></tr>`;

  const data = await tonFetch(`/jettons/${MASTER}/holders?limit=${limit}&offset=${offset}`);
  const list = data.holders || data.addresses || data.items || data || [];

  if (!list.length) {
    rowsEl.innerHTML = `<tr><td colspan="5" class="muted">Ничего не найдено</td></tr>`;
  } else {
    rowsEl.innerHTML = list.map((it, i) => {
      const rank = offset + i + 1;
      const raw  = it.owner?.address || it.address || it.account?.address || it.wallet_address || '—';
      const addr = toFriendlyNonBounceable(raw);
      const bal  = it.balance ?? it.amount ?? it.jetton_balance ?? 0;

      // тег (ищем по friendly и raw)
      const tagLabel = tagMap.get(addr) || tagMap.get(raw) || '';
      const tagHTML  = tagLabel ? `<span class="tag">${esc(tagLabel)}</span>` : '';

      // USD эквивалент: используем getGramNumber для точного расчета
      const gramsStr = fmtGram(bal);
      const gramsNum = getGramNumber(bal);  // точное число для расчетов
      const usdStr   = priceUSD ? fmtUSD(gramsNum * priceUSD) : '$—';

      return `
        <tr>
          <td>${rank}</td>
          <td class="addr">
            <span>${addr}</span>
            <button class="copy" data-copy="${addr}" title="Скопировать адрес">⧉</button>
          </td>
          <td>${tagHTML}</td>
          <td class="num">
            <span>${gramsStr}</span>
            <span class="usd-badge">${usdStr}</span>
          </td>
          <td class="num">${pct(bal)}</td>
        </tr>
      `;
    }).join('');
  }

  pageInfo.textContent = `Стр. ${page + 1}`;

  [...document.querySelectorAll('button.copy')].forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = '✓';
        setTimeout(() => (btn.textContent = '⧉'), 700);
      } catch {}
    });
  });
}

// ===== price from CoinGecko =====
async function loadPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=gram-2&vs_currencies=usd');
    if (!res.ok) throw new Error('CG ' + res.status);
    const j = await res.json();
    const usd = j?.['gram-2']?.usd;
    if (typeof usd === 'number') {
      priceUSD = usd;
      priceBadge.textContent = '$' + usd.toLocaleString(undefined, { minimumFractionDigits: 6, maximumFractionDigits: 6 });
    } else {
      priceUSD = null;
      priceBadge.textContent = '$—';
    }
  } catch (e) {
    console.warn('CoinGecko price error:', e);
    priceUSD = null;
    priceBadge.textContent = '$—';
  }
}

// ===== boot =====
async function boot() {
  try {
    updateAuthUI();
    await loadPrice();
    setInterval(loadPrice, 60000); // обновляем раз в минуту
    await loadMeta();
    await loadStats();
    await loadTags();      // <<< добавить
    await loadHolders();
  } catch (e) {
    rowsEl.innerHTML = `<tr><td colspan="5" class="error">Ошибка: ${e.message}</td></tr>`;
    console.error(e);
  }
}

reloadBt.onclick = () => { page = 0; boot(); };
limitSel.onchange = () => { page = 0; boot(); };
prevBt.onclick = () => { if (page>0) { page--; boot(); } };
nextBt.onclick = () => { page++; boot(); };

initTokenUI();
boot();
