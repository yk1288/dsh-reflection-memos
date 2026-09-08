/**
 * M0 核心逻辑冒烟测试(v5.0)
 *
 * 覆盖:
 *  1. redact: 脱敏层(GAP-1)常见敏感形态
 *  2. Ledger: 状态机非法迁移、fingerprint 主键、patternKey 折叠(GAP-2)
 *  3. WriteGate: 证据/置信度拒收、配额、pending 分流(GAP-3)、stub 写入验证
 *
 * 运行:pnpm exec esbuild scripts/smoke-entry.ts --bundle --format=esm --platform=node --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs
 */
import { redactText, sanitizeExcerpt } from '../src/core/redact';
import { LedgerBackend } from '../src/backends/ledger-backend';
import { EvolutionLedger, contentKey } from '../src/core/ledger';
import { WriteGate, derivePatternKey } from '../src/core/write-gate';
import { AuditLogger } from '../src/audit/logger';
import type { WriteGateConfig } from '../src/core/write-gate';
import type { MemOSWriter } from '../src/backends/memos-backend';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------- 1. redact ----------
console.log('\n[1] 脱敏层(研究 GAP-1)');
{
  const withToken = '使用 TOKEN=sk-abc1234567890 调用,Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc';
  const out = redactText(withToken);
  assert('token 被替换', !out.includes('sk-abc1234567890') && out.includes('[REDACTED]'), out);
  assert('jwt 被替换', !out.includes('eyJhbGciOiJIUzI1NiI'), out);
  assert('Bearer 形状保留语义', out.includes('Bearer [REDACTED]'), out);

  const noSecret = '正常命令: ls -la /tmp';
  assert('无敏感内容原样返回', redactText(noSecret) === noSecret);

  const excerpt = sanitizeExcerpt(`error: token=abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG 很长很长很长的错误输出`.repeat(5), 120);
  assert('摘要脱敏+截断', excerpt.length <= 122 && !excerpt.includes('abcdefghijklmnopqrstuvwxyz1234567890'), excerpt.slice(0, 60));
}

// ---------- 2. Ledger 状态机 + patternKey ----------
console.log('\n[2] 账本状态机(研究 GAP-2/3)');
{
  const dir = `/tmp/sia-ledger-test-${Date.now()}`;
  const ledger = new EvolutionLedger(new LedgerBackend({ dir }));

  const e1 = ledger.createEntry({ content: '命令不存在时,先查 PATH', kind: 'lesson', patternKey: 'shell.command-not-found', failureCount: 1, triage: 'pending' });
  ledger.upsert(e1);
  assert('fingerprint 主键稳定', contentKey('命令不存在时,先查 PATH') === e1.memoryKey);
  assert('自动链路默认 triage=pending', e1.triage === 'pending');

  // 折叠:同 patternKey 复发 → 不新建
  const folded = ledger.foldRecurrence('shell.command-not-found', 'lesson');
  assert('patternKey 折叠命中', folded !== null && folded.failureCount === 2);
  assert('折叠不新建条目', ledger.query({ patternKey: 'shell.command-not-found' }).length === 1);

  // 状态机:非法迁移拒绝
  let threw = false;
  try {
    ledger.transition(e1.memoryKey, 'superseded');
    ledger.transition(e1.memoryKey, 'active'); // superseded 不可再变
  } catch {
    threw = true;
  }
  assert('非法状态迁移抛错(superseded→active)', threw);

  // 防循环
  const a = ledger.createEntry({ content: 'A 方案', kind: 'lesson', patternKey: 'x.a' });
  const b = ledger.createEntry({ content: 'B 方案', kind: 'lesson', patternKey: 'x.b', supersedes: [a.memoryKey] });
  ledger.upsert(a);
  ledger.upsert(b);
  const { wouldCreateCycle } = await import('../src/core/ledger');
  assert('supersedes 循环检测 A→B→A 拒绝', wouldCreateCycle(ledger, a.memoryKey, b.memoryKey) === true);
}

// ---------- 3. WriteGate ----------
console.log('\n[3] 单一写入闸门');
{
  const dir = `/tmp/sia-gate-test-${Date.now()}`;
  const ledger = new EvolutionLedger(new LedgerBackend({ dir }));
  const audit = new AuditLogger(pathForAudit());

  // stub writer:不真连 MemOS
  let submittedCount = 0;
  const stubWriter = {
    submitVerifiedFact: async () => { submittedCount++; return { success: true, taskId: 't1' }; },
    submitLesson: async () => { submittedCount++; return { success: true, taskId: 't2' }; },
    verifyIngestion: async () => true,
  } as unknown as MemOSWriter;

  const cfg: WriteGateConfig = {
    evidenceMinChars: 20,
    minConfidenceForFact: 0.8,
    minConfidenceForLesson: 0.7,
    maxMemoriesPerDay: 6,   // 覆盖:2 拒(不计配额) + 1 fact + 2 lesson + …必须富余
    minFailuresForLesson: 2,
    verifyIngestion: true,
    redactEnabled: true,
    minVerifyRelativity: 0.6,
    maxVerifyRetries: 1,
    verifyInitialDelayMs: 1,
    verifyBackoffFactor: 1.1,
    searchTimeoutMs: 1000,
  };
  const gate = new WriteGate({ writer: stubWriter, ledger, audit, config: () => cfg });

  // 证据不足拒收
  const r1 = await gate.submit({ kind: 'fact', fact: { fact: 'x', verificationMethod: 'm', evidence: '短', confidence: 0.9, category: 'technical', tags: [] }, source: 'reflection' });
  assert('证据不足拒收', r1.accepted === false && r1.reason === 'rejected');

  // 置信度不足拒收
  const r2 = await gate.submit({ kind: 'fact', fact: { fact: 'x', verificationMethod: 'm', evidence: '这是一段足够长的证据文本用于测试', confidence: 0.5, category: 'technical', tags: [] }, source: 'reflection' });
  assert('置信度不足拒收', r2.accepted === false && r2.reason === 'rejected');

  // 合格 fact 通过(stub 验证通过)
  const r3 = await gate.submit({ kind: 'fact', fact: { fact: 'DSH web 重启需用 launch-stop.sh', verificationMethod: '实测', evidence: '多次直接 pkill 导致 Web 无法自愈,改用脚本后正常(足够长证据)', confidence: 0.95, category: 'process', tags: ['deployment'] }, source: 'reflection' });
  assert('合格 fact 通过且入库', r3.accepted === true && r3.ingested === true, JSON.stringify(r3));

  // lesson 未达 minFailures 且无命中 → 拒
  const r4 = await gate.submit({ kind: 'lesson', lesson: { scenario: '部署 DSH Web', mistake: '直接 pkill 所有 dsh 进程', correctApproach: '使用 launch-stop.sh 优雅停止', evidence: '多次踩坑后验证脚本方式可靠(足够长)', confidence: 0.85, applicableScenarios: ['deployment'], failureCount: 1, severity: 'high' }, source: 'sweep' });
  assert('minFailures=2 未达标拒收', r4.accepted === false && r4.reason === 'rejected', JSON.stringify(r4));

  // 达标 lesson 通过
  const r5 = await gate.submit({ kind: 'lesson', lesson: { scenario: '部署 DSH Web', mistake: '直接 pkill 所有 dsh 进程', correctApproach: '使用 launch-stop.sh 优雅停止', evidence: '两次踩坑后验证脚本方式可靠(足够长证据文本)', confidence: 0.85, applicableScenarios: ['deployment'], failureCount: 2, severity: 'high' }, source: 'sweep' });
  assert('达标 lesson 通过', r5.accepted === true && r5.memoryKey != null, JSON.stringify(r5));
  assert('lesson 条目 triage=pending(自动链路未确认)', ledger.get(r5.memoryKey!)?.triage === 'pending');

  // patternKey 推导
  assert('patternKey 推导 area.symptom', derivePatternKey('部署 DSH Web 时') === '部署.dsh'.slice(0, 60), derivePatternKey('部署 DSH Web 时'));

  // 配额:用独立新 gate(value ref),maxPerDay=3,验证第三条被拒
  {
    const gate2 = new WriteGate({ writer: stubWriter, ledger, audit, config: () => ({ ...cfg, maxMemoriesPerDay: 3 }) });
    const mk = (i: number) => ({ kind: 'fact' as const, fact: { fact: `配额测试事实 ${i}`, verificationMethod: 'm', evidence: '这是一段足够长的证据文本用于配额测试内容', confidence: 0.9, category: 'technical', tags: [] }, source: 'reflection' as const });
    const a = await gate2.submit(mk(0));
    const b = await gate2.submit(mk(1));
    const c = await gate2.submit(mk(2));
    const d = await gate2.submit(mk(3));
    assert('配额:前三条写入', a.accepted === true && b.accepted === true && c.accepted === true);
    assert('每日配额生效(maxPerDay=3,第4条被拒)', d.accepted === false && d.reason === 'quota', JSON.stringify(d));
  }
}

function pathForAudit() {
  return `/tmp/sia-audit-test-${Date.now()}`;
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);