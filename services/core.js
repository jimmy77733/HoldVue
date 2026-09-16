'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.HOLDVUE_DATA_DIR
  ? path.resolve(process.env.HOLDVUE_DATA_DIR)
  : path.join(ROOT, 'app');
const APP_DIR = path.join(ROOT, 'app');
const ASSETS_DIR = path.join(ROOT, 'assets');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CACHE_FILE = path.join(DATA_DIR, 'quotes.json');
const FLAG_FILE = path.join(DATA_DIR, 'refresh.flag');
const PID_FILE = path.join(DATA_DIR, 'server.pid');
const PORT = Number(process.env.HOLDVUE_PORT || 18990);
const UA = 'Mozilla/5.0 (compatible; HoldVue/1.0)';

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    const template = path.join(APP_DIR, 'config.json');
    if (fs.existsSync(template)) fs.copyFileSync(template, CONFIG_FILE);
    else fs.writeFileSync(CONFIG_FILE, JSON.stringify({ columns: 2, symbols: [] }, null, 2), 'utf8');
  }
}

let prevNet = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}

function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += ch.codePointAt(0) > 0x2e7f ? 2 : 1;
  }
  return w;
}

function padLabel(s, width) {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

function padValue(s, width) {
  const w = displayWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

function formatPrice(v, prefix) {
  if (v == null || v === '' || v === '--') return '--';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  let t;
  if (n >= 1000) t = n.toFixed(0);
  else if (n >= 100) t = n.toFixed(1);
  else t = n.toFixed(2);
  return prefix ? prefix + t : t;
}

function formatRate(bps) {
  const kb = Math.max(0, bps) / 1024;
  if (kb >= 1024) return (kb / 1024).toFixed(2) + ' MB/s';
  return kb.toFixed(2) + ' KB/s';
}

function cpuPercent() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const c of cpus) {
    for (const t of Object.keys(c.times)) total += c.times[t];
    idle += c.times.idle;
  }
  if (!cpuPercent.prev) {
    cpuPercent.prev = { idle, total };
    return 0;
  }
  const di = idle - cpuPercent.prev.idle;
  const dt = total - cpuPercent.prev.total;
  cpuPercent.prev = { idle, total };
  if (dt <= 0) return 0;
  return Math.round((1 - di / dt) * 100);
}

function memPercent() {
  const total = os.totalmem();
  const free = os.freemem();
  return Math.round(((total - free) / total) * 100);
}

function netRates() {
  const nics = os.networkInterfaces();
  let rx = 0;
  let tx = 0;
  // Node os.networkInterfaces has no counters; approximate with /proc or powershell is hard.
  // Use process.hrtime sampling via optional reading — fallback zeros, updated by updater sample file if present.
  // Cross-platform: track using performance of getifaddrs is unavailable in pure node.
  // We'll use a lightweight internal counter based on previous quotes if systeminformation not installed.
  try {
    // Windows: typeperf is slow. Use zero-friendly defaults updated asynchronously.
    if (process.platform === 'linux' && fs.existsSync('/proc/net/dev')) {
      const text = fs.readFileSync('/proc/net/dev', 'utf8');
      for (const line of text.split('\n').slice(2)) {
        const p = line.trim().split(/\s+/);
        if (p.length < 10) continue;
        const name = p[0].replace(':', '');
        if (/lo|docker|veth|br-|isatap|Teredo/i.test(name)) continue;
        rx += Number(p[1]) || 0;
        tx += Number(p[9]) || 0;
      }
    }
  } catch {}

  const now = Date.now();
  if (!prevNet) {
    prevNet = { rx, tx, t: now };
    return { up: '0.00 KB/s', down: '0.00 KB/s' };
  }
  const dt = Math.max(0.001, (now - prevNet.t) / 1000);
  const up = (tx - prevNet.tx) / dt;
  const down = (rx - prevNet.rx) / dt;
  prevNet = { rx, tx, t: now };
  // On win/mac without counters, keep last known from external sampler
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return netRates.cached || { up: '0.00 KB/s', down: '0.00 KB/s' };
  }
  return { up: formatRate(up), down: formatRate(down) };
}

async function sampleNetWinMac() {
  try {
    if (process.platform === 'win32') {
      const { execFile } = require('child_process');
      const ps = `
$sent = (Get-Counter '\\Network Interface(*)\\Bytes Sent/sec' -EA SilentlyContinue).CounterSamples | ? { $_.InstanceName -notmatch 'isatap|Teredo|Loopback|Pseudo' } | Measure-Object CookedValue -Sum
$recv = (Get-Counter '\\Network Interface(*)\\Bytes Received/sec' -EA SilentlyContinue).CounterSamples | ? { $_.InstanceName -notmatch 'isatap|Teredo|Loopback|Pseudo' } | Measure-Object CookedValue -Sum
Write-Output (($sent.Sum|%{[double]$_});($recv.Sum|%{[double]$_}))
`;
      await new Promise((resolve) => {
        execFile('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, stdout) => {
          if (!err && stdout) {
            const parts = String(stdout).trim().split(/\s+/).map(Number);
            if (parts.length >= 2 && parts.every((n) => !Number.isNaN(n))) {
              netRates.cached = { up: formatRate(parts[0]), down: formatRate(parts[1]) };
            }
          }
          resolve();
        });
      });
    } else if (process.platform === 'darwin') {
      const { execFile } = require('child_process');
      await new Promise((resolve) => {
        execFile('netstat', ['-ib'], { timeout: 5000 }, (err, stdout) => {
          if (err || !stdout) return resolve();
          let rx = 0;
          let tx = 0;
          for (const line of stdout.split('\n').slice(1)) {
            const p = line.trim().split(/\s+/);
            if (p.length < 10) continue;
            if (/^lo|^gif|^stf|^awdl|^llw|^bridge|^utun/i.test(p[0])) continue;
            // Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes
            rx += Number(p[6]) || 0;
            tx += Number(p[9]) || 0;
          }
          const now = Date.now();
          if (sampleNetWinMac.prev) {
            const dt = Math.max(0.001, (now - sampleNetWinMac.prev.t) / 1000);
            netRates.cached = {
              up: formatRate((tx - sampleNetWinMac.prev.tx) / dt),
              down: formatRate((rx - sampleNetWinMac.prev.rx) / dt)
            };
          }
          sampleNetWinMac.prev = { rx, tx, t: now };
          resolve();
        });
      });
    }
  } catch {}
}

function yahooInTradingPeriod(period, nowSec) {
  if (!period || period.start == null || period.end == null) return false;
  return nowSec >= period.start && nowSec < period.end;
}

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 台股代碼常漏寫 .TW（例如 2327 → 2327.TW） */
function normalizeYahooSymbol(code) {
  let c = String(code || '').trim();
  if (!c) return c;
  if (c.startsWith('^')) return c;
  if (c.includes('.')) return c;
  if (/^\d{4,6}[A-Za-z]?$/i.test(c)) return c.toUpperCase() + '.TW';
  return c;
}

function calcChangePercent(price, prevClose, hinted) {
  const hint = asNum(hinted);
  if (hint != null) return hint;
  const p = asNum(price);
  const prev = asNum(prevClose);
  if (p == null || prev == null || prev === 0) return null;
  return ((p - prev) / prev) * 100;
}

/** 依 Yahoo 時段推斷盤前／盤中／盤後／休市 */
function resolveYahooSession(meta) {
  const nowSec = Math.floor(Date.now() / 1000);
  const tp = meta.currentTradingPeriod || {};
  if (yahooInTradingPeriod(tp.pre, nowSec)) return '盤前';
  if (yahooInTradingPeriod(tp.regular, nowSec)) return '盤中';
  if (yahooInTradingPeriod(tp.post, nowSec)) return '盤後';

  if (!meta.hasPrePostMarketData) {
    return '休市';
  }

  // 有延長交易：開盤前數小時仍視為盤前（Yahoo 常提前給出 fullday）
  if (tp.pre && nowSec < tp.pre.start) {
    const hoursUntilPre = (tp.pre.start - nowSec) / 3600;
    return hoursUntilPre <= 6 ? '盤前' : '休市';
  }
  if (tp.pre && tp.regular && nowSec >= tp.pre.start && nowSec < tp.regular.start) {
    return '盤前';
  }
  if (tp.regular && nowSec >= tp.regular.end) {
    if (tp.post && nowSec < tp.post.end) return '盤後';
    if (tp.post && nowSec >= tp.post.end) {
      const hoursAfterPost = (nowSec - tp.post.end) / 3600;
      return hoursAfterPost <= 3 ? '盤後' : '休市';
    }
    return '盤後';
  }
  return '休市';
}

/** 美股等有盤前／盤後時用 fullday；其餘用 regularMarketPrice */
function pickYahooQuote(meta) {
  const regular = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose ?? meta.previousClose;
  const nowSec = Math.floor(Date.now() / 1000);
  const tp = meta.currentTradingPeriod || {};
  const inPre = yahooInTradingPeriod(tp.pre, nowSec);
  const inPost = yahooInTradingPeriod(tp.post, nowSec);
  const inRegular = yahooInTradingPeriod(tp.regular, nowSec);
  const session = resolveYahooSession(meta);

  let price;
  let changePercent;

  if (meta.hasPrePostMarketData && (inPre || inPost || session === '盤前' || session === '盤後')) {
    price = asNum(meta.fulldayPrice)
      ?? asNum(meta.preMarketPrice)
      ?? asNum(meta.postMarketPrice)
      ?? asNum(regular)
      ?? asNum(prevClose);
    changePercent = calcChangePercent(price, prevClose, meta.fulldayChangePercent ?? meta.regularMarketChangePercent);
  } else if (inRegular || session === '盤中') {
    price = asNum(regular) ?? asNum(prevClose);
    changePercent = calcChangePercent(price, prevClose, meta.regularMarketChangePercent);
  } else if (meta.hasPrePostMarketData) {
    price = asNum(meta.fulldayPrice) ?? asNum(regular) ?? asNum(prevClose);
    changePercent = calcChangePercent(
      price,
      prevClose,
      meta.fulldayChangePercent ?? meta.regularMarketChangePercent
    );
  } else {
    price = asNum(regular) ?? asNum(prevClose);
    changePercent = calcChangePercent(price, prevClose, meta.regularMarketChangePercent);
  }

  return { price, changePercent, session };
}

async function fetchYahoo(symbol) {
  const enc = encodeURIComponent(normalizeYahooSymbol(symbol));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?interval=1m&range=1d&includePrePost=true`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error('yahoo ' + res.status);
  const data = await res.json();
  if (!data.chart || !data.chart.result || !data.chart.result[0]) {
    throw new Error('yahoo no data for ' + normalizeYahooSymbol(symbol));
  }
  const meta = data.chart.result[0].meta;
  const q = pickYahooQuote(meta);
  if (q.price == null) throw new Error('yahoo no price');
  return {
    ok: true,
    symbol: String(meta.symbol),
    price: q.price,
    changePercent: q.changePercent,
    session: q.session,
    source: 'yahoo'
  };
}

/** CoinGecko 容易限流：批次請求 + 降頻；失敗沿用上次成功值 */
const COIN_MIN_INTERVAL_MS = 90 * 1000;
const coinState = {
  lastFetchAt: 0,
  byId: Object.create(null) // coingecko id -> { price, changePercent, session, at }
};

async function fetchCoinsBatch(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return {};
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${unique.map(encodeURIComponent).join(',')}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('coingecko ' + res.status);
  const data = await res.json();
  const out = {};
  for (const id of unique) {
    const price = data?.[id]?.usd;
    if (price == null) continue;
    out[id] = {
      ok: true,
      symbol: id,
      price: Number(price),
      changePercent: asNum(data?.[id]?.usd_24h_change),
      session: '24h',
      source: 'coingecko'
    };
  }
  return out;
}

async function fetchCoin(id) {
  const batch = await fetchCoinsBatch([id]);
  const r = batch[id];
  if (!r) throw new Error('no price for ' + id);
  return r;
}

function rememberQuote(id, price, changePercent, session) {
  return {
    price,
    changePercent: changePercent == null ? null : Number(changePercent),
    session: session || null
  };
}

function fallbackQuote(id, prevDetail, cgId) {
  if (cgId && coinState.byId[cgId]) {
    const c = coinState.byId[cgId];
    return rememberQuote(id, c.price, c.changePercent, c.session || '24h');
  }
  const p = prevDetail && prevDetail[id];
  if (p && p.price != null && Number.isFinite(Number(p.price))) {
    return rememberQuote(id, Number(p.price), p.changePercent, p.session || null);
  }
  return null;
}

function buildPanel(cfg, values, sys) {
  const cols = Math.max(1, Number(cfg.columns) || 2);
  const lw = Math.max(4, Number(cfg.labelWidth) || 7);
  const vw = Math.max(6, Number(cfg.valueWidth) || 9);
  const cells = (cfg.symbols || []).map((s) => {
    const label = padLabel(String(s.label || s.id), lw);
    const val = padValue(formatPrice(values[s.id], s.prefix), vw);
    return `${label} ${val}`;
  });
  const lines = [];
  lines.push(`CPU ${String(sys.cpu).padStart(3)}%   RAM ${String(sys.mem).padStart(3)}%`);
  lines.push('-'.repeat(Math.min(36, (lw + vw + 2) * cols)));
  for (let i = 0; i < cells.length; i += cols) {
    lines.push(cells.slice(i, i + cols).join('  '));
  }
  return lines.join('\n');
}

async function updateOnce() {
  await sampleNetWinMac();
  const cfg = readJson(CONFIG_FILE, { columns: 2, symbols: [] });
  const prev = readJson(CACHE_FILE, {});
  const prevDetail = prev.detail && typeof prev.detail === 'object' ? prev.detail : {};
  const values = {};
  const detail = {};

  const coinSymbols = (cfg.symbols || []).filter((s) => s.coingecko);
  const yahooSymbols = (cfg.symbols || []).filter((s) => s.yahoo && !s.coingecko);
  const now = Date.now();
  const dueCoin = now - coinState.lastFetchAt >= COIN_MIN_INTERVAL_MS;

  let coinBatch = null;
  if (coinSymbols.length) {
    const needFresh = dueCoin || coinSymbols.some((s) => {
      const cg = String(s.coingecko);
      return !coinState.byId[cg] && !fallbackQuote(String(s.id), prevDetail, cg);
    });
    if (needFresh) {
      try {
        coinBatch = await fetchCoinsBatch(coinSymbols.map((s) => String(s.coingecko)));
        coinState.lastFetchAt = now;
        for (const [cgId, r] of Object.entries(coinBatch)) {
          coinState.byId[cgId] = {
            price: r.price,
            changePercent: r.changePercent,
            session: '24h',
            at: now
          };
        }
      } catch (e) {
        console.error('coingecko', e.message || e);
        coinBatch = null;
      }
    }
  }

  for (const s of yahooSymbols) {
    const id = String(s.id);
    try {
      const r = await fetchYahoo(String(s.yahoo));
      values[id] = r.price;
      detail[id] = rememberQuote(id, r.price, r.changePercent, r.session);
    } catch {
      const fb = fallbackQuote(id, prevDetail, null);
      if (fb) {
        values[id] = fb.price;
        detail[id] = fb;
      } else {
        values[id] = '--';
        detail[id] = { price: null, changePercent: null, session: null };
      }
    }
  }

  for (const s of coinSymbols) {
    const id = String(s.id);
    const cgId = String(s.coingecko);
    const fresh = coinBatch && coinBatch[cgId];
    if (fresh) {
      values[id] = fresh.price;
      detail[id] = rememberQuote(id, fresh.price, fresh.changePercent, '24h');
      continue;
    }
    const fb = fallbackQuote(id, prevDetail, cgId);
    if (fb) {
      values[id] = fb.price;
      detail[id] = fb;
    } else {
      values[id] = '--';
      detail[id] = { price: null, changePercent: null, session: '24h' };
    }
  }

  const net = netRates();
  const sys = {
    cpu: String(cpuPercent()),
    mem: String(memPercent()),
    up: net.up,
    down: net.down
  };
  const out = {
    panel: buildPanel(cfg, values, sys),
    CPU: sys.cpu,
    RAM: sys.mem,
    UP: sys.up,
    DOWN: sys.down,
    updated: new Date().toLocaleTimeString('en-GB', { hour12: false }),
    detail
  };
  for (const [k, v] of Object.entries(values)) out[k] = formatPrice(v, null);
  writeJson(CACHE_FILE, out);
}

function contentType(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.png': return 'image/png';
    case '.ico': return 'image/x-icon';
    case '.json': return 'application/json; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

function send(res, code, type, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(buf);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let p = u.pathname;
    if (p === '/') p = '/index.html';
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    if (p === '/api/quotes') {
      const json = fs.existsSync(CACHE_FILE)
        ? fs.readFileSync(CACHE_FILE, 'utf8')
        : '{"panel":"--","updated":"--"}';
      return send(res, 200, 'application/json; charset=utf-8', json);
    }

    if (p === '/api/config' && method === 'GET') {
      return send(res, 200, 'application/json; charset=utf-8', fs.readFileSync(CONFIG_FILE, 'utf8'));
    }

    if (p === '/api/config' && method === 'POST') {
      try {
        const obj = JSON.parse(await readBody(req));
        if (!obj.symbols) throw new Error('symbols required');
        // 正規化 yahoo 代碼，避免 2327 這種缺 .TW 導致永遠 --
        obj.symbols = (obj.symbols || []).map((s) => {
          if (s && s.yahoo) s.yahoo = normalizeYahooSymbol(s.yahoo);
          return s;
        });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf8');
        try { if (fs.existsSync(FLAG_FILE)) fs.unlinkSync(FLAG_FILE); } catch {}
        try { await updateOnce(); } catch (e) {
          return send(res, 200, 'application/json; charset=utf-8',
            JSON.stringify({ ok: true, warn: String(e.message || e) }));
        }
        return send(res, 200, 'application/json; charset=utf-8', '{"ok":true}');
      } catch (e) {
        return send(res, 400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    }

    if (p === '/api/refresh' && method === 'POST') {
      try {
        await updateOnce();
        return send(res, 200, 'application/json; charset=utf-8', '{"ok":true}');
      } catch (e) {
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    }

    if (p === '/api/test' && method === 'POST') {
      try {
        const item = JSON.parse(await readBody(req));
        let r;
        if (item.coingecko) r = await fetchCoin(String(item.coingecko));
        else if (item.yahoo) {
          item.yahoo = normalizeYahooSymbol(item.yahoo);
          r = await fetchYahoo(String(item.yahoo));
        } else throw new Error('需要 yahoo 或 coingecko 代碼');
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(r));
      } catch (e) {
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    }

    const rel = decodeURIComponent(p.replace(/^\//, ''));
    let candidate = rel.startsWith('assets/')
      ? path.join(ROOT, rel)
      : path.join(APP_DIR, rel);
    candidate = path.normalize(candidate);
    if (!candidate.startsWith(APP_DIR) && !candidate.startsWith(ASSETS_DIR) && !candidate.startsWith(path.join(ROOT, 'assets'))) {
      return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
    }
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return send(res, 200, contentType(candidate), fs.readFileSync(candidate));
    }
    send(res, 404, 'text/plain; charset=utf-8', 'not found');
  } catch {
    try { send(res, 500, 'text/plain; charset=utf-8', 'error'); } catch {}
  }
});

function shutdown() {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch {}
  try { server.close(); } catch {}
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

fs.mkdirSync(DATA_DIR, { recursive: true });
ensureDataFiles();
fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`HoldVue service http://127.0.0.1:${PORT}/`);
  try { await updateOnce(); } catch (e) { console.error('update', e.message || e); }
  setInterval(async () => {
    try {
      if (fs.existsSync(FLAG_FILE)) {
        try { fs.unlinkSync(FLAG_FILE); } catch {}
      }
      await updateOnce();
    } catch (e) {
      console.error('update', e.message || e);
    }
  }, 15000);
});
