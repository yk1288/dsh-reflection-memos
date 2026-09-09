/**
 * E2E 真实 MemOS 验证脚本(v5.0,正式保留)
 * 链路:MemoryStore.submit → WriteGate(四审+脱敏+patternKey查重+配额) → MemOSWriter → 真实 MemOS add/message
 *      → 轮询 search 验证召回;同时落本地账本(triage=pending)+ 审计(gate:write-gate)
 * 用独立 conversation_id('dsh:m0-verify')避免污染生产 dsh:reflection。
 *
 * 运行:
 *   MEMOS_API_KEY=<key> MEMOS_USER_ID=yk MEMOS_BASE_URL=https://memos.memtensor.cn/api/openmem/v1 \
 *   node <bundle>/e2e-memos-verify.js
 * 会向真实 MemOS 写入 1 条 fact + 1 条 lesson(含假密钥验证脱敏),验证后建议通过
 * MemOS Dashboard 清理 'dsh:m0-verify' 会话下的测试记忆(或保留作为闭环样例)。
 */
import { MemoryStore } from '../src/core/memory-store';
import { AuditLogger } from '../src/audit/logger';
import { MemOSWriter } from '../src/backends/memos-backend';

const BASE = process.env.MEMOS_BASE_URL!;
const KEY = process.env.MEMOS_API_KEY!;
const USER = process.env.MEMOS_USER_ID!;
const CONV = 'dsh:m0-verify'; // 独立会话,验证后清理

const dir = `/tmp/m0verify/ledger-${Date.now()}`;
const auditDir = `/tmp/m0verify/audit-${Date.now()}`;
const audit = new AuditLogger(auditDir);

// writer:真实 MemOS。用临时固定 conversation_id 注入(客户端类默认 dsh:reflection,
// 这里通过 monkey-patch 一次,实际生产链路 conversation_id 仍为 dsh:reflection)。
const writer = new MemOSWriter({ baseUrl: BASE, apiKey: KEY, userId: USER, timeoutMs: 8000, redact: true });

// 拦截 postAdd 改 conversation_id(仅验证用,生产 EnsureWriter 不这么做)
const origCall = (writer as any).postAdd.bind(writer);
(writer as any).postAdd = async (body: any) => origCall({ ...body, conversation_id: CONV });

const store = new MemoryStore({
  writerProvider: async () => writer,
  audit,
  ledgerDir: dir,
  gateConfig: () => ({
    evidenceMinChars: 20,
    minConfidenceForFact: 0.8,
    minConfidenceForLesson: 0.7,
    maxMemoriesPerDay: 50,
    minFailuresForLesson: 2,
    verifyIngestion: true,
    redactEnabled: true,
    minVerifyRelativity: 0.6,
    maxVerifyRetries: 5,
    verifyInitialDelayMs: 1500,
    verifyBackoffFactor: 1.6,
    searchTimeoutMs: 8000,
  }),
});

let passed = 0, failed = 0;
const assert = (n: string, c: boolean, d = '') => { if (c) { passed++; console.log(`  ✅ ${n}`); } else { failed++; console.error(`  ❌ ${n} ${d}`); } };

// 1) fact:真实内容(可被后续 search 召回)
const factOutcome = await store.submit({
  kind: 'fact',
  source: 'reflection',
  fact: {
    fact: 'DSH web 重启必须使用 launch-stop.sh 优雅停止,不应直接 pkill 全部 dsh 进程',
    verificationMethod: '真实环境验证',
    evidence: '多次直接 pkill 导致 Web 无法自愈,改用 launch-stop.sh 后 supervisor 正常拉起(足够长证据文本)',
    confidence: 0.95,
    category: 'process',
    tags: ['deployment', 'dsh'],
  },
});
console.log('fact', JSON.stringify(factOutcome));
assert('真实 fact 提交并验证入库', factOutcome.accepted === true && factOutcome.ingested === true, JSON.stringify(factOutcome));

// 2) lesson:含疑似敏感内容,验证脱敏后才落 MemOS
const secretToken = 'sk-test-abcdefghijklmnopqrstuvwxyz0123456789';
const lessonOutcome = await store.submit({
  kind: 'lesson',
  source: 'reflection',
  lesson: {
    scenario: 'FTP 覆盖线上文件',
    mistake: `直接把含 API KEY=${secretToken} 的配置覆盖到线上而不备份`,
    correctApproach: '先备份再用同步脚本覆盖,并避免在提交内容中带密钥',
    evidence: '两次覆盖出问题后确认必须先备份(足够长证明文本)',
    confidence: 0.85,
    applicableScenarios: ['deployment', 'ftp'],
    failureCount: 2,
    severity: 'high',
  },
});
console.log('lesson', JSON.stringify(lessonOutcome));
assert('真实 lesson 提交并验证入库', lessonOutcome.accepted === true && lessonOutcome.ingested === true, JSON.stringify(lessonOutcome));

// 3) 直接 search 确认脱敏:搜索刚写入的 secretToken,应无命中(已被 REDACTED 替换)
const leakProbe = await (writer as any).searchMemory(secretToken, { limit: 3, relativity: 0.4 });
const leaked = (leakProbe ?? []).some((m: any) => String(m.memory_value ?? '').includes(secretToken) || String(m.memory_key ?? '').includes(secretToken));
assert('脱敏生效:疑似密钥全网无落盘泄露', !leaked, JSON.stringify((leakProbe ?? []).map((m: any) => ({ v: String(m.memory_value ?? '').slice(0, 40) }))));

// 4) 本地账本断言
const facts = store.query({ kind: 'fact' });
const lessons = store.query({ kind: 'lesson' });
assert('账本含 fact 条目(uuid 关联)', facts.length === 1, `facts=${facts.length}`);
assert('账本含 lesson 条目且 triage=pending', lessons.length === 1 && lessons[0].triage === 'pending', `lessons=${lessons.length}`);

// 5) 审计 gate 标记 + patternKey
import * as fs from 'node:fs';
const auditFile = auditDir + '/' + fs.readdirSync(auditDir).find((f: string) => f.startsWith('audit-'));
const auditText = fs.readFileSync(auditFile, 'utf-8');
assert('审计含 gate:write-gate 标记', auditText.includes('"gate":"write-gate"'));
assert('审计含 patternKey 可追溯', auditText.includes('"patternKey"'));

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 (真实 MemOS)`);
process.exit(failed > 0 ? 1 : 0);
