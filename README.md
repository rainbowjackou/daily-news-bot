# 📰 daily-news-bot — 每日新闻简报自动化

每天**北京时间 08:00** 自动完成：抓取多个 RSS 源 → DeepSeek 去重/分类/摘要 → 生成 Markdown 简报 → 推送到飞书群。

全程跑在 **GitHub Actions**（免费额度）上，**不依赖你的电脑是否开机**。

```
GitHub Actions 定时 (cron 0 0 * * * = UTC 00:00 = 北京 08:00)
   │
   ├─ dsh-rss-digest add     订阅 RSS 源（scripts/add-sources.mjs 里配置）
   ├─ dsh-rss-digest fetch   抓取 + 相似去重
   ├─ dsh-rss-digest digest  DeepSeek 批量摘要 → digest.md（DeepSeek API）
   └─ send-feishu.mjs        推送到飞书群 Webhook（自动分片）
```

---

## ⚠️ 与原方案的差异（重要，先读）

你提供的原提示词中有几处命令/插件**在现实中不存在**，本仓库已用验证过的真实方案替代：

| 原方案 | 实际情况 | 本仓库做法 |
|---|---|---|
| `chicheng-cron` 插件 | npm 上**不存在**（404） | 无需它：云端定时由 GitHub Actions cron 承担；本地定时由 dsh-rss-digest 自带调度器承担 |
| `dsh exec --full-auto "..."` | DSH **没有这个命令**（一次性任务是 `dsh --profile headless "..."`） | CI 里直接调用 `dsh-rss-digest` CLI，确定性执行、不烧 token，比在 CI 里跑 Agent 循环稳定得多 |
| 在 DSH Web 左侧栏找「定时任务」入口 | Web 界面**没有该入口** | 本地备选方案通过插件自带的定时调度 + `cordis.patch.yml` 配置 `digest.time` / `digest.timezone` |
| 在 GitHub Actions 里 `npm i -g @deepseek-ai/dsh` 装整套 harness | 可行但笨重（把整个 Agent 运行时拖进 CI） | 只安装 `dsh-rss-digest` 的独立 CLI（核心零第三方依赖，安装快、行为确定） |

> 注：`dsh-rss-digest` 是真实存在的 npm 包（v0.1.0，MIT，仓库 github.com/JohnXu22786/rss-digest），是 DSH 的原生 bundle，同时提供独立 CLI —— CI 用 CLI，本地 GUI 用 bundle，共享同一套核心。

---

## 🚀 快速开始（约 15 分钟）

### 1. 创建 GitHub 仓库（手动，需要你的账号）

1. 打开 github.com 登录（没有就注册免费账号）
2. 右上角 `+` → **New repository**
3. Repository name：`daily-news-bot`；选 **Private**（保护 Secrets）；勾选 *Add a README file* 可选（本仓库自带 README，可不勾）
4. 点 **Create repository**

> ⚠️ 本机没有安装 GitHub CLI（`gh`），所以我无法替你建仓/推送。建好后按下面第 3 步推送。

### 2. 配置 GitHub Secrets

进入仓库 → **Settings** → 左侧 **Secrets and variables** → **Actions** → **New repository secret**：

| Name | Secret |
|---|---|
| `DEEPSEEK_API_KEY` | 你的 DeepSeek API Key（platform.deepseek.com 获取） |
| `FEISHU_WEBHOOK` | 飞书群机器人 Webhook（`https://open.feishu.cn/open-apis/bot/v2/hook/xxx`） |

> 飞书群机器人：飞书群设置 → 群机器人 → 添加机器人 → 自定义机器人 → 复制 Webhook。

### 3. 推送本仓库代码

```bash
cd daily-news-bot        # 本目录（DSH 已为你生成在 DeepSeekharness/daily-news-bot）
git init
git add .
git commit -m "init: 每日新闻简报"
git branch -M main
git remote add origin https://github.com/<你的用户名>/daily-news-bot.git
git push -u origin main
```

### 4. 手动触发测试

1. 仓库页 → **Actions** 标签 → 左侧 **每日新闻简报** → 右侧 **Run workflow** → 确认
2. 等 1-2 分钟，点进运行查看日志；绿勾即成功
3. 检查飞书群是否收到简报（含 `.md` 原文可在运行详情页的 **Artifacts** 下载）

之后每天北京时间 08:00 自动运行，无需任何操作。

---

## 📝 修改新闻源

编辑 `scripts/add-sources.mjs` 顶部的 `SOURCES` 数组，推送到 main 即生效：

```js
const SOURCES = [
  { url: 'https://feeds.bbci.co.uk/news/rss.xml', title: 'BBC' },
  { url: 'https://www.theguardian.com/world/rss', title: 'The Guardian' },
  // 增删在这里...
];
```

### 源可用性说明（重要）

- **BBC / The Guardian**：官方 RSS，稳定。
- **rsshub.app 公共实例**（36氪/知乎/B站等无官方 RSS 的站）：公共实例**经常限流或失效**，这是常见现象。失效时这几个源抓到 0 条，**不影响其他源和整个工作流**（不会中断）。想要稳定可自建 RSSHub，或换其他可用源（如 IT 之家官网 RSS、各站官方 feed）。

---

## 💻 本地 DSH Web 备选方案（可选，用于手动/测试）

> ✅ **本机已完成（2026-08-25）**：插件已装入 web profile、4 个 peer 依赖已补装、`cordis.patch.yml` 已配置好订阅源与每日 08:00 调度（已通过 `dsh --profile web --dump-config` 验证合成结果）。**你只需重启 `dsh web` 即可生效**（重启后当前 Web 会话会断开，属正常）。

云端 GitHub Actions 是主力；如果你想在本地 DSH Web 界面里也能聊着天生成简报，可以装 bundle：

```bash
# 1. 安装插件到 web profile（等价于原提示词里的"装 dsh-rss-digest"）——本机已完成
dsh plugin --profile web add dsh-rss-digest

# 2. 配置订阅源与每日 08:00 调度（复制示例文件到 profile 目录）——本机已完成
cp config/local-rss-digest.patch.yml ~/.dsh/profiles/web/cordis.patch.yml

# 3. 重启 dsh web（重要：进程内定时器，重启后才加载插件）
#    在启动 dsh web 的终端里 Ctrl+C 后重新 npx @deepseek-ai/dsh web
```

> 备注：`dsh plugin` 依赖 pnpm。本机没装 pnpm，可用 Node 自带的 corepack：`corepack pnpm ...`（首次使用会在工作区外下载缓存，需一次授权）。以后增删插件时再需要。

- 重启后在对话中即可使用工具：`rss_list` / `rss_add` / `rss_fetch` / `rss_digest`
- 简报默认同时投递到实时会话和本地文件 `~/.dsh/data/rss-digest/digests/<日期>.md`
- **注意**：本地定时只在 `dsh web` 运行期间生效（进程内定时器）。关机/退出后不触发 —— 这正是为什么云端 GitHub Actions 才是主力。
- AI 摘要需要 `DEEPSEEK_API_KEY` 环境变量（或 profile 里配好的 provider）；缺失时自动降级为原文摘要，不会报错。

---

## 🔧 排错手册

| 症状 | 原因 / 解法 |
|---|---|
| 定时没触发 | GitHub Actions 的 cron 用 **UTC**；`0 0 * * *` = 北京 08:00。另注意 GitHub 官方文档说明：**cron 不能保证精确到秒/分钟**，高峰期可能延迟几分钟到十几分钟，属正常现象 |
| 手动 Run workflow 后报 `DEEPSEEK_API_KEY` 相关错误 | Secrets 未配置或名字拼错；检查 Settings → Secrets and variables |
| 简报生成了但飞书没收到 | `FEISHU_WEBHOOK` Secret 缺失/拼错；或机器人被移出群；看日志里 `推送到飞书群` 步骤的报错 |
| 简报内容是原文摘要而非 AI 摘要 | `DEEPSEEK_API_KEY` 缺失，CLI 自动降级（设计如此，保证不中断） |
| 某些源 0 条 | 该源失效（尤其 rsshub.app 公共实例）；不阻塞整体运行 |
| 想立即手动跑一次 | Actions → 每日新闻简报 → Run workflow |
| 简报文件为空 | 所有源都挂了；`digest.md` 会显示 0 条目，飞书照常推送（可接受），或加几个稳定源 |
| 本地 `npm i` / `npm ci` 报 `EPERM ... ~/.npm/_cacache` | 本机 `~/.npm` 缓存里有 root 属主文件（历史 npm bug 遗留）。临时绕过：加 `--cache <某目录>`；永久修复：`sudo chown -R 501:20 ~/.npm` |

---

## 💰 费用

- GitHub Actions：公共仓库免费，私有仓库也有免费额度（2000 分钟/月，每天跑 1-2 分钟绰绰有余）
- DeepSeek API：每天一次 batch 摘要调用，token 消耗极小，成本约每天几分钱人民币级别

## 🔒 安全

- 仓库务必用 **Private**
- API Key / Webhook 只放 GitHub Secrets，**不要**写进任何代码文件或 README
- `store.json`、`digest.md`、`node_modules/` 已在 `.gitignore` 中，不会被提交
