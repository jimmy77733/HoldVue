'use strict';
/**
 * Build app/symbol-dict.json from official TWSE/TPEx ISIN lists + Nasdaq screener.
 * Usage: node scripts/build-symbol-dict.js
 *
 * Sources:
 *  - https://isin.twse.com.tw/isin/C_public.jsp?strMode=2 (上市)
 *  - https://isin.twse.com.tw/isin/C_public.jsp?strMode=4 (上櫃)
 *  - TWSE/TPEx daily quotes (volume ranking)
 *  - Nasdaq stock screener (US market cap ranking)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const iconv = require('iconv-lite');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tmp');
const OUT = path.join(ROOT, 'app', 'symbol-dict.json');
const EXISTING = OUT;

const TW_LIMIT = 1500;
const US_LIMIT = 500;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function fetchBuffer(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HoldVueDictBuilder/1.0)',
        Accept: '*/*',
        ...headers
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchBuffer(res.headers.location, headers));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

async function ensureSources() {
  fs.mkdirSync(TMP, { recursive: true });
  const jobs = [
    ['isin_listed.html', 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=2'],
    ['isin_otc.html', 'https://isin.twse.com.tw/isin/C_public.jsp?strMode=4'],
    ['twse_day.json', 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL'],
    ['tpex_day.json', 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'],
    ['nasdaq_all.json', 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=25&offset=0&download=true']
  ];
  for (const [name, url] of jobs) {
    const dest = path.join(TMP, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      console.log('keep', name);
      continue;
    }
    console.log('download', name);
    const buf = await fetchBuffer(url, name.startsWith('nasdaq') ? { Accept: 'application/json' } : {});
    fs.writeFileSync(dest, buf);
  }
}

function parseIsinHtml(buf, board) {
  const html = iconv.decode(buf, 'big5');
  const include = new Set(['股票', 'ETF', 'ETN', '創新板']);
  const out = [];
  let section = '';
  // Split by section headers like `股票 <B>`
  const parts = html.split(/>([^<>]{1,40})\s*<B>\s*</);
  // parts: [before, title1, body1, title2, body2, ...]
  for (let i = 1; i < parts.length; i += 2) {
    section = String(parts[i] || '').trim();
    const body = parts[i + 1] || '';
    if (!include.has(section)) continue;
    const cells = [...body.matchAll(/<td[^>]*bgcolor=#FAFAD2>([^<]*)<\/td>/gi)].map((m) =>
      String(m[1] || '').replace(/\u00a0/g, ' ').trim()
    );
    for (let c = 0; c < cells.length; c += 7) {
      const raw = cells[c] || '';
      // "2330　台積電" or "00631L　元大台灣50正2"
      const m = raw.match(/^([0-9A-Za-z]+)\s*[　\s]+(.+)$/);
      if (!m) continue;
      const code = m[1].trim().toUpperCase();
      const name = m[2].trim();
      if (!code || !name) continue;
      // skip pure warrants-like if slipped in
      if (/^[0-9]{4,6}[PQC]$/i.test(code) && section === '股票') {
        // keep; some are real
      }
      const suffix = board === 'TWO' ? '.TWO' : '.TW';
      const kind = section === 'ETF' || section === 'ETN' ? section : 'stock';
      out.push({
        code,
        name,
        yahoo: code + suffix,
        board,
        kind,
        section
      });
    }
  }
  return out;
}

function volumeMap() {
  const map = new Map();
  const twse = readJson(path.join(TMP, 'twse_day.json'), []);
  if (Array.isArray(twse)) {
    twse.forEach((r) => {
      const code = String(r.Code || '').trim().toUpperCase();
      const vol = Number(String(r.TradeVolume || '0').replace(/,/g, '')) || 0;
      const val = Number(String(r.TradeValue || '0').replace(/,/g, '')) || 0;
      if (code) map.set(code, { vol, val, name: String(r.Name || '').trim() });
    });
  }
  const tpex = readJson(path.join(TMP, 'tpex_day.json'), []);
  if (Array.isArray(tpex)) {
    tpex.forEach((r) => {
      const code = String(r.SecuritiesCompanyCode || '').trim().toUpperCase();
      const vol = Number(String(r.TradingShares || '0').replace(/,/g, '')) || 0;
      const val = Number(String(r.TransactionAmount || '0').replace(/,/g, '')) || 0;
      if (!code) return;
      const prev = map.get(code);
      if (!prev || val > prev.val) {
        map.set(code, { vol, val, name: String(r.CompanyName || '').trim() });
      }
    });
  }
  return map;
}

function buildTw() {
  const listed = parseIsinHtml(fs.readFileSync(path.join(TMP, 'isin_listed.html')), 'TW');
  const otc = parseIsinHtml(fs.readFileSync(path.join(TMP, 'isin_otc.html')), 'TWO');
  const all = [...listed, ...otc];
  const byCode = new Map();
  all.forEach((x) => {
    if (!byCode.has(x.code)) byCode.set(x.code, x);
  });
  const vols = volumeMap();
  const ranked = [...byCode.values()].map((x) => {
    const v = vols.get(x.code) || { vol: 0, val: 0 };
    // Boost ETF/ETN slightly so leveraged products stay visible even mid-volume
    const boost = x.kind === 'ETF' || x.kind === 'ETN' ? 1.15 : 1;
    return { ...x, score: (v.val || v.vol || 0) * boost, vol: v.vol, val: v.val };
  });
  ranked.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));

  const indices = [
    { label: '加權', code: '^TWII', aliases: ['TAIEX', '台灣加權', '加權指數', 'TWII'] },
    { label: '櫃買', code: '^TWOII', aliases: ['OTC指數', '櫃買指數', 'TWOII'] }
  ];

  const picked = ranked.slice(0, TW_LIMIT);
  const entries = indices.concat(
    picked.map((x) => {
      const aliases = [];
      if (x.name && x.name !== x.code) aliases.push(x.name);
      if (x.kind === 'ETF') aliases.push('ETF');
      if (x.kind === 'ETN') aliases.push('ETN');
      if (/L$/i.test(x.code)) aliases.push('槓桿', '正2');
      if (/R$/i.test(x.code)) aliases.push('反向', '反1');
      // dedupe aliases
      const uniq = [...new Set(aliases.filter(Boolean))];
      return {
        label: x.code,
        code: x.yahoo,
        aliases: uniq
      };
    })
  );
  return { entries, stats: { listed: listed.length, otc: otc.length, unique: byCode.size, picked: picked.length } };
}

function cleanUsName(name) {
  return String(name || '')
    .replace(/\s+Common Stock.*/i, '')
    .replace(/\s+Ordinary Shares.*/i, '')
    .replace(/\s+Class [A-Z].*/i, '')
    .replace(/\s+ADR.*/i, ' ADR')
    .replace(/\s+American Depositary Shares.*/i, ' ADR')
    .replace(/\s+ETF$/i, '')
    .trim();
}

function buildUs() {
  const nasdaq = readJson(path.join(TMP, 'nasdaq_all.json'), null);
  let rows = (nasdaq && nasdaq.data && nasdaq.data.rows) || [];
  rows = rows
    .map((r) => ({
      symbol: String(r.symbol || '').trim().toUpperCase(),
      name: cleanUsName(r.name),
      marketCap: Number(String(r.marketCap || '0').replace(/,/g, '')) || 0,
      volume: Number(String(r.volume || '0').replace(/,/g, '')) || 0,
      sector: String(r.sector || '')
    }))
    .filter((r) => r.symbol && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(r.symbol))
    .filter((r) => !r.symbol.includes('^'));

  rows.sort((a, b) => b.marketCap - a.marketCap || b.volume - a.volume || a.symbol.localeCompare(b.symbol));

  const indices = [
    { label: 'NDQ', code: '^NDX', aliases: ['Nasdaq100', '那斯達克100', 'NDX', 'QQQ'] },
    { label: 'SOX', code: '^SOX', aliases: ['費半', '半導體指數', 'SOXX'] },
    { label: 'DJI', code: '^DJI', aliases: ['道瓊', 'Dow', '道琼斯'] },
    { label: 'SPX', code: '^GSPC', aliases: ['S&P500', '標普500', 'SP500'] },
    { label: 'VIX', code: '^VIX', aliases: ['恐慌指數', 'VIX'] }
  ];

  const seen = new Set(indices.map((x) => x.code));
  const picked = [];
  for (const r of rows) {
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    const aliases = [];
    if (r.name && r.name.toUpperCase() !== r.symbol) aliases.push(r.name);
    picked.push({
      label: r.symbol,
      code: r.symbol,
      aliases: [...new Set(aliases)]
    });
    if (picked.length >= US_LIMIT) break;
  }
  return { entries: indices.concat(picked), stats: { source: rows.length, picked: picked.length } };
}

async function main() {
  await ensureSources();
  if (!fs.existsSync(path.join(TMP, 'isin_listed.html'))) {
    console.error('Missing tmp/isin_listed.html — download ISIN pages first');
    process.exit(1);
  }
  const prev = readJson(EXISTING, { coin: [] });
  const coin = Array.isArray(prev.coin) && prev.coin.length ? prev.coin : [
    { label: 'BTC', code: 'bitcoin', aliases: ['比特幣', 'Bitcoin', 'XBT'], prefix: '$' },
    { label: 'ETH', code: 'ethereum', aliases: ['以太坊', 'Ethereum'], prefix: '$' }
  ];

  const tw = buildTw();
  const us = buildUs();
  const out = { tw: tw.entries, us: us.entries, coin };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
  console.log('Wrote', OUT);
  console.log('TW:', tw.stats, 'entries', tw.entries.length);
  console.log('US:', us.stats, 'entries', us.entries.length);
  console.log('Coin:', coin.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
