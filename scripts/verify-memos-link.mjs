#!/usr/bin/env node
/**
 * 第 0 天链路验证(v3.2 文档"前置准备")
 * 1. 从 ~/.dsh/.credentials.yaml 读取 MEMOS_API_KEY
 * 2. POST /add/message 提交一条测试事实(async_mode: true)
 * 3. 指数退避轮询 POST /search/memory,打印 memory_detail_list 结构与 relativity 语义
 *
 * 用法:node scripts/verify-memos-link.mjs [baseUrl] [userId]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CRED_FILE = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const SETTINGS_FILE = path.join(os.homedir(), '.dsh', 'settings.yaml');

function yamlValue(text, key) {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, 'm');
  const m = re.exec(text);
  return m ? m[1].replace(/^['"]|['"]$/g, '') : undefined;
}

function memosSource() {
  if (process.platform === 'win32') return 'deepseek_harness_win';
  if (process.platform === 'darwin') return 'deepseek_harness_mac';
  return 'deepseek_harness_linux';
}

async function main() {
  const creds = fs.readFileSync(CRED_FILE, 'utf-8');
  const apiKey = yamlValue(creds, 'MEMOS_API_KEY') || process.env.MEMOS_API_KEY;
  if (!apiKey) {
    console.error('❌ 未找到 MEMOS_API_KEY(检查 ~/.dsh/.credentials.yaml)');
    process.exit(1);
  }

  let settings = '{}';
  try { settings = fs.readFileSync(SETTINGS_FILE, 'utf-8'); } catch { /* 默认 */ }
  const baseUrl = process.argv[2] || yamlValue(settings, 'baseURL: https://memos.memtensor.cn/api/openmem/v1') || 'https://memos.memtensor.cn/api/openmem/v1';
  const userId = process.argv[3] || yamlValue(settings, 'userId: yk') || yamlValue(creds, 'MEMOS_USER_ID') || 'yk';

  const headers = { 'Content-Type': 'application/json', Authorization: `Token ${apiKey}` };
  const testContent = `【REFLECTION-LINK-TEST】我确认一个事实:MemOS 反思闭环链路验证测试 ${new Date().toISOString()}。证据:本消息由 verify-memos-link 脚本提交。置信度:100%。标签:verified_fact, category:testing。`;

  console.log(`⚙️  baseUrl=${baseUrl}`);
  console.log(`⚙️  userId=${userId}`);

  // 1. add/message(异步)
  console.log('\n① POST /add/message ...');
  const addRes = await fetch(`${baseUrl}/add/message`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      user_id: userId,
      conversation_id: 'dsh:reflection-link-test',
      messages: [{ role: 'user', content: testContent }],
      source: memosSource(),
      async_mode: true,
      allow_public: false,
      tags: ['verified_fact', 'category:testing', 'deepseek-harness'],
      info: { source: 'verify-memos-link', version: '1.0' },
    }),
  });
  const addBody = await addRes.json();
  console.log(`   HTTP ${addRes.status} →`, JSON.stringify(addBody).slice(0, 300));
  if (!addRes.ok || (addBody.code !== 0 && addBody.code !== 200)) {
    console.error('❌ add/message 失败');
    process.exit(1);
  }
  console.log('   ✅ add/message 已受理');

  // 2. 轮询 search/memory
  console.log('\n② 轮询 POST /search/memory(3s→5.4s→9.7s,最多 3 次)...');
  const query = '反思闭环链路验证测试';
  let delay = 3000;
  let found = null;
  for (let i = 0; i < 3; i++) {
    await new Promise(r => setTimeout(r, delay));
    delay = Math.floor(delay * 1.8);
    const searchRes = await fetch(`${baseUrl}/search/memory`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_id: userId,
        query,
        memory_limit_number: 5,
        include_preference: false,
        include_tool_memory: false,
        relativity: 0.3,
      }),
    });
    const searchBody = await searchRes.json();
    const list = searchBody?.data?.memory_detail_list ?? [];
    console.log(`   [${i + 1}] 命中 ${list.length} 条`);
    if (list.length > 0) {
      found = list[0];
      break;
    }
  }

  if (!found) {
    console.error('❌ 轮询未命中任何记忆(服务端抽取可能为空或需要更久)');
    console.log('\n⚠️  如失败:检查 conversation_id 冲突、async 处理时间、或 service 端抽取策略。');
    process.exit(1);
  }

  console.log('\n✅ 链路验证通过!第一条命中条目(真实结构):');
  console.log(JSON.stringify(
    { memory_key: found.memory_key, memory_value: found.memory_value, relativity: found.relativity, id: found.id },
    null,
    2,
  ));
  console.log('\n📌 供 v3.2 实现校准:verifyIngestion 应解析 data.memory_detail_list,用 top.relativity >= 0.6 判定。');
}

main().catch(e => { console.error('异常:', e); process.exit(1); });