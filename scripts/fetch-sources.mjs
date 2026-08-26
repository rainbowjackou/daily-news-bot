#!/usr/bin/env node
/**
 * 抓取 RSS 新闻源并写入 store.json（schema 与 dsh-rss-digest 兼容，format-digest.mjs 可直接读取）
 *
 * 为什么不用 dsh-rss-digest CLI 的 fetch：
 *   - 其固定 UA 为机器人标识（dsh-rss-digest/0.1），BBC/卫报等会对机器人 UA 返回空响应/拦截页
 *   - rsshub.app 公共实例对 GitHub Actions 的云机房 IP 直接 403
 * 本脚本：浏览器 UA、每源独立容错、rsshub 类源多公共实例 fallback。
 *
 * 用法: node scripts/fetch-sources.mjs
 * 输出: store.json（仓库根目录）
 * 退出码: 0 = 抓到至少 1 条；1 = 全部失败（工作流可见地失败）
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 20000;

// 新闻源（max 表示每源最多条数；未写用默认 MAX_ITEMS_PER_SOURCE）
const SOURCES = [
  // ── 国际财经（强化财金报道）──
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', name: 'BBC商业' },
  { url: 'https://www.theguardian.com/business/rss', name: '卫报商业' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', name: 'CNBC头条' },
  { url: 'https://www.cnbc.com/id/10001147/device/rss/rss.html', name: 'CNBC经济' },
  // ── 国内（强化国内新闻；人民网/新华网 RSS 已停更多年，改用中新网多频道）──
  { url: 'https://www.chinanews.com.cn/rss/scroll-news.xml', name: '中新网即时' },
  { url: 'https://www.chinanews.com.cn/rss/finance.xml', name: '中新网财经' },
  { url: 'https://www.chinanews.com.cn/rss/world.xml', name: '中新网国际' },
  { url: 'https://www.chinanews.com.cn/rss/society.xml', name: '中新网社会' },
  // ── 综合/科技（综合源降权，减少个人新闻占比）──
  { url: 'https://feeds.bbci.co.uk/news/rss.xml', name: 'BBC综合', max: 6 },
  { url: 'https://www.theguardian.com/world/rss', name: '卫报世界', max: 6 },
  { url: 'https://www.ithome.com/rss/', name: 'IT之家' },
  { url: 'https://sspai.com/feed', name: '少数派' },
  { url: 'https://www.solidot.org/index.rss', name: 'Solidot 奇客资讯' },
  // ── RSSHub（无官方 RSS 的站，公共实例常限流，失败不影响整体）──
  { url: 'https://rsshub.app/36kr/newsflashes', name: '36氪快讯', rsshub: true },
  { url: 'https://rsshub.app/zhihu/hotlist', name: '知乎热榜', rsshub: true },
  { url: 'https://rsshub.app/bilibili/ranking/0/3', name: 'B站排行榜', rsshub: true, max: 5 },
  { url: 'https://rsshub.app/caixin/latest', name: '财新网', rsshub: true },
];

// rsshub 备选公共实例（rsshub.app 被限流/403 时依次尝试）
const RSSHUB_FALLBACK_HOSTS = ['rsshub.rssforever.com'];

const MAX_ITEMS_PER_SOURCE = 12;

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

function parseFeed(xml) {
  const items = [];
  const blocks = xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi);
  for (const m of blocks) {
    const body = m[2];
    const titleM = body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const linkM =
      body.match(/<link\b[^>]*\shref="([^"]+)"[^>]*\/?>/i) ||
      body.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i) ||
      body.match(/<link\b[^>]*\shref="([^"]+)"/i);
    const descM = body.match(
      /<(?:description|summary|content:encoded|content)\b[^>]*>([\s\S]*?)<\/(?:description|summary|content:encoded|content)>/i
    );
    const dateM = body.match(/<(?:pubDate|published|updated)\b[^>]*>([^<]*)<\/(?:pubDate|published|updated)>/i);
    const title = stripHtml(titleM ? titleM[1] : '');
    if (!title) continue;
    // 文章真实发布日期（RSS pubDate / Atom updated/published），解析失败则为空
    let pubDate = '';
    if (dateM) {
      const t = Date.parse(decodeEntities(dateM[1]).trim());
      if (Number.isFinite(t)) pubDate = new Date(t).toISOString();
    }
    items.push({
      title: title.slice(0, 300),
      link: linkM ? decodeEntities(linkM[1] || linkM[2] || '').trim() : '',
      desc: stripHtml(descM ? descM[1] : '').slice(0, 300),
      pubDate,
    });
  }
  return items;
}

/* ------------------------------ 抓取 ------------------------------ */

async function fetchUrl(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': BROWSER_UA,
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error('空响应');
  return text;
}

async function fetchOne(source) {
  // rsshub 类源：先 rsshub.app，再逐个尝试备选实例
  const candidates = [source.url];
  if (source.rsshub) {
    const u = new URL(source.url);
    for (const host of RSSHUB_FALLBACK_HOSTS) {
      const c = new URL(u.toString());
      c.host = host;
      candidates.push(c.toString());
    }
  }
  let lastErr = null;
  for (const url of candidates) {
    try {
      return { xml: await fetchUrl(url), usedUrl: url };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('所有候选实例均失败');
}

/* ------------------------------ 主流程 ------------------------------ */

function sourceId(url) {
  return 'src-' + createHash('sha1').update(url).digest('hex').slice(0, 12);
}

async function main() {
  log('=== 新闻源抓取开始 ===');
  const now = new Date().toISOString();
  const allItems = [];
  const failures = [];

  for (const source of SOURCES) {
    try {
      const { xml } = await fetchOne(source);
      // 只保留 48 小时内的新闻（按文章真实 pubDate；无 pubDate 的保留，交给后续校验）
      const fresh = parseFeed(xml).filter((it) => {
        if (!it.pubDate) return true;
        return Date.now() - Date.parse(it.pubDate) < 48 * 3600 * 1000;
      });
      const items = fresh.slice(0, source.max || MAX_ITEMS_PER_SOURCE);
      const stale = parseFeed(xml).length - fresh.length;
      log(`[抓取] ${source.name}: ${items.length} 条${stale ? `（已过滤 ${stale} 条旧闻）` : ''}`);
      for (const it of items) {
        allItems.push({ ...it, sourceId: sourceId(source.url), sourceName: source.name });
      }
    } catch (e) {
      failures.push(`${source.name}: ${e.message}`);
      log(`[抓取] ${source.name} 失败: ${e.message}`);
    }
  }

  if (allItems.length === 0) {
    console.error('[致命] 所有新闻源均抓取失败:', failures.join('; '));
    process.exit(1);
  }

  // 多源交叉统计：同一新闻出现在多个源 → 标记（新闻准确性交叉效验）
  const titleMap = new Map(); // 规范化标题 -> { sources:Set }
  for (const it of allItems) {
    const key = it.title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    if (!key) continue;
    if (!titleMap.has(key)) titleMap.set(key, { sources: new Set() });
    titleMap.get(key).sources.add(it.sourceName);
  }

  // 去重（按规范化标题；保留多源信息）
  const seen = new Set();
  const unique = [];
  for (const it of allItems) {
    const key = it.title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const rec = titleMap.get(key);
    it.allSources = [...rec.sources];
    it.multiSource = rec.sources.size > 1;
    unique.push(it);
  }

  // 写 store.json（与 dsh-rss-digest schema 兼容；items 增加 sources 字段用于交叉核验）
  const store = {
    schema: 1,
    meta: { lastFetchAt: now, lastDigestAt: '', lastDigestDay: '' },
    sources: SOURCES.map((s) => ({
      id: sourceId(s.url),
      url: s.url,
      title: s.name,
      enabled: true,
      addedAt: now,
    })),
    items: unique.map((it) => ({
      sourceId: it.sourceId,
      title: it.title,
      link: it.link,
      summary: it.desc,
      content: '',
      sources: it.allSources,
      publishedAt: it.pubDate || now,
      fetchedAt: now,
    })),
  };
  writeFileSync('store.json', JSON.stringify(store, null, 2) + '\n');

  const multi = unique.filter((it) => it.multiSource).length;
  log(`[完成] 原始 ${allItems.length} 条 → 去重后 ${unique.length} 条（其中多源交叉确认 ${multi} 条），已写入 store.json`);
  if (failures.length) log('[警告] 失败源:', failures.join('; '));
  log('=== 新闻源抓取结束 ===');
}

main().catch((e) => {
  console.error('[致命] 未捕获异常:', e);
  process.exit(1);
});
