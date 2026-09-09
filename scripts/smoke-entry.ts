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
import * as fs from 'node:fs';
import { redactText, sanitizeExcerpt } from '../src/core/redact';
import { LedgerBackend } from '../src/backends/ledger-backend';
import { EvolutionLedger, contentKey } from '../src/core/ledger';
import { WriteGate, derivePatternKey } from '../src/core/write-gate';
import type { WriteGateConfig } from '../src/core/write-gate';
import { MemoryStore } from '../src/core/memory-store';
import { RetrievalPipeline } from '../src/core/retrieval';
import { ApplierModule } from '../src/loop/applier';
import { RefinerModule } from '../src/modules/refiner';
import { AuditLogger } from '../src/audit/logger';
import type { EvolutionEntry } from '../src/types/evolution';
import type { ReflectionResult } from '../src/types/reflection';
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
    const mk = (i: number) => ({ kind: 'fact' as const, fact: { fact: `配额测试事实 ${i}`, verificationMethod: 'm', evidence: '这是一段足够长的证据文本用于配额测试内容', confidence: 0.9, category: 'technical' as const, tags: [] as string[] }, source: 'reflection' as const });
    const a = await gate2.submit(mk(0));
    const b = await gate2.submit(mk(1));
    const c = await gate2.submit(mk(2));
    const d = await gate2.submit(mk(3));
    assert('配额:前三条写入', a.accepted === true && b.accepted === true && c.accepted === true);
    assert('每日配额生效(maxPerDay=3,第4条被拒)', d.accepted === false && d.reason === 'quota', JSON.stringify(d));
  }

  // 防回归(真实环境修复):已确认(acknowledged)的教训不被重写回 pending
  {
    const gate3 = new WriteGate({ writer: stubWriter, ledger, audit, config: () => ({ ...cfg, maxMemoriesPerDay: 3 }) });
    // 先写入一条 lesson(未达 minFailures 会拒,直接绕过用 createEntry + upsert 模拟账本态)
    const seeded = ledger.createEntry({
      content: '已确认教训内容文本', kind: 'lesson', patternKey: 'fix.confirm-keep',
      failureCount: 2, importance: 0.9, scenarios: ['x'], triage: 'acknowledged',
    });
    ledger.upsert(seeded);
    // 再次提交同内容 lesson(fresh 分支会走 createEntry+upsert)
    const r7 = await gate3.submit({ kind: 'lesson', lesson: {
      scenario: '确认保持', mistake: 'm', correctApproach: '已确认教训内容文本',
      evidence: '这是一段足够长的证据文本用于确认保持测试', confidence: 0.9,
      applicableScenarios: ['x'], failureCount: 2, severity: 'high',
    }, source: 'reflection' });
    const afterEntry = r7.memoryKey ? ledger.get(r7.memoryKey) : undefined;
    assert('防回归:重写保留 acknowledged(不重置 pending)', afterEntry?.triage === 'acknowledged', JSON.stringify(afterEntry && { triage: afterEntry.triage, status: afterEntry.status }));
  }
}

// ---------- 4. M1 集成:MemoryStore(writerProvider)+ RefinerModule ----------
console.log('\n[4] M1 集成:refiner → MemoryStore → WriteGate');
{
  const dir = `/tmp/sia-m1-test-${Date.now()}`;
  const auditDir = `/tmp/sia-m1-audit-${Date.now()}`;
  const audit = new AuditLogger(auditDir);

  // stub writer:只统计调用,不真发 MemOS
  let stubCalls = 0;
  const stub = {
    submitVerifiedFact: async () => { stubCalls++; return { success: true, taskId: 'm1-fact' }; },
    submitLesson: async () => { stubCalls++; return { success: true, taskId: 'm1-lesson' }; },
    verifyIngestion: async () => true,
  } as unknown as MemOSWriter;

  const store = new MemoryStore({
    writerProvider: async () => stub,
    audit,
    ledgerDir: dir,
    gateConfig: () => ({ ...minimum, maxMemoriesPerDay: 20 }),
  });

  const refiner = new RefinerModule({} as never, () => cfgForRefiner(20), audit, store);

  const result: ReflectionResult = {
    version: '1.0',
    taskSuccess: true,
    overallScore: 0.9,
    errors: [],
    verifiedFacts: [
      {
        fact: 'DSH web 重启必须使用 launch-stop.sh',
        verificationMethod: '真实环境验证',
        evidence: '多次直接 pkill 导致 Web 无法自愈,改用脚本后 supervisor 正常拉起(足够长证据)',
        confidence: 0.95,
        category: 'process',
        tags: ['deployment'],
      },
    ],
    lessons: [
      {
        scenario: '重启 DSH Web',
        mistake: '直接 pkill 全部 dsh 进程',
        correctApproach: '使用 launch-stop.sh 优雅停止',
        evidence: '两次踩坑后确认脚本方式可靠(足够长证据文本)', // 非空
        confidence: 0.85,
        applicableScenarios: ['deployment'],
        failureCount: 2,
        severity: 'high',
      },
    ],
    improvements: [],
  };

  const summary = await refiner.processReflectionResult(result);
  assert('processReflectionResult 汇总:1 fact + 1 lesson 入库', summary.ingestedCount === 2 && summary.failedCount === 0, JSON.stringify(summary));
  assert('写入经 WriteGate(stub 被调用 2 次:fact+lesson)', stubCalls === 2, `calls=${stubCalls}`);

  // 账本里应有两类条目,lesson 默认 triage=pending
  const factsIn = store.query({ kind: 'fact' });
  const lessonsIn = store.query({ kind: 'lesson' });
  assert('账本记录 fact 条目', factsIn.length === 1);
  assert('账本记录 lesson 条目且 triage=pending', lessonsIn.length === 1 && lessonsIn[0].triage === 'pending');

  // 审计带 gate: write-gate 标记
  const auditText = listAudit(auditDir);
  assert('审计含 gate:write-gate 标记', auditText.includes('"gate":"write-gate"'), auditText.slice(0, 200));

  // activeLessons: pending 不应被检索到(GAP-3)
  assert('pending 教训不参与召回检索', store.activeLessons('重启 DSH Web').length === 0);
  // 确认分流后再检索 → 命中
  for (const e of lessonsIn) store.ledger.acknowledge(e.memoryKey);
  assert('确认后教训可被检索', store.activeLessons('重启 DSH Web').length === 1);
}

// ---------- 5. M2 检索注入:RetrievalPipeline + Applier ----------
console.log('\n[5] M2 检索注入(双区):retrieval → applier');
{
  const dir = `/tmp/sia-m2-test-${Date.now()}`;
  const auditDir = `/tmp/sia-m2-audit-${Date.now()}`;
  const audit = new AuditLogger(auditDir);
  const store = new MemoryStore({
    writerProvider: null,
    audit,
    ledgerDir: dir,
  });

  // 准备账本:两条 lesson(一条高 importance 高价值,一条普通),确认 active
  const high = store.ledger.createEntry({
    content: 'FTP 覆盖线上文件必须先备份,再用同步脚本覆盖,且不要在提交内容中带密钥',
    kind: 'lesson',
    patternKey: 'ftp.先备份',
    importance: 0.95,
    failureCount: 3,
    scenarios: ['FTP', 'deployment'],
    triage: 'acknowledged',
  });
  store.ledger.upsert(high);
  const low = store.ledger.createEntry({
    content: '无关的场景 2 教训内容占位文本',
    kind: 'lesson',
    patternKey: 'other.unrelated',
    importance: 0.3,
    failureCount: 1,
    scenarios: ['other'],
    triage: 'acknowledged',
  });
  store.ledger.upsert(low);

  const pipeline = new RetrievalPipeline(store.ledger, () => ({
    coreZoneMax: 2,
    contextZoneMax: 3,
    maxInjectionChars: 600,
    maxItemChars: 200,
    enableAck: true,
  }));

  // ① pending 不注入:额外 pending lesson
  const pending = store.ledger.createEntry({
    content: 'pending 未确认的教训不应被注入',
    kind: 'lesson',
    patternKey: 'pending.x',
    importance: 0.9,
    failureCount: 1,
    scenarios: ['FTP'],
    triage: 'pending',
  });
  store.ledger.upsert(pending);
  const beforeHit = store.ledger.get(high.memoryKey)?.hitCount ?? 0;
  const build1 = pipeline.retrieve({ intent: '帮我部署文件到 FTP' });
  assert('M2: 检索命中(FTP 意图)', build1.hit === true, JSON.stringify(build1.lessons.map((l) => l.patternKey)));
  assert('M2: pending 教训不注入(GAP-3)', !build1.lessons.some((l) => l.memoryKey === pending.memoryKey));
  assert('M2: 核心区含高价值教训(ftp.先备份)', build1.lessons.some((l) => l.patternKey === 'ftp.先备份' && l.zone === 'core'));
  assert('M2: 注入块含 ack 提示', build1.block.includes('如何应用'));
  assert('M2: 注入块含意图标记', build1.block.includes('FTP'));
  const afterHit = store.ledger.get(high.memoryKey)?.hitCount ?? 0;
  assert('M2: 命中后 hitCount 递增(touch)', afterHit === beforeHit + 1, `before=${beforeHit} after=${afterHit}`);

  // ② 无关意图:不应有 context 区注入(核心区常驻属设计语义,允许)
  const build2 = pipeline.retrieve({ intent: '帮我写一首诗' });
  assert('M2: 无关意图无 context 区注入', !build2.lessons.some((l) => l.zone === 'context'), JSON.stringify(build2.lessons.map((l) => l.zone)));
  assert('M2: 无关意图核心区仍常驻(高价值)', build2.lessons.some((l) => l.zone === 'core' && l.patternKey === 'ftp.先备份'));

  // ③ 完全空账本:不注入
  const emptyStore = new MemoryStore({ writerProvider: null, audit, ledgerDir: `/tmp/sia-m2-empty-${Date.now()}` });
  const emptyPipe = new RetrievalPipeline(emptyStore.ledger, () => ({
    coreZoneMax: 2, contextZoneMax: 3, maxInjectionChars: 600, maxItemChars: 200, enableAck: true,
  }));
  assert('M2: 空账本不注入', emptyPipe.retrieve({ intent: '任意意图' }).hit === false);

  // ④ Applier 集成:pre-step payload 注入
  const applier = new ApplierModule(
    { on: () => {} } as never,
    () => ({
      applier: {
        enableLessonInjection: true,
        coreZoneMax: 2,
        contextZoneMax: 3,
        maxInjectionChars: 600,
        maxItemChars: 200,
        enableAck: true,
        enableCompliance: false,
      },
    }) as never,
    audit,
    store,
  );
  // 手动调用内部逻辑(经公共 API:直接验证 payload 注入)
  const payload: any = {
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', content: [{ type: 'text', text: '帮我部署文件到 FTP 并覆盖' }] },
    ],
  };
  (applier as any).maybeInject(payload);
  const lastContent = payload.messages[1].content;
  const injected = lastContent.find((b: any) => b.type === 'text' && b.text.includes('经验提醒'));
  assert('M2: applier 在 pre-step 注入提醒块(user 消息后)', Boolean(injected), JSON.stringify(lastContent));
  assert('M2: 注入块存在且含教训文本', injected?.text.includes('FTP 覆盖线上文件必须先备份'));
}

// ---------- 辅助 ----------
const minimum = {
  evidenceMinChars: 20,
  minConfidenceForFact: 0.8,
  minConfidenceForLesson: 0.7,
  maxMemoriesPerDay: 50,
  minFailuresForLesson: 2,
  verifyIngestion: true,
  redactEnabled: true,
  minVerifyRelativity: 0.6,
  maxVerifyRetries: 1,
  verifyInitialDelayMs: 1,
  verifyBackoffFactor: 1.1,
  searchTimeoutMs: 1000,
};

function cfgForRefiner(maxPerDay: number) {
  return {
    refiner: { writeVerifiedFacts: true, writeLessons: true, maxMemoriesPerDay: maxPerDay },
  } as never;
}

function listAudit(dir: string): string {
  const files = fs.readdirSync(dir);
  const f = files.find((x) => x.startsWith('audit-'));
  if (!f) return '';
  return fs.readFileSync(`${dir}/${f}`, 'utf-8');
}

function pathForAudit() {
  return `/tmp/sia-audit-test-${Date.now()}`;
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);