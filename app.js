// корректная ESM-сборка для браузера
import { Address } from "https://esm.sh/@ton/core@0.57.0?bundle";


const API_BASE = "https://tonapi.io/v2";
const MASTER = window.GRAM_MASTER;

const q = s => document.querySelector(s);
const metaEl   = q('#meta');
const rowsEl   = q('#rows');
const limitSel = q('#limit');
const searchEl = q('#search');
const reloadBt = q('#reload');
const prevBt   = q('#prev');
const nextBt   = q('#next');
const pageInfo = q('#pageinfo');

let decimals = 9;
let totalSupply = 0n;
let page = 0;

// ----- форматирование -----
function fmtGram(intLike) {
  try {
    const n = BigInt(intLike);
    const pow = BigInt(10) ** BigInt(decimals);
    const whole = n / pow;
    const frac = (n % pow).toString().padStart(decimals, '0').replace(/0+$/,'');
    return frac ? `${whole}.${frac}` : `${whole}`;
  } catch { return '—'; }
}
function pct(intLike) {
  try {
    if (totalSupply === 0n) return '—';
    const n = (BigInt(intLike) * 100000n) / totalSupply; // тысячные доли процента
    return (Number(n) / 1000).toFixed(3) + '%';
  } catch { return '—'; }
}

// ----- helper: дружелюбный non-bounceable адрес -----
function toFriendlyNonBounceable(rawOrFriendly) {
  try {
    // Address.parse распознаёт и raw ("0:...") и уже friendly.
    return Address.parse(rawOrFriendly).toString({
      bounceable: false,
      urlSafe: true,   // заменяет +/ на -_ и убирает =
      // testOnly: false // по умолчанию false; можно явно указать, если нужно
    });
  } catch {
    return rawOrFriendly; // если вдруг не распарсился — показываем как есть
  }
}

// ----- троттлинг TonAPI: ≥ 4 c между запросами -----
let lastCall = 0;
const MIN_GAP_MS = 4000;

async function throttledFetch(url, options = {}) {
  const now = Date.now();
  const wait = Math.max(0, MIN_GAP_MS - (now - lastCall));
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
  const res = await throttledFetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`TonAPI error ${res.status}`);
  return res.json();
}

// ----- загрузка метаданных -----
async function loadMeta() {
  const info = await tonFetch(`/jettons/${MASTER}`);
  const meta = info?.metadata || info?.jetton || info || {};
  decimals = Number(meta.decimals ?? 9);

  const ts = meta.total_supply ?? meta.totalSupply ?? info?.total_supply ?? 0;
  try { totalSupply = BigInt(ts); } catch { totalSupply = 0n; }

  const name  = meta.name ?? 'GRAM';
  const symbol = meta.symbol ?? 'GRAM';

  metaEl.innerHTML = `
    <div><b>${name} (${symbol})</b> • decimals: ${decimals}</div>
    <div>Общий саплай: <b>${fmtGram(totalSupply)}</b> ${symbol}</div>
  `;
}

// ----- загрузка холдеров -----
async function loadHolders() {
  const limit = Number(limitSel.value);
  const offset = page * limit;

  rowsEl.innerHTML = `<tr><td colspan="4" class="muted">Загрузка…</td></tr>`;

  const data = await tonFetch(`/jettons/${MASTER}/holders?limit=${limit}&offset=${offset}`);

  const list = data.holders || data.addresses || data.items || data || [];
  const needle = searchEl.value.trim().toLowerCase();

  const filtered = list.filter(it => {
    const raw = it.owner?.address || it.address || it.account?.address || it.wallet_address || '';
    // Фильтруем по raw и по friendly (на всякий случай)
    return !needle || raw.toLowerCase().includes(needle) || toFriendlyNonBounceable(raw).toLowerCase().includes(needle);
  });

  if (!filtered.length) {
    rowsEl.innerHTML = `<tr><td colspan="4" class="muted">Ничего не найдено</td></tr>`;
  } else {
    rowsEl.innerHTML = filtered.map((it, i) => {
      const rank = offset + i + 1;
      const raw  = it.owner?.address || it.address || it.account?.address || it.wallet_address || '—';
      const addr = toFriendlyNonBounceable(raw);
      const bal  = it.balance ?? it.amount ?? it.jetton_balance ?? 0;
      return `
        <tr>
          <td>${rank}</td>
          <td class="addr">
            <span>${addr}</span>
            <button class="copy" data-copy="${addr}" title="Скопировать адрес">⧉</button>
          </td>
          <td class="num">${fmtGram(bal)}</td>
          <td class="num">${pct(bal)}</td>
        </tr>
      `;
    }).join('');
  }

  pageInfo.textContent = `Стр. ${page + 1}`;

  // копирование адреса
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

async function boot() {
  try {
    await loadMeta();
    await loadHolders();
  } catch (e) {
    rowsEl.innerHTML = `<tr><td colspan="4" class="error">Ошибка: ${e.message}</td></tr>`;
  }
}

reloadBt.onclick = () => { page = 0; boot(); };
limitSel.onchange = () => { page = 0; boot(); };
searchEl.oninput = () => { loadHolders(); };
prevBt.onclick = () => { if (page>0) { page--; boot(); } };
nextBt.onclick = () => { page++; boot(); };

boot();
