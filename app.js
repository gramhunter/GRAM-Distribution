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



// price UI
const priceBadge = q('#priceBadge');

let decimals = 9;
let totalSupply = 0n;
let page = 0;
let priceUSD = null;        // current GRAM price from CoinGecko (usd)
let tagMap = new Map();     // address -> tag



// ===== formatters =====
function shortenAddress(address, startLength = 6, endLength = 4) {
  if (!address || address.length <= startLength + endLength + 3) {
    return address;
  }
  const start = address.substring(0, startLength);
  const end = address.substring(address.length - endLength);
  return `${start}...${end}`;
}

function fmtGram(intLike) {
  try {
    const n = BigInt(intLike);
    const pow = 10n ** BigInt(decimals);
    const whole = n / pow;
    const frac = (n % pow).toString().padStart(decimals, '0').replace(/0+$/,'');
    
    // Format whole part with thousand separators
    const formattedWhole = whole.toLocaleString();
    
    // Format fractional part (max 2 digits)
    let formattedFrac = '';
    if (frac) {
      formattedFrac = '.' + frac.slice(0, 2);
    }
    
    return `${formattedWhole}${formattedFrac} GRAM`;
  } catch { return '—'; }
}

// Function to get GRAM number without formatting (for calculations)
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
    const res = await fetch('./tags.json?_=' + Date.now()); // avoid cache
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
function minGapMs() { return 4000; } // Fixed 4 second interval without token
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
  const res = await throttledFetch(`${API_BASE}${path}`, {});
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
    <div><b>${name} (${symbol})</b> • decimals: ${decimals}</div>
    <div>Total Supply: <b>${fmtGram(totalSupply)}</b></div>
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

  rowsEl.innerHTML = `<tr><td colspan="4" class="muted">Loading...</td></tr>`;

  const data = await tonFetch(`/jettons/${MASTER}/holders?limit=${limit}&offset=${offset}`);
  const list = data.holders || data.addresses || data.items || data || [];

  if (!list.length) {
    rowsEl.innerHTML = `<tr><td colspan="5" class="muted">Nothing found</td></tr>`;
  } else {
    rowsEl.innerHTML = list.map((it, i) => {
      const rank = offset + i + 1;
      const raw  = it.owner?.address || it.address || it.account?.address || it.wallet_address || '—';
      const addr = toFriendlyNonBounceable(raw);
      const bal  = it.balance ?? it.amount ?? it.jetton_balance ?? 0;

      // tag (search by friendly and raw)
      const tagLabel = tagMap.get(addr) || tagMap.get(raw) || '';
      const tagHTML  = tagLabel ? `<span class="tag">${esc(tagLabel)}</span>` : '';

      // USD эквивалент: используем getGramNumber для точного расчета
      const gramsStr = fmtGram(bal);
      const gramsNum = getGramNumber(bal);  // exact number for calculations
      const usdStr   = priceUSD ? fmtUSD(gramsNum * priceUSD) : '$—';

      return `
        <tr>
          <td>${rank}</td>
          <td class="addr">
            <span title="${addr}" class="address-text">${shortenAddress(addr)}</span>
            <button class="copy" data-copy="${addr}" title="Скопировать полный адрес">⧉</button>
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
  
          // Add ability to show full address on click
  [...document.querySelectorAll('.addr .address-text')].forEach(span => {
    span.addEventListener('click', () => {
      const fullAddress = span.getAttribute('title');
      if (fullAddress && fullAddress !== span.textContent) {
        // Show full address for 3 seconds
        const originalText = span.textContent;
        span.textContent = fullAddress;
        span.style.color = 'var(--accent)';
        setTimeout(() => {
          span.textContent = originalText;
          span.style.color = '';
        }, 3000);
      }
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

// ===== Distribution Table Functions =====
async function loadDistributionData() {
  try {
    const response = await fetch('./distribution.json');
    if (!response.ok) throw new Error('Failed to load distribution.json');
    
    const data = await response.json();
    
    // Update last updated time
    const lastUpdatedEl = q('#lastUpdated');
    if (lastUpdatedEl && data.generated_at) {
      const date = new Date(data.generated_at);
      lastUpdatedEl.textContent = `Last updated: ${date.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      })}`;
    }
    
    // Fill the table
    const distributionRowsEl = q('#distributionRows');
    if (distributionRowsEl && data.buckets) {
      distributionRowsEl.innerHTML = data.buckets.map(bucket => {
        const count = bucket.count || 0;
        const sum = bucket.sum || '0';
        const deltaCount = bucket.delta_count || {};
        
        // Format balance
        const balanceFormatted = fmtGram(sum);
        const balanceNumber = getGramNumber(sum);
        const usdValue = priceUSD ? (balanceNumber * priceUSD).toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 0,
          maximumFractionDigits: 0
        }) : '$—';
        
        // Calculate percentage of total supply
        const percentage = totalSupply > 0 ? ((balanceNumber / getGramNumber(totalSupply)) * 100).toFixed(2) : '0.00';
        
        // Format deltas
        const formatDelta = (value) => {
          if (value === undefined || value === null) return '—';
          if (value === 0) return '0';
          return value > 0 ? `+${value}` : `${value}`;
        };
        
        const getDeltaClass = (value) => {
          if (value === undefined || value === null) return 'delta-neutral';
          if (value > 0) return 'delta-positive';
          if (value < 0) return 'delta-negative';
          return 'delta-neutral';
        };
        
        return `
          <tr>
            <td>
              <div class="category-cell">
                <span class="category-emoji">${bucket.emoji || '💰'}</span>
                <div class="category-info">
                  <div class="category-name">${bucket.label || bucket.key || 'Unknown'}</div>
                  <div class="category-range">${bucket.range_label || ''}</div>
                </div>
              </div>
            </td>
            <td class="balance-range">${bucket.range_label || ''}</td>
            <td class="count-cell">${count.toLocaleString()}</td>
            <td class="delta-cell ${getDeltaClass(deltaCount['1h'])}">${formatDelta(deltaCount['1h'])}</td>
            <td class="delta-cell ${getDeltaClass(deltaCount['24h'])}">${formatDelta(deltaCount['24h'])}</td>
            <td class="delta-cell ${getDeltaClass(deltaCount['7d'])}">${formatDelta(deltaCount['7d'])}</td>
            <td class="delta-cell ${getDeltaClass(deltaCount['30d'])}">${formatDelta(deltaCount['30d'])}</td>
            <td class="delta-cell ${getDeltaClass(deltaCount['90d'])}">${formatDelta(deltaCount['90d'])}</td>
            <td class="total-balance-cell">
              <div class="balance-amount">${balanceFormatted}</div>
              <div class="balance-usd">${usdValue}</div>
            </td>
            <td class="percentage-cell">${percentage}%</td>
          </tr>
        `;
      }).join('');
    }
  } catch (e) {
    console.error('Error loading distribution data:', e);
    const distributionRowsEl = q('#distributionRows');
    if (distributionRowsEl) {
      distributionRowsEl.innerHTML = `<tr><td colspan="9" class="error">Error loading distribution data: ${e.message}</td></tr>`;
    }
  }
}

// Toggle для показа/скрытия значений
function initDistributionToggle() {
  const showValueToggle = q('#showValue');
  if (showValueToggle) {
    showValueToggle.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      // Here you can add logic for showing/hiding additional values
      console.log('Show value toggle:', isChecked);
    });
  }
}

// ===== boot =====
async function boot() {
  try {
    await loadPrice();
    setInterval(loadPrice, 60000); // update every minute
    await loadMeta();
    await loadStats();
    await loadTags();      // <<< добавить
    await loadHolders();
    await loadDistributionData(); // Load distribution data
    initDistributionToggle(); // Initialize toggle
  } catch (e) {
    rowsEl.innerHTML = `<tr><td colspan="5" class="error">Error: ${e.message}</td></tr>`;
    console.error(e);
  }
}

// ===== Support Modal =====
const supportBtn = q('#supportBtn');
const supportModal = q('#supportModal');
const modalClose = q('#modalClose');
const copyAddress = q('#copyAddress');
const walletAddress = q('#walletAddress');

// Open modal window
supportBtn.addEventListener('click', () => {
  supportModal.classList.add('show');
});

// Close modal window
modalClose.addEventListener('click', () => {
  supportModal.classList.remove('show');
});

// Close by clicking outside modal
supportModal.addEventListener('click', (e) => {
  if (e.target === supportModal) {
    supportModal.classList.remove('show');
  }
});

// Close by Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && supportModal.classList.contains('show')) {
    supportModal.classList.remove('show');
  }
});

// Copy address
copyAddress.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(walletAddress.textContent);
    
          // Temporary icon change for confirmation
    const originalHTML = copyAddress.innerHTML;
    copyAddress.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20,6 9,17 4,12"></polyline>
      </svg>
    `;
    copyAddress.style.background = '#10b981';
    
    setTimeout(() => {
      copyAddress.innerHTML = originalHTML;
      copyAddress.style.background = '';
    }, 2000);
  } catch (err) {
    console.error('Failed to copy: ', err);
    // Fallback для старых браузеров
    const textArea = document.createElement('textarea');
    textArea.value = walletAddress.textContent;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
  }
});



reloadBt.onclick = () => { page = 0; boot(); };
limitSel.onchange = () => { page = 0; boot(); };
prevBt.onclick = () => { if (page>0) { page--; boot(); } };
nextBt.onclick = () => { page++; boot(); };

boot();
