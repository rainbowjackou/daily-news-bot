#!/usr/bin/env node
/**
 * 简报生成：读取 store.json（新闻，含多源交叉标记）+ markets.json（行情，已多源核验），
 * 生成每日简报。市场速览一节由脚本直接渲染（数字不经 LLM，保证准确），
 * DeepSeek 只负责「财经要闻 / 国内要闻 / 国际要闻 / 后市研判」四节。
 *
 * 用法: node scripts/format-digest.mjs --db ./store.json --out digest.md
 * 环境变量:
 *   DEEPSEEK_API_KEY   （推荐）DeepSeek API Key；未设置或调用失败时降级为原文速览
 *   DEEPSEEK_MODEL     （可选）模型名，默认 deepseek-chat
 *   DEEPSEEK_BASE_URL  （可选）API 地址，默认 https://api.deepseek.com
 *   NEWS_MAX_TOTAL     （可选）进入 LLM 的新闻总条数上限，默认 50
 * 退出码: 0 正常（含 AI 降级）；1 = store 无新闻或读取失败
 */
import { readFileSync, writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const DB = arg('--db', './store.json');
const MARKETS = arg('--markets', './markets.json');
const OUT = arg('--out', 'digest.md');
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const API_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MAX_TOTAL = Number(process.env.NEWS_MAX_TOTAL || 50);
const MAX_ITEM_AGE_HOURS = 48;
const LLM_TIMEOUT_MS = 180000;

/* ------------------------------ 工具 ------------------------------ */

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n) {
  try {
    return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

function stripHtml(s) {
  return decodeEntities(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function beijingDate() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date());
}

/* ------------------------------ 读取数据 ------------------------------ */

function loadItems() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(DB, 'utf8'));
  } catch (e) {
    throw new Error(`无法读取 ${DB}: ${e.message}`);
  }
  const titleById = new Map((raw.sources || []).map((s) => [s.id, s.title || s.url || '未知来源']));
  const cutoff = Date.now() - MAX_ITEM_AGE_HOURS * 3600 * 1000;
  const items = (raw.items || [])
    .filter((it) => it && it.title)
    .map((it) => ({
      title: stripHtml(it.title),
      link: it.link || '',
      desc: stripHtml(it.summary || it.content || '').slice(0, 300),
      source: titleById.get(it.sourceId) || '未知来源',
      sources: Array.isArray(it.sources) && it.sources.length ? it.sources : [titleById.get(it.sourceId) || '未知来源'],
      fetchedAt: it.fetchedAt || '',
      publishedAt: it.publishedAt || '',
    }))
    .filter((it) => {
      // 按文章真实发布日期过滤（无 pubDate 时退回抓取时间）
      const t = Date.parse(it.publishedAt || it.fetchedAt);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => (b.publishedAt || b.fetchedAt).localeCompare(a.publishedAt || a.fetchedAt));
  return items;
}

function loadMarkets() {
  try {
    const raw = JSON.parse(readFileSync(MARKETS, 'utf8'));
    return Array.isArray(raw.markets) ? raw.markets : [];
  } catch {
    return [];
  }
}

function dedupeAndCap(items) {
  const seen = new Set();
  const perSource = new Map();
  const out = [];
  for (const it of items) {
    const key = it.title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const n = perSource.get(it.source) || 0;
    if (n >= 10) continue;
    perSource.set(it.source, n + 1);
    out.push(it);
    if (out.length >= MAX_TOTAL) break;
  }
  return out;
}

/* ------------------------------ 市场速览（脚本渲染，数字不经 LLM） ------------------------------ */

export function buildMarketSection(markets) {
  if (!markets.length) return '';
  const groups = ['美股', '中国A股', '中国港股', '日本', '欧洲', '期货商品', '汇率'];
  const byGroup = {};
  for (const m of markets) (byGroup[m.group] ||= []).push(m);
  const fmt = (v) =>
    Number(v) < 10
      ? Number(v).toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })
      : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (m) => (m.pct !== null && m.pct !== undefined ? (m.pct > 0 ? '+' : '') + m.pct.toFixed(2) + '%' : '—');
  const mark = (m) => (m.verified ? '✅多源一致' : '⚠️单一来源');
  const lines = ['## 📊 一、全球市场速览', ''];
  for (const g of groups) {
    const list = byGroup[g];
    if (!list || !list.length) continue;
    lines.push(`**${g}**：`);
    for (const m of list) {
      lines.push(`- ${m.name} **${fmt(m.value)}**（${pct(m)} ${mark(m)}）`);
    }
    lines.push('');
  }
  lines.push('> 数据来源：新浪财经 / 腾讯财经 / 东方财富交叉核验；数值为最近收盘或最新价，涨跌幅为较前收。', '');
  return lines.join('\n');
}

/* ------------------------------ AI 内容节 ------------------------------ */

function marketReference(markets) {
  if (!markets.length) return '（今日无行情数据）';
  return markets
    .map((m) => `${m.group} ${m.name}: ${m.value}（${m.pct !== null && m.pct !== undefined ? m.pct + '%' : '—'}，${m.verified ? '多源一致' : '单一来源'}）`)
    .join('\n');
}

function buildPrompt(items, markets) {
  const feedText = items
    .map((it, i) => {
      const src = it.sources.length > 1 ? `[${it.sources.join('+')}]（多源交叉确认）` : `[${it.source}]`;
      return `${i + 1}. ${src} ${it.title}\n   内容摘要: ${it.desc || '（无摘要）'}\n   链接: ${it.link || '（无链接）'}`;
    })
    .join('\n');

  return `你是一位资深财经新闻编辑与市场分析师。请基于以下【市场数据】与【新闻数据】，生成简报的正文部分。

【市场数据】（仅作后市研判参考；市场速览一节已单独生成，你的输出中不要复述行情表格）
${marketReference(markets)}

【新闻数据】（来源列出多个 = 该新闻已在多个媒体出现，可交叉确认）
${feedText}

【输出要求】
严格按以下 Markdown 结构输出（从"## 💼 二、财经要闻"开始，不要再输出简报标题和"一、全球市场速览"）：

## 💼 二、财经要闻（国内外财经/宏观/政策大事，8-12 条）
- **[标题]**
  - 核心要点：[1-2句概括]
  - 来源：[来源名称；多源新闻注明"多源交叉确认"]

## 🇨🇳 三、国内要闻（3-8 条，国内政策/经济/社会重大事件）
- **[标题]**
  - 核心要点：[1-2句概括]

## 🌍 四、国际要闻（3-8 条，仅重大国际事件）
- **[标题]**
  - 核心要点：[1-2句概括]

## 🔮 五、后市研判（AI 分析 · 非投资建议）
- **结论**：[对下一交易日国内外股市与商品市场给出明确的方向性判断，1-2 句，必须有倾向性结论，如"偏强/偏弱/震荡分化"并指明主要市场]
- **依据**：[结合上述市场涨跌、风险偏好变化与财经要闻，2-4 句，只引用输入数据中出现的事实]
- **风险提示**：[1-2 句，列出可能使判断失效的因素]

【处理原则】
1. 财经、宏观、政策类新闻优先，且数量要充足（财经要闻 8-12 条）
2. **剔除**娱乐、名人八卦、体育、猎奇、个人故事、软文类新闻；对综合源的此类新闻一律不用
3. 优先选用多源交叉确认的新闻；单源新闻仅在确属重要时使用
4. 只使用输入数据，严禁编造标题、数字或事件；信息不足时如实说明"输入数据未提及"
5. 后市研判必须给出明确结论，并标注"非投资建议"
6. 保证 Markdown 格式正确；某分类无合适内容时省略该分类`;
}

async function callDeepSeek(prompt) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4096,
      stream: false,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`DeepSeek API HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 返回为空');
  return content.trim().replace(/^```(?:markdown)?\s*|```$/g, '').trim();
}

/* ------------------------------ 降级（AI 不可用） ------------------------------ */

function fallbackBody(items, reason) {
  const bySource = new Map();
  for (const it of items) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source).push(it);
  }
  const lines = [
    '> ⚠️ AI 摘要不可用（' + reason + '），以下为各源原文标题速览。',
    '',
    '## 📰 新闻速览',
    '',
  ];
  for (const [src, list] of bySource) {
    lines.push(`### ${src}`, '');
    for (const it of list) {
      lines.push(`- [${it.title}](${it.link})${it.desc ? ` — ${it.desc.slice(0, 80)}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const dateStr = beijingDate();
  log('=== 简报生成开始 ===', dateStr, `db=${DB} out=${OUT}`);

  let all;
  try {
    all = loadItems();
  } catch (e) {
    console.error('[致命]', e.message);
    process.exit(1);
  }
  if (all.length === 0) {
    console.error('[致命] store 中 48 小时内没有新闻条目（上游抓取可能全部失败），工作流终止。');
    process.exit(1);
  }

  const items = dedupeAndCap(all);
  const markets = loadMarkets();
  log(`[数据] 新闻 ${all.length} 条 → 精选 ${items.length} 条；行情 ${markets.length} 项`);

  // 头部 + 市场速览（脚本渲染，保证数字准确）
  const header = `# 📰 ${dateStr} 每日新闻简报\n\n`;
  const marketSection = buildMarketSection(markets);
  const multi = items.filter((it) => it.sources.length > 1).length;
  log(`[数据] 多源交叉确认新闻 ${multi} 条`);

  // LLM 生成正文（财经要闻/国内/国际/后市研判）
  let body = null;
  let degraded = null;
  if (!API_KEY) {
    degraded = '未配置 DEEPSEEK_API_KEY';
    log('[警告]', degraded);
  } else {
    try {
      body = await callDeepSeek(buildPrompt(items, markets));
      log(`[AI] 正文生成完成，${body.length} 字符`);
    } catch (e) {
      degraded = e.message;
      log('[警告] AI 生成失败，降级为原文速览:', e.message);
    }
  }
  if (!body) body = fallbackBody(items, degraded || '未知错误');

  const digest = header + marketSection + (marketSection ? '\n' : '') + body + '\n';
  writeFileSync(OUT, digest);
  log(`[写入] ${OUT}（${items.length} 条新闻${degraded ? '，AI 降级' : ''}）`);
  log('=== 简报生成结束 ===');
}

main().catch((e) => {
  console.error('[致命] 未捕获异常:', e);
  process.exit(1);
});
