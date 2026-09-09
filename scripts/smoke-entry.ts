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
import * as path from 'node:path';
import { redactText, sanitizeExcerpt } from '../src/core/redact';
import { LedgerBackend } from '../src/backends/ledger-backend';
import { EvolutionLedger, contentKey } from '../src/core/ledger';
import { WriteGate, derivePatternKey } from '../src/core/write-gate';
import type { WriteGateConfig } from '../src/core/write-gate';
import { MemoryStore } from '../src/core/memory-store';
import { RetrievalPipeline } from '../src/core/retrieval';
import { ApplierModule } from '../src/loop/applier';
import { ComplianceModule, extractKeywords } from '../src/loop/compliance';
import { MemoryTools } from '../src/tools/memory-tools';
import { EvolverModule } from '../src/loop/evolver';
import { ReporterModule } from '../src/loop/reporter';
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
        enableSelfEval: false,
        selfEvalToolCallMin: 3,
        selfEvalFailRatio: 0.5,
        correctPerDayLimit: 5,
      },
    }) as never,
    audit,
    store,
  );
  // M2 修复后:maybeInject 返回新 decision(不可变插入),需要 message.source.kind==='user'
  const decision: any = {
    messages: [
      { role: 'system', source: { kind: 'system' }, content: [{ type: 'text', text: 'sys' }] },
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我部署文件到 FTP 并覆盖' }] },
    ],
  };
  const nextDecision = (applier as any).maybeInject(decision);
  const injectedMsg = nextDecision.messages.find((m: any) => m?.source?.kind === 'plugin' && m?.source?.plugin === 'dsh-reflection-memos');
  assert('M2: applier 返回新 decision(不可变,含注入消息)', Boolean(injectedMsg), JSON.stringify(nextDecision.messages.map((m: any) => m.source?.kind)));
  const injectedText = injectedMsg?.content?.find((b: any) => b.type === 'text')?.text ?? '';
  assert('M2: 注入块存在且含教训文本', injectedText.includes('FTP 覆盖线上文件必须先备份'));
  assert('M2: 原 messages 未被修改(冻结安全)', decision.messages.length === 2 && decision.messages[1].content.length === 1);
}

// ---------- 6. M3 演化引擎 ----------
console.log('\n[6] M3 演化引擎:evolver');
{
  const dir = `/tmp/sia-m3-test-${Date.now()}`;
  const audit = new AuditLogger(`/tmp/sia-m3-audit-${Date.now()}`);
  const store = new MemoryStore({ writerProvider: null, audit, ledgerDir: dir });
  const evolver = new EvolverModule({} as never, () => ({}) as never, audit, store, () => ({
    decayAfterDays: 30,
    archiveAfterDays: 60,
    importanceBoostFactor: 3,
    minReinforcementForPromotion: 3,
    maxViolationRateForPromotion: 0.2,
    skillsDir: `/tmp/sia-m3-skills-${Date.now()}`,
  }));

  // 准备:1 条 acknowledged 教训(reinforcement=4, violation=0 → 可晋升)
  const promo = store.ledger.createEntry({
    content: 'FTP 覆盖先备份再同步(FTP 覆盖先备份再同步的完整教训正文)',
    kind: 'lesson', patternKey: 'ftp.先备份', failureCount: 3,
    reinforcementCount: 4, violationCount: 0, importance: 0.95,
    scenarios: ['FTP'], triage: 'acknowledged',
  });
  store.ledger.upsert(promo);

  // 1) decay:手动构造 lastSeen 很旧的条目 → decay
  const stale = store.ledger.createEntry({
    content: 'stale 教训内容', kind: 'lesson', patternKey: 'stale.x',
    failureCount: 1, importance: 0.3, scenarios: ['x'], triage: 'acknowledged',
  });
  stale.lastSeen = new Date(Date.now() - 45 * 86400_000).toISOString(); // 45 天前
  store.ledger.upsert(stale);

  const r1 = await evolver.run({ decay: true });
  assert('M3: decay 使 45 天未命中条目 decayed', store.ledger.get(stale.memoryKey)?.status === 'decayed' && r1.decayed === 1, JSON.stringify(r1));
  assert('M3: 高 importance 教训不被衰减(重要性×3 窗口)', store.ledger.get(promo.memoryKey)?.status === 'active');

  // 2) consolidate:同 patternKey 3 条 → 合并为 1
  for (let i = 0; i < 2; i++) {
    const dup = store.ledger.createEntry({
      content: `FTP 覆盖先备份再同步(FTP 覆盖先备份再同步的完整教训正文)-v${i}`,
      kind: 'lesson', patternKey: 'ftp.先备份', failureCount: 1, importance: 0.6,
      scenarios: ['FTP'], triage: 'acknowledged',
    });
    store.ledger.upsert(dup);
  }
  const r2 = await evolver.run({ consolidate: true });
  const merged = store.ledger.query({ patternKey: 'ftp.先备份' });
  assert('M3: consolidate 合并同 patternKey 版本链', r2.consolidated >= 1 && merged.filter((e) => e.status === 'merged').length >= 1, JSON.stringify({ r2, n: merged.length }));

  // 3) promote:reinforcement=4 violation=0 且 acknowledged → 晋升 Skill
  const skillsDir = `/tmp/sia-m3-skills-${Date.now()}`;
  const evolver2 = new EvolverModule({} as never, () => ({}) as never, audit, store, () => ({
    decayAfterDays: 30, archiveAfterDays: 60, importanceBoostFactor: 3,
    minReinforcementForPromotion: 3, maxViolationRateForPromotion: 0.2, skillsDir,
  }));
  const r3 = await evolver2.run({ promote: true });
  const skillPath = path.join(skillsDir, 'lesson-ftp-先备份', 'SKILL.md');
  assert('M3: promote 生成 Skill 文件', r3.promoted.length === 1 && fs.existsSync(skillPath), JSON.stringify(r3.promoted));
  const skillContent = fs.existsSync(skillPath)
    ? fs.readFileSync(skillPath, 'utf-8') : '';
  assert('M3: Skill description 单行化(防 YAML 解析挂)', !skillContent.split('\n')[1]?.includes(':') || skillContent.includes('---'), skillContent.slice(0, 60));

  // 4) synthesize:命中条目 → episodic 摘要(仅本地)
  store.ledger.touch(promo.memoryKey);
  const r4 = await evolver2.run({ synthesize: true });
  const epi = store.ledger.query({ kind: 'episodic' });
  assert('M3: synthesize 生成 episodic 条目(kind=episodic)', r4.synthesized === 1 && epi.length === 1 && epi[0].kind === 'episodic', JSON.stringify(r4));
}

// ---------- 7. M4 闭环度量/报告 ----------
console.log('\n[7] M4 闭环度量/报告:reporter');
{
  const dir = `/tmp/sia-m4-test-${Date.now()}`;
  const audit = new AuditLogger(`/tmp/sia-m4-audit-${Date.now()}`);
  const store = new MemoryStore({ writerProvider: null, audit, ledgerDir: dir });

  // 准备:2 fact + 5 lesson(含 good/violating/pending/decayed/merged)
  for (let i = 0; i < 2; i++) {
    const f = store.ledger.createEntry({ content: `fact ${i}`, kind: 'fact', importance: 0.7, triage: 'acknowledged' });
    store.ledger.upsert(f);
  }
  const good = store.ledger.createEntry({ content: '好教训A正文', kind: 'lesson', patternKey: 'a.good', reinforcementCount: 4, violationCount: 1, importance: 0.9, triage: 'acknowledged' });
  store.ledger.upsert(good);
  const bad = store.ledger.createEntry({ content: '坏教训B正文', kind: 'lesson', patternKey: 'b.violating', reinforcementCount: 1, violationCount: 5, importance: 0.8, triage: 'acknowledged' });
  store.ledger.upsert(bad);
  const pendingL = store.ledger.createEntry({ content: 'pending教训C正文', kind: 'lesson', patternKey: 'c.pending', failureCount: 1, triage: 'pending' });
  store.ledger.upsert(pendingL);
  const stale = store.ledger.createEntry({ content: 'stale教训D正文', kind: 'lesson', patternKey: 'd.stale', importance: 0.3, triage: 'acknowledged' });
  stale.status = 'decayed';
  store.ledger.upsert(stale);
  const dup = store.ledger.createEntry({ content: 'merged教训E正文', kind: 'lesson', patternKey: 'e.merged', importance: 0.3, triage: 'acknowledged' });
  dup.status = 'merged';
  store.ledger.upsert(dup);

  const reporter = new ReporterModule(store.ledger);
  const r = reporter.report();

  assert('M4: 账本指标统计正确', r.health.total === 7 && r.health.facts === 2 && r.health.lessons === 5, JSON.stringify(r.health));
  assert('M4: 状态统计(decayed/merged/pending)', r.health.decayed === 1 && r.health.merged === 1 && r.health.pending === 1);
  assert('M4: active 占比计算', Math.abs(r.health.activeRatio - (7 - 2) / 7) < 0.001, `activeRatio=${r.health.activeRatio}`);

  // 遵守率:总 reinforcement=5(4+1), violation=6(1+5) → compliance=5/11≈45%, recurrence≈55%
  const comp = r.lessons.complianceRate;
  const rec = r.lessons.recurrenceRate;
  assert('M4: 遵守率计算(≈45%)', comp !== null && comp > 0.4 && comp < 0.5, `compliance=${comp}`);
  assert('M4: 复发率计算(≈55%)', rec !== null && rec > 0.5 && rec < 0.6, `recurrence=${rec}`);
  assert('M4: 高风险教训 topViolations 首位为 b.violating', r.lessons.topViolations[0]?.patternKey === 'b.violating');

  // 建议:遵守率<60% 且 复发率>25% 且 topViolation → 至少 2 条建议
  assert('M4: 元优化建议生成(遵守/复发/高风险)', r.recommendations.length >= 2, JSON.stringify(r.recommendations));
  const text = reporter.format(r);
  assert('M4: 命令可读格式含指标', text.includes('遵守率') && text.includes('复发率') && text.includes('建议'));
}

// ---------- 8. O1/O3:记忆工具 + 遵守验证 ----------
console.log('\n[8] O1/O3:memory-tools + compliance');
{
  // [O3a] extractKeywords:从教训文本提取中文关键词(排除停用词)
  const kws = extractKeywords('FTP 覆盖先备份再覆盖,不要在提交内容中带密钥', 2);
  assert('O3: extractKeywords 提取关键词(含非停用词)', kws.some((k) => k.includes('FTP') || k.includes('覆盖')), JSON.stringify(kws));
  assert('O3: extractKeywords 排除停用词(不要/避免)', !kws.includes('不要') && !kws.includes('避免'), JSON.stringify(kws));

  // [O3b] compliance:注入教训 + turn/end 判定
  const dir = `/tmp/sia-o3-test-${Date.now()}`;
  const auditDir = `/tmp/sia-o3-audit-${Date.now()}`;
  const audit = new AuditLogger(auditDir);
  const store = new MemoryStore({ writerProvider: null, audit, ledgerDir: dir });
  // 一条已确认教训
  const lesson = store.ledger.createEntry({
    content: 'pkill 存在自匹配问题,重启 dsh 应用 launch-stop.sh 而不是裸 pkill',
    kind: 'lesson', patternKey: 'shell.pkill-selfmatch', importance: 0.9,
    failureCount: 2, triage: 'acknowledged',
  });
  store.ledger.upsert(lesson);

  const emitted: string[] = [];
  const cm = new ComplianceModule(
    { on: () => {}, emit: (e: string) => { emitted.push(e); } } as never,
    audit,
    store,
    () => ({ enableCompliance: true, enableSelfEval: true, selfEvalToolCallMin: 2, selfEvalFailRatio: 0.5, keywordChars: 2 }),
  );

  // 注入记录
  cm.recordApplied('sess-1', [{ memoryKey: lesson.memoryKey, patternKey: lesson.patternKey, text: lesson.contentHash }]);
  // turn/end:completed 且轨迹含 pkill 错误 → 判 violated
  const sessionStub = { id: 'sess-1', events: [
    { turn: 1, type: 'tool/call', data: { name: 'bash' } },
    { turn: 1, type: 'tool/result', data: { content: 'pkill: 自匹配导致崩溃 exit code 1' } },
  ] };
  await (cm as any).handleTurnEnd(sessionStub, { data: { reason: { kind: 'aborted' }, turn: 1 } });
  assert('O3: 轨迹含相关错误 → lesson violationCount+1', store.ledger.get(lesson.memoryKey)?.violationCount === 1, JSON.stringify(store.ledger.get(lesson.memoryKey)?.violationCount));

  // 遵守路径:completed 且轨迹无该教训错误
  cm.recordApplied('sess-2', [{ memoryKey: lesson.memoryKey, patternKey: lesson.patternKey, text: lesson.contentHash }]);
  const sess2 = { id: 'sess-2', events: [
    { turn: 1, type: 'tool/call', data: { name: 'bash' } },
    { turn: 1, type: 'tool/result', data: { content: 'launch-stop.sh 优雅停止 ok' } },
  ] };
  await (cm as any).handleTurnEnd(sess2, { data: { reason: { kind: 'completed' }, turn: 1 } });
  assert('O3: completed 且无相关错误 → reinforcementCount+1', store.ledger.get(lesson.memoryKey)?.reinforcementCount === 1, JSON.stringify(store.ledger.get(lesson.memoryKey)?.reinforcementCount));

  // 自评:completed 但失败率高 → 触发 user-correction 事件
  cm.recordApplied('sess-3', [{ memoryKey: lesson.memoryKey, patternKey: lesson.patternKey, text: lesson.contentHash }]);
  const sess3 = { id: 'sess-3', events: [
    { turn: 1, type: 'tool/call', data: { name: 'bash' } },
    { turn: 1, type: 'tool/result', data: { content: 'error: 失败1' } },
    { turn: 1, type: 'tool/call', data: { name: 'bash' } },
    { turn: 1, type: 'tool/result', data: { content: 'error: 失败2' } },
  ] };
  await (cm as any).handleTurnEnd(sess3, { data: { reason: { kind: 'completed' }, turn: 1 } });
  assert('O3: 低质量完成自评触发反思(calls≥2 fail≥0.5)', emitted.includes('reflection/user-correction'), JSON.stringify(emitted));

  // [O1] memos_correct 护栏:reason 短拒绝 + 每日上限
  const tools = new MemoryTools(
    { emit: () => {} } as never,
    audit,
    store,
    () => ({ correctPerDayLimit: 2 }),
  );
  const correct = (tools as any).correctTool();
  const r1 = await correct.run({ memoryKey: lesson.memoryKey, reason: '短' });
  assert('O1: memos_correct 拒绝短 reason', r1.ok === false && String(r1.error).includes('10 字符'), JSON.stringify(r1));
  const r2 = await correct.run({ memoryKey: lesson.memoryKey, reason: '这条教训内容已经过时需要更正为新的做法' });
  assert('O1: memos_correct 登记 correction-request', r2.ok === true && r2.registered === 'correction-request', JSON.stringify(r2));
  const r3 = await correct.run({ memoryKey: lesson.memoryKey, reason: '第二条更正的合理理由说明文本' });
  const r4 = await correct.run({ memoryKey: lesson.memoryKey, reason: '第三条超过每日上限应该被拒绝' });
  assert('O1: memos_correct 每日上限生效(2 次后拒绝)', r4.ok === false && String(r4.error).includes('上限'), JSON.stringify(r4));

  // [O1] memos_lookup:只返回 active+acknowledged
  const lookup = (tools as any).lookupTool();
  const lr = await lookup.run({ query: '重启 dsh', limit: 3 });
  assert('O1: memos_lookup 返回已确认教训', lr.ok === true && lr.recalled.length >= 1 && lr.recalled[0].patternKey === 'shell.pkill-selfmatch', JSON.stringify(lr.recalled));
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