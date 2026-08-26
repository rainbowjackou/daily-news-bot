#!/usr/bin/env node
/**
 * 简报格式化：读取 dsh-rss-digest 抓取入库的 store.json，
 * 调用 DeepSeek 按「今日头条 / 科技财经 / 其他要闻 / 今日洞察」四段式模板生成简报，
 * 写入指定 Markdown 文件（默认 digest.md）。
 *
 * 用法: node scripts/format-digest.mjs --db ./store.json --out digest.md
 * 环境变量:
 *   DEEPSEEK_API_KEY   （推荐）DeepSeek API Key；未设置或调用失败时降级为原文速览
 *   DEEPSEEK_MODEL     （可选）模型名，默认 deepseek-chat
 *   DEEPSEEK_BASE_URL  （可选）API 地址，默认 https://api.deepseek.com
 *   NEWS_MAX_PER_SOURCE（可选）每源最多条数，默认 10
 *   NEWS_MAX_TOTAL     （可选）总条数上限，默认 50
 * 退出码: 0 正常（含 AI 降级）；1 = store 无新闻或读取失败（工作流可见地失败）
 */
import { readFileSync, writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const DB = arg('--db', './store.json');
const OUT = arg('--out', 'digest.md');
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const API_BASE = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MAX_PER_SOURCE = Number(process.env.NEWS_MAX_PER_SOURCE || 10);
const MAX_TOTAL = Number(process.env.NEWS_MAX_TOTAL || 50);
const MAX_ITEM_AGE_HOURS = 48; // 只取最近 48 小时内抓到的条目（避免本地累积库混入旧闻）
const LLM_TIMEOUT_MS = 150000;

/* ------------------------------ 工具 ------------------------------ */

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
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/* ------------------------------ 读取 store ------------------------------ */

function loadItems() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(DB, 'utf8'));
  } catch (e) {
    throw new Error(`无法读取 ${DB}: ${e.message}`);
  }
  const titleById = new Map(
    (raw.sources || []).map((s) => [s.id, s.title || s.url || '未知来源'])
  );
  const cutoff = Date.now() - MAX_ITEM_AGE_HOURS * 3600 * 1000;
  const items = (raw.items || [])
    .filter((it) => it && it.title)
    .map((it) => ({
      title: stripHtml(it.title),
      link: it.link || '',
      desc: stripHtml(it.summary || it.content || '').slice(0, 300),
      source: titleById.get(it.sourceId) || '未知来源',
      fetchedAt: it.fetchedAt || '',
    }))
    .filter((it) => {
      const t = Date.parse(it.fetchedAt);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  return items;
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
    if (n >= MAX_PER_SOURCE) continue;
    perSource.set(it.source, n + 1);
    out.push(it);
    if (out.length >= MAX_TOTAL) break;
  }
  return out;
}

/* ------------------------------ AI 四段式简报 ------------------------------ */

function buildPrompt(items) {
  const feedText = items
    .map(
      (it, i) =>
        `${i + 1}. [${it.source}] ${it.title}\n   内容摘要: ${it.desc || '（无摘要）'}\n   链接: ${it.link || '（无链接）'}`
    )
    .join('\n');

  return `你是一位专业的新闻编辑。请基于以下 RSS 源抓取到的新闻数据，生成一份每日简报：

【输入数据】
${feedText}

【输出要求】
请按以下 Markdown 格式输出：

# 📰 [当前日期] 每日新闻简报

## 📈 一、今日头条
- **[标题]**
  - 核心要点：[1-2句话概括]
  - 来源：[来源名称]

## 💼 二、科技/财经动态
- **[标题]**
  - 核心要点：[1-2句话概括]

## 🌍 三、其他要闻
- **[标题]**
  - 核心要点：[1-2句话概括]

## 💎 四、今日洞察
- **主题**：[提炼一个今日最值得关注的主题]
- **分析**：[基于相关新闻，提供3-5句简短分析]

【处理原则】
1. 忠实于原文数据，不编造信息，不虚构不存在的标题
2. 对重复内容进行去重合并
3. 保持客观中立
4. 确保 Markdown 格式正确
5. 头条 3-5 条，科技/财经 5-8 条，其他要闻 5-10 条；某个分类没有内容时省略该分类
6. 若输入数据几乎为空，直接说明"今日未抓到有效新闻"，不要编造`;
}

async function callDeepSeek(prompt) {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
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

function fallbackDigest(items, dateStr, reason) {
  const bySource = new Map();
  for (const it of items) {
    if (!bySource.has(it.source)) bySource.set(it.source, []);
    bySource.get(it.source).push(it);
  }
  const lines = [
    `# 📰 ${dateStr} 每日新闻简报`,
    '',
    `> ⚠️ AI 摘要不可用（${reason}），以下为各源原文标题速览。`,
    '',
  ];
  for (const [src, list] of bySource) {
    lines.push(`## ${src}`, '');
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
  log('=== 简报格式化开始 ===', dateStr, `db=${DB} out=${OUT}`);

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
  log(`[数据] 有效 ${all.length} 条 → 去重限量后 ${items.length} 条`);

  let digest;
  let degraded = null;
  if (!API_KEY) {
    degraded = '未配置 DEEPSEEK_API_KEY';
    log('[警告]', degraded);
  } else {
    try {
      digest = await callDeepSeek(buildPrompt(items));
      log(`[AI] 四段式简报生成完成，${digest.length} 字符`);
    } catch (e) {
      degraded = e.message;
      log('[警告] AI 摘要失败，降级为原文速览:', e.message);
    }
  }
  if (!digest) digest = fallbackDigest(items, dateStr, degraded || '未知错误');

  writeFileSync(OUT, digest + '\n');
  log(`[写入] ${OUT}（${items.length} 条新闻${degraded ? '，AI 降级' : ''}）`);
  log('=== 简报格式化结束 ===');
}

main().catch((e) => {
  console.error('[致命] 未捕获异常:', e);
  process.exit(1);
});
