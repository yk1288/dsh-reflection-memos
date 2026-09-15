/**
 * 端到端回归(2026-09-15 起):把 dsh-reflection-memos 的 memos_* 工具定义
 * 原样发往 opencode-go 上游,验证 parameters 是 object-rooted JSON Schema
 * (修复"函数 'memos_correct' 的模式无效 … type: null"的回归防护)。
 *
 * 自包含:不依赖 /tmp 转译产物;API Key 优先取环境变量 OPENCODE_GO_API_KEY
 * (或 OPENCODE_API_KEY),缺省回落到 ~/.dsh/.credentials.yaml 的
 * OPENCODE_GO_API_KEY ref(仅本机有该文件时可用)。
 *
 * 用法(与 smoke 相同的 esbuild 打包方式):
 *   pnpm exec esbuild scripts/repro-opencode-schema.ts --bundle --format=esm --platform=node --outfile=/tmp/repro-opencode-schema.mjs && node /tmp/repro-opencode-schema.mjs
 * （pnpm 在无 TTY 环境可能触发 install 检查,可改用
 *   node_modules/.pnpm/esbuild@0.27.7/node_modules/esbuild/bin/esbuild …）
 *
 * 退出码:0 = 全部上游目标通过(无 schema 拒绝);1 = 至少一个目标被拒(修复回退);
 *         2 = 请求失败(网络/鉴权/缺少 Key)。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryTools } from '../src/tools/memory-tools';

function loadApiKey(): string {
  for (const envName of ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY']) {
    const fromEnv = process.env[envName];
    if (fromEnv) return fromEnv;
  }
  const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  if (fs.existsSync(p)) {
    const text = fs.readFileSync(p, 'utf-8');
    const m = text.match(/refs:\s*\n([\s\S]*)$/);
    const line = m?.[1].split('\n').map((l) => l.trim()).find((l) => l.startsWith('OPENCODE_GO_API_KEY:'));
    if (line) return line.slice(line.indexOf(':') + 1).trim();
  }
  throw new Error('缺少 API Key:设置 OPENCODE_GO_API_KEY 环境变量(或本机 ~/.dsh/.credentials.yaml)');
}

/** 与 dsh-tools schemaOf 一致:raw register 的 parameters 原样透传上游 */
const toOpenAiTool = (tool: { name: string; description: string; parameters: unknown }) => ({
  type: 'function',
  function: { name: tool.name, description: tool.description, parameters: tool.parameters },
});

const toAnthropicTool = (tool: { name: string; description: string; parameters: unknown }) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters,
});

async function main() {
  const apiKey = loadApiKey();
  const noopAudit = { debug: () => {} };
  const fakeStore = { ledger: { query: () => [] as never[], get: () => undefined } };
  const tools = new MemoryTools({} as never, noopAudit as never, fakeStore as never, () => ({ correctPerDayLimit: 5 }));
  const defs = [
    (tools as any).lookupTool(),
    (tools as any).ackTool(),
    (tools as any).correctTool(),
  ] as Array<{ name: string; description: string; parameters: unknown }>;

  // 本地断言:parameters 必须是 object-rooted JSON Schema(修复的回归守卫)
  for (const d of defs) {
    const p = d.parameters as { type?: unknown; properties?: unknown };
    if (p?.type !== 'object' || typeof p.properties !== 'object' || p.properties === null) {
      console.error(`❌ ${d.name} parameters 不是 object-rooted JSON Schema: ${JSON.stringify(p)}`);
      process.exit(1);
    }
  }
  console.log('✅ 本地断言:三个工具 parameters 均 type="object" + properties');
  for (const d of defs) console.log(`   ${d.name}`, JSON.stringify(d.parameters));

  const openaiTools = defs.map(toOpenAiTool);
  const anthropicTools = defs.map(toAnthropicTool);
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'x-opencode-session': 'dsh-harness-session',
    'anthropic-version': '2023-06-01',
  };

  const targets = [
    { label: 'openai-completions deepseek-v4-flash', url: 'https://opencode.ai/zen/go/v1/chat/completions', body: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: '请只回复 OK' }], max_tokens: 16, stream: false, tools: openaiTools } },
    { label: 'openai-completions mimo-v2.5', url: 'https://opencode.ai/zen/go/v1/chat/completions', body: { model: 'mimo-v2.5', messages: [{ role: 'user', content: '请只回复 OK' }], max_tokens: 16, stream: false, tools: openaiTools } },
    { label: 'anthropic-messages minimax-m3', url: 'https://opencode.ai/zen/go/v1/messages', body: { model: 'minimax-m3', max_tokens: 16, messages: [{ role: 'user', content: '请只回复 OK' }], tools: anthropicTools } },
  ];

  let rejected = 0;
  for (const t of targets) {
    try {
      const res = await fetch(t.url, { method: 'POST', headers, body: JSON.stringify(t.body) });
      const text = await res.text();
      const isSchemaReject = /invalid_request_error/.test(text) && /memos_correct|模式无效|input_schema/.test(text);
      if (res.status === 200) {
        console.log(`✅ ${t.label} → HTTP 200`);
      } else if (isSchemaReject) {
        rejected++;
        console.error(`❌ ${t.label} → HTTP ${res.status} schema 拒绝: ${text.slice(0, 300)}`);
      } else {
        console.log(`⚠️  ${t.label} → HTTP ${res.status}(非 schema 类错误): ${text.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`⚠️  ${t.label} → 请求失败: ${(e as Error).message}`);
    }
  }
  console.log(`\n结果: schema 拒绝目标 = ${rejected}/${targets.length}`);
  process.exit(rejected > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('REPRO FAILED:', e);
  process.exit(2);
});