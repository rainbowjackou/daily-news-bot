#!/usr/bin/env node
// 将 Markdown 简报推送到飞书群机器人 Webhook。
// 用法: FEISHU_WEBHOOK=<webhook> node scripts/send-feishu.mjs digest.md
// 飞书文本消息上限约 30KB，这里按 20KB 自动分片、逐条发送。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.argv[2] || 'digest.md';
const webhook = process.env.FEISHU_WEBHOOK;

if (!webhook) {
  console.error('错误: 未设置 FEISHU_WEBHOOK 环境变量（GitHub Secrets 中配置，或本地 export）');
  process.exit(1);
}

let text;
try {
  text = readFileSync(resolve(file), 'utf8');
} catch (e) {
  console.error(`错误: 无法读取简报文件 ${file}: ${e.message}`);
  process.exit(1);
}

if (!text.trim()) {
  console.error('错误: 简报文件为空');
  process.exit(1);
}

const CHUNK_SIZE = 20000;
const chunks = [];
for (let i = 0; i < text.length; i += CHUNK_SIZE) {
  chunks.push(text.slice(i, i + CHUNK_SIZE));
}

for (const [i, chunk] of chunks.entries()) {
  const payload = { msg_type: 'text', content: { text: chunk } };
  let resp;
  try {
    resp = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error(`发送失败 (第 ${i + 1}/${chunks.length} 片): 网络错误 ${e.message}`);
    process.exit(1);
  }
  const body = await resp.json().catch(() => ({}));
  // 飞书机器人成功响应: {"code":0,"msg":"success"}
  if (!resp.ok || body.code !== 0) {
    console.error(`发送失败 (第 ${i + 1}/${chunks.length} 片): HTTP ${resp.status}`, JSON.stringify(body));
    process.exit(1);
  }
  console.log(`已发送第 ${i + 1}/${chunks.length} 片 (${chunk.length} 字符)`);
}

console.log(`飞书推送完成，共 ${chunks.length} 条消息`);
