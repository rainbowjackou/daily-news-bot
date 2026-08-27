/**
 * DSH 股票分析师 · 飞书桥接（Vercel Serverless Function）
 *
 * 部署：Vercel 导入本仓库 → 自动识别 api/bridge.js
 * 环境变量（Vercel → Settings → Environment Variables）：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET  飞书自建应用凭证
 *   GITHUB_TOKEN                       触发 GitHub Actions 的 PAT
 *   GITHUB_REPO                        （可选）默认 rainbowjackou/daily-news-bot
 * 回调地址：https://<项目名>.vercel.app/api/bridge
 */

const STOCK_MAP = {
  '茅台': { secid: '1.600519', name: '贵州茅台', code: '600519', keywords: '茅台,贵州茅台' },
  '贵州茅台': { secid: '1.600519', name: '贵州茅台', code: '600519', keywords: '茅台,贵州茅台' },
  '600519': { secid: '1.600519', name: '贵州茅台', code: '600519', keywords: '茅台,贵州茅台' },
  '腾讯': { secid: '116.00700', name: '腾讯控股', code: '00700', keywords: '腾讯' },
  '英伟达': { secid: '105.NVDA', name: '英伟达', code: 'NVDA', keywords: '英伟达,NVIDIA,NVDA' },
};

async function getTenantToken(appId, appSecret) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error('获取 tenant_access_token 失败: ' + JSON.stringify(j));
  return j.tenant_access_token;
}

async function replyToMessage(appId, appSecret, messageId, text) {
  const token = await getTenantToken(appId, appSecret);
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }) }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error('回复失败: ' + JSON.stringify(j).slice(0, 300));
  return j;
}

async function dispatchAnalysis(payload) {
  const repo = process.env.GITHUB_REPO || 'rainbowjackou/daily-news-bot';
  const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'dsh-feishu-bridge',
    },
    body: JSON.stringify({ event_type: 'stock-analysis', client_payload: payload }),
  });
  if (!res.ok) throw new Error('dispatch 失败: HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
}

function extractText(contentJson) {
  let content = '';
  try {
    content = JSON.parse(contentJson || '{}').text || '';
  } catch {
    content = String(contentJson || '');
  }
  return content.replace(/@_user_\d+/g, ' ').replace(/\s+/g, ' ').trim();
}

function resolveStock(text) {
  const t = String(text || '').toUpperCase();
  const codeMatch = t.match(/\b\d{6}\b/) || t.match(/\b(?:NVDA|AAPL|MSFT|TSLA|BABA|00700|09988)\b/);
  if (codeMatch) {
    const c = codeMatch[0];
    if (/^\d{6}$/.test(c)) {
      const sh = c.startsWith('6') || c.startsWith('9') ? '1.' : '0.';
      return { secid: sh + c, name: c, code: c, keywords: c };
    }
    return STOCK_MAP[c] || { secid: '105.' + c, name: c, code: c, keywords: c };
  }
  for (const [k, v] of Object.entries(STOCK_MAP)) {
    if (t.includes(k.toUpperCase())) return v;
  }
  return null;
}

export default async function handler(request) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    return new Response('✅ DSH 股票分析桥接运行中（Vercel）', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // 飞书事件订阅 URL 验证挑战
  if (body.type === 'url_verification') {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  const eventType = body.header?.event_type || body.type;
  if (eventType === 'im.message.receive_v1') {
    const event = body.event || {};
    const message = event.message || {};
    const text = extractText(message.content);

    console.log('[EVENT]', JSON.stringify({ messageId: message.message_id, chatType: message.chat_type, text }));

    if (message.chat_type === 'group' && text) {
      const stock = resolveStock(text);
      const appId = process.env.FEISHU_APP_ID;
      const appSecret = process.env.FEISHU_APP_SECRET;

      if (!appId || !appSecret) {
        console.log('[配置] 缺少 FEISHU_APP_ID/SECRET');
      } else if (stock) {
        replyToMessage(appId, appSecret, message.message_id, `📊 收到，正在分析 ${stock.name}（${stock.code}），稍等片刻…（非投资建议）`)
          .catch((e) => console.log('[回复失败]', e.message));
        try {
          await dispatchAnalysis({ stock });
          console.log('[DISPATCH] 已触发分析', stock.name);
        } catch (e) {
          console.log('[DISPATCH失败]', e.message);
        }
      } else {
        replyToMessage(appId, appSecret, message.message_id,
          '暂未识别到股票。支持格式：\n- 代码：600519 / 00700 / NVDA\n- 名称：茅台 / 腾讯 / 英伟达\n例：@机器人 分析 600519')
          .catch(() => {});
      }
    }
  }

  return new Response('ok', { headers: { 'content-type': 'text/plain' } });
}
