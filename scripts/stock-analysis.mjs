#!/usr/bin/env node
/**
 * 单只股票分析：实时行情（东财+腾讯双源）→ 日K线技术指标 → 相关新闻 → OpenRouter 分析
 *
 * 用法: node scripts/stock-analysis.mjs [--out stock-report.md]
 * 环境变量:
 *   DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL（同 format-digest，支持多模型逗号分隔）
 *   STOCK_SECID=1.600519  STOCK_NAME=贵州茅台  STOCK_KEYWORDS=茅台,贵州茅台（覆盖默认标的）
 *   NEWS_MAX_TOPIC=10（相关新闻条数上限）
 * 输出: stock-report.md + digests/stock/<日期>-<代码>.md
 * 退出码: 0 正常（含 AI 降级）；1 = 行情获取失败
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const OUT = arg('--out', 'stock-report.md');
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const API_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODELS = (process.env.DEEPSEEK_MODEL || 'deepseek-chat').split(',').map((s) => s.trim()).filter(Boolean);
const NEWS_MAX = Number(process.env.NEWS_MAX_TOPIC || 10);
const LLM_TIMEOUT_MS = 180000;
const FETCH_TIMEOUT_MS = 25000;

// 网络请求自动重试（瞬断/超时自动重试，最多 attempts 次）
async function fetchRetry(fn, attempts = 3, label = '请求') {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts) {
        log(`[重试] ${label} 第 ${i} 次失败（${e.message}），${3000}ms 后重试`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  throw lastErr;
}

// 默认标的：贵州茅台（可改这里，或用环境变量覆盖）
let STOCKS = [
  { secid: '1.600519', name: '贵州茅台', code: '600519', keywords: ['茅台', '贵州茅台'] },
];
if (process.env.STOCK_SECID) {
  STOCKS = [{
    secid: process.env.STOCK_SECID,
    name: process.env.STOCK_NAME || process.env.STOCK_SECID,
    code: process.env.STOCK_SECID.split('.').pop(),
    keywords: (process.env.STOCK_KEYWORDS || process.env.STOCK_NAME || '').split(',').filter(Boolean),
  }];
}

// 相关新闻源（标题含关键词即命中）
const NEWS_FEEDS = [
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', name: 'BBC商业' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', name: 'CNBC' },
  { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html', name: 'CNBC经济' },
  { url: 'https://www.chinanews.com.cn/rss/finance.xml', name: '中新网财经' },
  { url: 'https://rsshub.app/36kr/newsflashes', name: '36氪', rsshub: true },
  { url: 'https://rsshub.app/caixin/latest', name: '财新', rsshub: true },
  { url: 'https://www.ithome.com/rss/', name: 'IT之家' },
  { url: 'https://www.solidot.org/index.rss', name: 'Solidot' },
];

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/* ------------------------------ 工具 ------------------------------ */

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&amp;/g, '&');
}
function stripHtml(s) {
  return decodeEntities(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function parseFeed(xml) {
  const items = [];
  const blocks = xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi);
  for (const m of blocks) {
    const body = m[2];
    const t = body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const link = body.match(/<link\b[^>]*\shref="([^"]+)"[^>]*\/?>/i) || body.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
    const title = t ? stripHtml(t[1]) : '';
    if (!title) continue;
    items.push({ title: title.slice(0, 200), link: link ? decodeEntities(link[1] || link[2] || '').trim() : '' });
  }
  return items;
}

/* ------------------------------ 行情数据 ------------------------------ */

// 东财实时行情（价格字段为"分"，÷100）
async function fetchEastmoneyQuote(secid) {
  return fetchRetry(async () => {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f57,f58,f60,f169,f170,f47,f48,f162,f167,f116,f117`;
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const j = await res.json();
    const d = j?.data;
    if (!d || !d.f58) throw new Error('东财行情无数据');
    const div = (v) => (typeof v === 'number' && Number.isFinite(v) ? v / 100 : null);
    return {
      name: d.f58, code: d.f57, src: '东方财富',
      price: div(d.f43), prevClose: div(d.f60), open: div(d.f46),
      high: div(d.f44), low: div(d.f45), change: div(d.f169),
      pct: typeof d.f170 === 'number' ? d.f170 / 100 : null,
      volume: d.f47, amount: d.f48, pe: div(d.f162), pb: div(d.f167),
      marketCap: d.f116, floatCap: d.f117,
    };
  }, 3, '东财行情');
}

// 腾讯兜底行情（~分隔）
async function fetchTencentQuote(code) {
  return fetchRetry(async () => {
    const res = await fetch(`https://qt.gtimg.cn/q=${code}`, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    const m = text.match(/v_[^=]+="([^"]*)"/);
    if (!m || !m[1].includes('~')) throw new Error('腾讯行情无数据');
    const f = m[1].split('~');
    return {
      name: f[1], code: f[2], src: '腾讯财经',
      price: Number(f[3]), prevClose: Number(f[4]), open: Number(f[5]),
      high: Number(f[33]), low: Number(f[34]), change: Number(f[31]), pct: Number(f[32]),
      volume: Number(f[6]), time: f[30],
    };
  }, 3, '腾讯行情');
}

// 东财日K线（前复权）
async function fetchKlines(secid, lmt = 60) {
  return fetchRetry(async () => {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=${lmt}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57`;
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const j = await res.json();
    const list = j?.data?.klines;
    if (!Array.isArray(list) || !list.length) throw new Error('K线无数据');
    return list.map((k) => {
      const p = k.split(',');
      return { date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4], volume: +p[5], amount: +p[6] };
    });
  }, 3, '东财K线');
}

/* ------------------------------ 技术指标 ------------------------------ */

function computeIndicators(klines) {
  const closes = klines.map((k) => k.close);
  const last = klines[klines.length - 1];
  const ma = (n) => {
    const seg = closes.slice(-n);
    return seg.length >= n ? seg.reduce((a, b) => a + b, 0) / n : null;
  };
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const first = klines[0];
  const prev = klines[klines.length - 2];
  return {
    date: last.date,
    close: last.close,
    ma5: ma(5), ma10: ma(10), ma20: ma(20), ma60: ma(60),
    high60: Math.max(...highs), low60: Math.min(...lows),
    rangePct: ((last.close - first.close) / first.close) * 100,
    dayPct: prev ? ((last.close - prev.close) / prev.close) * 100 : null,
    vol5: (klines.slice(-5).reduce((a, k) => a + k.volume, 0) / 5),
    lastVol: last.volume,
  };
}

/* ------------------------------ 相关新闻 ------------------------------ */

async function fetchNews(keywords) {
  if (!keywords.length) return [];
  const hits = [];
  for (const feed of NEWS_FEEDS) {
    try {
      const res = await fetch(feed.url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
      const items = parseFeed(await res.text());
      for (const it of items) {
        if (keywords.some((k) => it.title.includes(k))) {
          hits.push({ ...it, src: feed.name });
        }
      }
    } catch { /* 单源失败忽略 */ }
  }
  // 去重 + 限量
  const seen = new Set();
  const out = [];
  for (const it of hits) {
    const key = it.title.slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= NEWS_MAX) break;
  }
  return out;
}

/* ------------------------------ AI 分析 ------------------------------ */

function buildPrompt(stock, quote, ind, news) {
  const snap = [
    `名称/代码: ${stock.name}（${stock.code}）`,
    `最新价: ${quote.price}  涨跌幅: ${quote.pct}%  涨跌额: ${quote.change}`,
    `今开: ${quote.open}  最高: ${quote.high}  最低: ${quote.low}  昨收: ${quote.prevClose}`,
    `成交量: ${quote.volume} 手  成交额: ${(quote.amount / 1e8).toFixed(2)} 亿元`,
    quote.pe ? `市盈率(动): ${quote.pe}  市净率: ${quote.pb}` : '',
    quote.marketCap ? `总市值: ${(quote.marketCap / 1e8).toFixed(0)} 亿元` : '',
  ].filter(Boolean).join('\n');
  const tech = [
    `近60个交易日（截至 ${ind.date}）: 收盘 ${ind.close}`,
    `MA5=${ind.ma5?.toFixed(2)} MA10=${ind.ma10?.toFixed(2)} MA20=${ind.ma20?.toFixed(2)}${ind.ma60 ? ' MA60=' + ind.ma60.toFixed(2) : ''}`,
    `60日最高 ${ind.high60} / 最低 ${ind.low60}，区间涨跌幅 ${ind.rangePct.toFixed(2)}%`,
    `最近一日涨跌幅 ${ind.dayPct?.toFixed(2)}%，5日均量 ${ind.vol5?.toFixed(0)} vs 最新量 ${ind.lastVol}`,
  ].join('\n');
  const newsText = news.length
    ? news.map((n, i) => `${i + 1}. [${n.src}] ${n.title}（${n.link}）`).join('\n')
    : '（近12小时相关新闻源中未检索到与该股票直接相关的标题）';

  return `你是专业的股票分析师。请基于以下【行情数据】【技术数据】【相关新闻】对 ${stock.name}（${stock.code}）做一次客观分析。

【行情数据】
${snap}

【技术数据】
${tech}

【相关新闻】
${newsText}

【输出要求】
严格按以下 Markdown 结构输出（不要输出标题行和"行情快照"章节，快照已单独生成）：

## 🔍 二、技术面简评
[基于均线排列、区间位置、量能变化给出 2-4 句客观描述]

## 📰 三、消息面要点
[逐条列出与股价最相关的 2-5 条新闻并点评影响；无相关新闻时如实说明]

## 🎯 四、综合研判
- **短期方向**：[明确给出偏强/偏弱/震荡的判断]
- **关键价位**：[给出近端支撑位与压力位，基于输入数据中的高低点/均线]
- **依据**：[2-4 句，只引用输入数据中的事实]

## ⚠️ 五、风险提示
[1-3 条]

【处理原则】
1. 只使用输入数据，严禁编造任何数字、事件或价位
2. 保持客观，不吹捧不贬低
3. 全部内容结尾必须标注"（非投资建议）"`;
}

async function callLLM(prompt) {
  let lastErr = null;
  for (const model of MODELS) {
    try {
      const res = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 8192, stream: false }),
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('模型返回为空');
      log(`[AI] 模型 ${model} 生成成功（${content.length} 字符）`);
      return content.trim().replace(/^```(?:markdown)?\s*|```$/g, '').trim();
    } catch (e) {
      lastErr = e;
      log(`[AI] 模型 ${model} 失败（${e.message}），${MODELS.length > 1 ? '尝试下一个' : '降级'}`);
    }
  }
  throw lastErr;
}

/* ------------------------------ 主流程 ------------------------------ */

function beijingDate() {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function dateKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function analyzeOne(stock) {
  log(`=== 分析 ${stock.name}（${stock.code}）===`);
  // 1. 行情（东财主 + 腾讯交叉核验）
  let quote;
  try {
    quote = await fetchEastmoneyQuote(stock.secid);
  } catch (e) {
    log(`[行情] 东财失败: ${e.message}，尝试腾讯`);
    quote = await fetchTencentQuote(stock.code);
  }
  let cross = '';
  if (quote.src === '东方财富') {
    try {
      const tq = await fetchTencentQuote(stock.code);
      const diff = Math.abs(tq.price - quote.price) / quote.price;
      cross = diff < 0.005 ? '（东财+腾讯双源一致 ✓）' : `（⚠️ 双源偏差 ${(diff * 100).toFixed(2)}%）`;
    } catch { /* 无腾讯数据不阻塞 */ }
  }

  // 2. K线 + 指标
  const klines = await fetchKlines(stock.secid, 60);
  const ind = computeIndicators(klines);

  // 3. 相关新闻
  const news = await fetchNews(stock.keywords);
  log(`[新闻] 命中 ${news.length} 条相关新闻`);

  // 4. 快照（脚本渲染，数字不经 LLM）
  const snap = [
    `# 📈 ${stock.name}（${stock.code}）个股分析 · ${beijingDate()}`,
    '',
    '## 📊 一、行情快照',
    '',
    `| 指标 | 数值 | 指标 | 数值 |`,
    `|---|---|---|---|`,
    `| 最新价 | **${quote.price}**（${quote.pct}%${cross}）| 昨收 | ${quote.prevClose} |`,
    `| 今开 | ${quote.open} | 最高/最低 | ${quote.high} / ${quote.low} |`,
    `| 成交额 | ${(quote.amount / 1e8).toFixed(2)} 亿元 | 成交量 | ${quote.volume} 手 |`,
    quote.pe ? `| 市盈率(动) | ${quote.pe} | 市净率 | ${quote.pb} |` : '',
    quote.marketCap ? `| 总市值 | ${(quote.marketCap / 1e8).toFixed(0)} 亿元 | 数据源 | ${quote.src} |` : '',
    '',
    `> 行情时间：${quote.time || '最近收盘'}（北京时间）；技术指标基于近 60 个交易日日K（前复权）。`,
    '',
  ].filter(Boolean).join('\n');

  // 5. AI 分析（失败降级为数据摘要）
  let body;
  let degraded = null;
  if (!API_KEY) {
    degraded = '未配置 DEEPSEEK_API_KEY';
  } else {
    try {
      body = await callLLM(buildPrompt(stock, quote, ind, news));
    } catch (e) {
      degraded = e.message;
      log('[警告] AI 分析失败，降级:', e.message);
    }
  }
  if (!body) {
    body = [
      `> ⚠️ AI 分析不可用（${degraded}），以下为关键数据摘要。`,
      '',
      `- 收盘 ${ind.close}（最近一日 ${ind.dayPct?.toFixed(2)}%）`,
      `- MA5=${ind.ma5?.toFixed(2)} MA10=${ind.ma10?.toFixed(2)} MA20=${ind.ma20?.toFixed(2)}`,
      `- 60日区间 ${ind.low60} ~ ${ind.high60}（区间涨跌 ${ind.rangePct.toFixed(2)}%）`,
      news.length ? `- 相关新闻 ${news.length} 条（见上方来源）` : '- 无相关新闻',
      '',
      '（非投资建议）',
    ].join('\n');
  }

  const digest = snap + '\n' + body + '\n';
  writeFileSync(OUT, digest);
  const archiveDir = path.join(repoRoot, 'digests', 'stock');
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(path.join(archiveDir, `${dateKey()}-${stock.code}.md`), digest);
  log(`[写入] ${OUT}（${degraded ? 'AI 降级' : 'AI 分析完整'}）`);
  log(`[归档] digests/stock/${dateKey()}-${stock.code}.md`);
  return { stock, ok: true, degraded };
}

async function main() {
  const results = [];
  for (const stock of STOCKS) {
    try {
      results.push(await analyzeOne(stock));
    } catch (e) {
      console.error(`[致命] ${stock.name} 分析失败:`, e.message);
      results.push({ stock, ok: false });
    }
  }
  if (results.every((r) => !r.ok)) process.exit(1);
}

main().catch((e) => {
  console.error('[致命] 未捕获异常:', e);
  process.exit(1);
});
