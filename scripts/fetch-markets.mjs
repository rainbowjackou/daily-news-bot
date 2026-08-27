#!/usr/bin/env node
/**
 * 抓取全球市场行情（前收盘）并做多源交叉校验，写入 markets.json
 *
 * 数据源：
 *   - 新浪财经 hq.sinajs.cn   （A股/港股/美股/国际期货/汇率）
 *   - 腾讯财经 qt.gtimg.cn    （A股/港股/美股/国际期货）
 *   - 东方财富 push2          （美股/港股/日经/富时）
 * 交叉校验：同一市场两个及以上源数值偏差 <0.5% 视为一致（verified=true）；
 *           仅单一来源时 verified=false（简报中标注"单一来源"）。
 *
 * 用法: node scripts/fetch-markets.mjs
 * 输出: markets.json（仓库根目录）
 * 退出码: 0 = 抓到至少 1 项；1 = 全部失败
 */
import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

/* ------------------------------ 工具 ------------------------------ */

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const num = (s) => {
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : NaN;
};

function round(v, d = 2) {
  return Number(v.toFixed(d));
}

async function getJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/* ------------------------------ 各源抓取 ------------------------------ */

// 新浪：返回 var hq_str_xxx="..."; 多行
async function fetchSina(symbols) {
  const url = `https://hq.sinajs.cn/list=${symbols.join(',')}`;
  const text = await getJson(url, { referer: 'https://finance.sina.com.cn' });
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/hq_str_([^=]+)="([^"]*)"/);
    if (!m) continue;
    const code = m[1];
    const f = m[2].split(',');
    if (!f[0]) continue;
    out[code] = f;
  }
  return out;
}

// 腾讯：返回 v_xxx="..."; 多行（A股/美股/港股按 ~ 分隔；国际期货按 , 分隔）
async function fetchTencent(symbols) {
  const url = `https://qt.gtimg.cn/q=${symbols.join(',')}`;
  const text = await getJson(url);
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/v_([^=]+)="([^"]*)"/);
    if (!m) continue;
    const code = m[1];
    const raw = m[2];
    if (!raw) continue;
    out[code] = raw.includes('~') ? raw.split('~') : raw.split(',');
  }
  return out;
}

// 东方财富：JSON
async function fetchEastmoney(secids) {
  const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids.join(',')}&fields=f12,f14,f2,f3,f18`;
  const text = await getJson(url);
  const data = JSON.parse(text).data;
  return (data && data.diff) || [];
}

/* ------------------------------ 解析 ------------------------------ */

// 新浪各市场解析
function parseSina(code, f) {
  if (code.startsWith('sh') || code.startsWith('sz')) {
    // A股: [0]名称 [1]今开 [2]昨收 [3]最新 [30]日期 [31]时间
    const value = num(f[3]);
    const prev = num(f[2]);
    if (!value) return null;
    return { value, prevClose: prev, pct: prev ? round(((value - prev) / prev) * 100) : null, time: `${f[30]} ${f[31]}`.trim() };
  }
  if (code === 'hkHSI') {
    // [0]HSI [1]名称 [2]今开 [3]昨收 [4]最高 [5]最低 [6]最新 [7]涨跌额 [8]涨跌幅 [17]日期 [18]时间
    const value = num(f[6]);
    if (!value) return null;
    return { value, prevClose: num(f[3]), pct: num(f[8]), time: `${f[17]} ${f[18]}`.trim() };
  }
  if (code.startsWith('gb_$')) {
    // [0]名称 [1]最新 [2]涨跌幅 [3]时间 [24]美东时间 [25]昨收
    const value = num(f[1]);
    if (!value) return null;
    return { value, prevClose: num(f[25]), pct: num(f[2]), time: f[3] };
  }
  if (code.startsWith('hf_')) {
    // 国际期货: [0]最新 [6]时间 [13]名称
    const value = num(f[0]);
    if (!value) return null;
    return { value, prevClose: NaN, pct: null, time: f[6] };
  }
  if (code.startsWith('fx_')) {
    // 汇率: [1]最新 [9]名称
    const value = num(f[1]);
    if (!value) return null;
    return { value, prevClose: NaN, pct: null, time: f[0] };
  }
  return null;
}

// 腾讯解析
function parseTencent(code, f) {
  if (f.length > 20 && f[1] && f[3]) {
    // 普通行情（~分隔）: [1]名称 [3]最新 [4]昨收 [30]时间 [32]涨跌幅
    const value = num(f[3]);
    if (!value) return null;
    return { value, prevClose: num(f[4]), pct: num(f[32]) || null, time: f[30] };
  }
  if (f.length > 10 && f[0]) {
    // 国际期货（,分隔）: [0]最新 [1]涨跌幅 [6]时间 [13]名称
    const value = num(f[0]);
    if (!value) return null;
    return { value, prevClose: NaN, pct: num(f[1]) || null, time: f[6] };
  }
  return null;
}

/* ------------------------------ 交叉校验 ------------------------------ */

function merge(name, group, entries, decimals = 2) {
  const valid = entries.filter((e) => e && Number.isFinite(e.value));
  if (valid.length === 0) return null;
  const base = valid[0].value;
  const agree = valid.filter((e) => Math.abs((e.value - base) / base) < 0.005);
  const best = agree[0] || valid[0];
  // 涨跌幅：优先取各源显式给出的 pct，其次由昨收计算
  const pctEntry = agree.find((e) => Number.isFinite(e.pct)) || valid.find((e) => Number.isFinite(e.pct));
  let pct = pctEntry ? pctEntry.pct : best.pct;
  if ((pct === null || pct === undefined || Number.isNaN(pct)) && Number.isFinite(best.prevClose) && best.prevClose !== 0) {
    pct = ((best.value - best.prevClose) / best.prevClose) * 100;
  }
  return {
    name,
    group,
    value: round(best.value, decimals),
    pct: pct !== null && pct !== undefined && !Number.isNaN(pct) ? round(pct, 2) : null,
    time: best.time || '',
    sources: [...new Set(valid.map((e) => e.src))],
    verified: agree.length >= 2,
  };
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  log('=== 市场数据抓取开始 ===');
  const sinaCodes = ['sh000001', 'sz399001', 'sz399006', 'hkHSI', 'gb_$dji', 'gb_$inx', 'gb_$ixic', 'hf_GC', 'hf_CL', 'hf_OIL', 'hf_SI', 'fx_susdcny'];
  const tencentCodes = ['sh000001', 'sz399001', 'sz399006', 'hkHSI', 'usDJI', 'usINX', 'usIXIC', 'hf_GC', 'hf_CL', 'hf_OIL', 'hf_SI'];
  const emSecids = ['100.N225', '100.KS11', '100.FTSE', '100.DJIA', '100.NDX', '100.SPX', '100.HSI'];

  const sina = {}, tencent = {}, eastmoney = {};
  await Promise.allSettled([
    fetchSina(sinaCodes).then((d) => Object.assign(sina, d)),
    fetchTencent(tencentCodes).then((d) => Object.assign(tencent, d)),
    fetchEastmoney(emSecids).then((d) => (eastmoney.diff = d)),
  ]);

  log(`[源] 新浪 ${Object.keys(sina).length} 项 / 腾讯 ${Object.keys(tencent).length} 项 / 东财 ${(eastmoney.diff || []).length} 项`);

  const markets = [];
  const names = {
    sh000001: '上证指数', sz399001: '深证成指', sz399006: '创业板指', hkHSI: '恒生指数',
    'gb_$dji': '道琼斯', 'gb_$inx': '标普500', 'gb_$ixic': '纳斯达克',
    hf_GC: '纽约黄金', hf_SI: '纽约白银', hf_CL: 'WTI原油', hf_OIL: '布伦特原油', fx_susdcny: '美元兑人民币(在岸)',
  };
  const tencentNames = {
    sh000001: '上证指数', sz399001: '深证成指', sz399006: '创业板指', hkHSI: '恒生指数',
    usDJI: '道琼斯', usINX: '标普500', usIXIC: '纳斯达克',
    hf_GC: '纽约黄金', hf_SI: '纽约白银', hf_CL: 'WTI原油', hf_OIL: '布伦特原油',
  };

  // 组表：code -> {name, group, decimals, sina?, tencent?, em?}
  const table = [
    { name: '道琼斯', group: '美股', decimals: 2, sina: 'gb_$dji', tencent: 'usDJI', em: 'DJIA' },
    { name: '标普500', group: '美股', decimals: 2, sina: 'gb_$inx', tencent: 'usINX', em: 'SPX' },
    { name: '纳斯达克', group: '美股', decimals: 2, sina: 'gb_$ixic', tencent: 'usIXIC', em: 'NDX' },
    { name: '上证指数', group: '中国A股', decimals: 2, sina: 'sh000001', tencent: 'sh000001' },
    { name: '深证成指', group: '中国A股', decimals: 2, sina: 'sz399001', tencent: 'sz399001' },
    { name: '创业板指', group: '中国A股', decimals: 2, sina: 'sz399006', tencent: 'sz399006' },
    { name: '恒生指数', group: '中国港股', decimals: 2, sina: 'hkHSI', tencent: 'hkHSI', em: 'HSI' },
    { name: '日经225', group: '日本', decimals: 2, em: 'N225' },
    { name: '韩国KOSPI', group: '韩国', decimals: 2, em: 'KS11' },
    { name: '英国富时100', group: '欧洲', decimals: 2, em: 'FTSE' },
    { name: '纽约黄金', group: '期货商品', decimals: 2, sina: 'hf_GC', tencent: 'hf_GC' },
    { name: '纽约白银', group: '期货商品', decimals: 2, sina: 'hf_SI', tencent: 'hf_SI' },
    { name: 'WTI原油', group: '期货商品', decimals: 2, sina: 'hf_CL', tencent: 'hf_CL' },
    { name: '布伦特原油', group: '期货商品', decimals: 2, sina: 'hf_OIL', tencent: 'hf_OIL' },
    { name: '美元兑人民币(在岸)', group: '汇率', decimals: 4, sina: 'fx_susdcny' },
  ];

  for (const row of table) {
    const entries = [];
    if (row.sina && sina[row.sina]) {
      const p = parseSina(row.sina, sina[row.sina]);
      if (p) entries.push({ ...p, src: '新浪' });
    }
    if (row.tencent && tencent[row.tencent]) {
      const p = parseTencent(row.tencent, tencent[row.tencent]);
      if (p) entries.push({ ...p, src: '腾讯' });
    }
    if (row.em) {
      const em = (eastmoney.diff || []).find((x) => x.f12 === row.em);
      if (em && num(em.f2)) {
        entries.push({ value: num(em.f2), prevClose: num(em.f18), pct: num(em.f3), time: '', src: '东方财富' });
      }
    }
    const m = merge(row.name, row.group, entries, row.decimals);
    if (m) markets.push(m);
  }

  if (markets.length === 0) {
    console.error('[致命] 所有行情源均失败');
    process.exit(1);
  }

  const out = { fetchedAt: new Date().toISOString(), markets };
  writeFileSync('markets.json', JSON.stringify(out, null, 2) + '\n');
  for (const m of markets) {
    log(`[行情] ${m.group} ${m.name}: ${m.value} (${m.pct !== null ? m.pct + '%' : '—'}) 源:${m.sources.join('+')} ${m.verified ? '✅多源一致' : '⚠️单一来源'}`);
  }
  log(`[完成] 共 ${markets.length} 项市场数据，已写入 markets.json`);
  log('=== 市场数据抓取结束 ===');
}

main().catch((e) => {
  console.error('[致命] 未捕获异常:', e);
  process.exit(1);
});
