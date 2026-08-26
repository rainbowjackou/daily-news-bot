// 每日简报的 RSS 订阅源列表 —— 增删源只需改这个数组。
// title 仅作注释方便人阅读；CLI 的 add 无 --title 参数，源标题自动从 feed 解析。
const SOURCES = [
  { url: 'https://feeds.bbci.co.uk/news/rss.xml', title: 'BBC' },
  { url: 'https://www.theguardian.com/world/rss', title: 'The Guardian' },
  // 注意：rsshub.app 是公共实例，经常限流或失效（知乎/B站/36氪没有官方 RSS）。
  // 失效的表现是这几个源抓到 0 条，不影响其他源。可替换为自建 RSSHub 或其他源。
  { url: 'https://rsshub.app/36kr/newsflashes', title: '36氪快讯' },
  { url: 'https://rsshub.app/ithome', title: 'IT之家' },
  { url: 'https://rsshub.app/zhihu/hotlist', title: '知乎热榜' },
  { url: 'https://rsshub.app/bilibili/ranking/0/3', title: 'B站排行榜' },
  { url: 'https://rsshub.app/caixin/latest', title: '财新网' },
];

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// 直接调用本地安装的 dsh-rss-digest CLI（node_modules/.bin）
const bin = join(process.cwd(), 'node_modules', '.bin', 'dsh-rss-digest');

for (const { url } of SOURCES) {
  // stdout 直通（显示 add 进度），stderr 捕获用于识别"已订阅"重复错误
  const r = spawnSync(bin, ['add', '--db', './store.json', url], {
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    const err = String(r.stderr || '');
    // 已订阅过的源在重复运行时视为跳过（CI 每次全新 store 不会出现）
    if (err.includes('already subscribed')) {
      console.log(`跳过（已订阅）: ${url}`);
      continue;
    }
    if (err.trim()) process.stderr.write(err);
    console.error(`订阅失败: ${url} (exit ${r.status})`);
    process.exitCode = 1;
  }
}
