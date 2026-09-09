/**
 * 单一写入闸门(v5.0 redesign 第 3.2 节;研究 GAP-1/2/3 落地)
 *
 * 所有写入 MemOS 的必经通道,四审 + 脱敏 + 配额 + 验证 + 审计一次实现:
 * - 零审:脱敏(MemOS 云端存储,提交前替换敏感形态,审计同样脱敏)
 * - 一审:证据必选(evidence ≥ 20 字符,缺失即拒)
 * - 二审:置信度(fact ≥ 0.8 / lesson ≥ 0.7)
 * - 三审:查重与版本(patternKey 查重 → 命中折叠递增;否则新建)
 * - 配额:maxMemoriesPerDay(反思/演化/工具共享)
 * - 落地:memos add → 轮询 search 验证 → 账本更新 → 审计
 * - 分流:自动链路产物先 triage=pending,确认后才被召回注入
 *
 * M0 阶段:本闸门独立于现有 refiner(后者沿用 v3.2 路径,行为零变化),
 * M1 再把 refiner 的写路径迁移到本闸门。
 */
import type { Lesson, VerifiedFact } from '../types/reflection';
import type { EvolutionLedger } from './ledger';
import { contentKey as contentKeyOf } from './ledger';
import type { MemOSWriter } from '../backends/memos-backend';
import type { AuditLogger } from '../audit/logger';
import { redactText, sanitizeValue } from './redact';

export interface WriteGateConfig {
  /** 证据最少字符数,默认 20 */
  evidenceMinChars: number;
  /** fact 最低置信度,默认 0.8 */
  minConfidenceForFact: number;
  /** lesson 最低置信度,默认 0.7 */
  minConfidenceForLesson: number;
  /** 每日最大写入数(与反思/演化/工具共享配额),默认 50 */
  maxMemoriesPerDay: number;
  /** 教训最少失败次数才写(无 patternKey 命中时),默认 2 */
  minFailuresForLesson: number;
  /** 写入后是否轮询验证入库,默认 true */
  verifyIngestion: boolean;
  /** 提交前脱敏,默认 true(v5.0 默认开;迁移期可通过配置关) */
  redactEnabled: boolean;
  /** 失败最低 relativity,默认 0.6 */
  minVerifyRelativity: number;
  maxVerifyRetries: number;
  verifyInitialDelayMs: number;
  verifyBackoffFactor: number;
  searchTimeoutMs: number;
}

export interface WriteCandidate {
  kind: 'fact' | 'lesson';
  fact?: VerifiedFact;
  lesson?: Lesson;
  /** 可选:显式 patternKey(缺失时由 lesson.scenario 推导) */
  patternKey?: string;
  /** 来源自动链路(错误扫描/教训升级)→ triage=pending;手动反思 → triage=active? 不,统一 pending,由确认机制决定 */
  source: 'reflection' | 'evolution' | 'tool' | 'sweep';
}

export interface WriteOutcome {
  accepted: boolean;
  ingested: boolean;
  reason?: 'rejected' | 'quota' | 'duplicate-fold' | 'verify-failed' | 'ok';
  memoryKey?: string;
  patternKey?: string;
  failureCount?: number;
}

/** patternKey 推导:场景归一为 area.symptom 形态(研究 GAP-2) */
export function derivePatternKey(scenario: string): string {
  const s = (scenario ?? '').trim();
  if (!s) return 'general.unknown';
  // 去掉句号/标点 → 短横线,压成两级:取前两个词作为 area.symptom
  const words = s.toLowerCase().replace(/[，。！？、,.!?]/g, ' ').split(/\s+/).filter(Boolean);
  const area = words[0] ?? 'general';
  const symptom = words[1] ?? area;
  return `${area}.${symptom}`.slice(0, 60);
}

export class WriteGate {
  private writtenToday = 0;
  private today = '';

  constructor(
    private deps: {
      writer: MemOSWriter;
      ledger: EvolutionLedger;
      audit: AuditLogger;
      config: () => WriteGateConfig;
    },
  ) {}

  /** 提交一个写入候选;返回是否被接受、是否验证入库 */
  async submit(candidate: WriteCandidate): Promise<WriteOutcome> {
    const cfg = this.deps.config();
    // 配额策略:仅当候选会有 MemOS 写入时(提交新 fact/lesson 或折叠提交)才扣,
    // 被证据/置信度/minFailures 拒收的候选不消耗当日额度。
    if (candidate.kind === 'lesson') return this.submitLesson(candidate, cfg);
    return this.submitFact(candidate, cfg);
  }

  /** MemOS 写入前的配额检查;不足则审计并判定 */
  private quotaOrFail(candidate: WriteCandidate): boolean {
    const cfg = this.deps.config();
    if (!this.bumpQuota(cfg.maxMemoriesPerDay)) {
      this.audit('quota', candidate, undefined, false, 'daily quota exceeded');
      return false;
    }
    return true;
  }

  private async submitFact(candidate: WriteCandidate, cfg: WriteGateConfig): Promise<WriteOutcome> {
    const fact = candidate.fact!;

    // 一审:证据必选
    if ((fact.evidence ?? '').trim().length < cfg.evidenceMinChars) {
      this.audit('reject-evidence', candidate, undefined, false, 'evidence too short');
      return { accepted: false, ingested: false, reason: 'rejected' };
    }
    // 二审:置信度
    if (fact.confidence < cfg.minConfidenceForFact) {
      this.audit('reject-confidence', candidate, undefined, false, `confidence ${fact.confidence} < ${cfg.minConfidenceForFact}`);
      return { accepted: false, ingested: false, reason: 'rejected' };
    }

    const patternKey = candidate.patternKey ?? derivePatternKey(fact.fact);
    // 修复(真实环境):同 contentKey 已在账本中时保留其确认状态,避免覆盖重置 pending
    const existing = this.deps.ledger.get(contentKeyOf(fact.fact));
    const entry = this.deps.ledger.createEntry({
      content: fact.fact,
      kind: 'fact',
      patternKey,
      confidence: fact.confidence,
      importance: 0.7,
      category: fact.category,
      scenarios: fact.tags ?? [],
      triage: existing ? existing.triage : 'pending',
      note: `source=${candidate.source}${existing ? ' (re-entry)' : ''}`,
    });
    if (existing) {
      entry.status = existing.status;
      entry.hitCount = existing.hitCount;
    }

    // 配额:提交新 fact 前检查(被拒只不入库,不预写账本避免残留 pending)
    if (!this.quotaOrFail(candidate)) {
      return { accepted: false, ingested: false, reason: 'quota' };
    }

    const { submitted, taskId } = await this.safeSubmit(
      () => this.deps.writer.submitVerifiedFact(this.maybeRedactFact(fact, cfg)),
      candidate,
    );
    if (!submitted) {
      return { accepted: false, ingested: false, reason: 'rejected' };
    }

    const ingested = cfg.verifyIngestion
      ? await this.deps.writer.verifyIngestion(fact.fact, {
          maxRetries: cfg.maxVerifyRetries,
          initialDelayMs: cfg.verifyInitialDelayMs,
          backoffFactor: cfg.verifyBackoffFactor,
          minRelativity: cfg.minVerifyRelativity,
          searchTimeoutMs: cfg.searchTimeoutMs,
        })
      : true;

    this.audit('fact', candidate, taskId, ingested, ingested ? undefined : 'verify-failed');
    entry.hitCount += 1;
    this.deps.ledger.upsert(entry);
    return {
      accepted: true,
      ingested,
      reason: ingested ? 'ok' : 'verify-failed',
      memoryKey: entry.memoryKey,
      patternKey,
    };
  }

  private async submitLesson(candidate: WriteCandidate, cfg: WriteGateConfig): Promise<WriteOutcome> {
    const lesson = candidate.lesson!;

    // 一审:证据必选
    if ((lesson.evidence ?? '').trim().length < cfg.evidenceMinChars) {
      this.audit('reject-evidence', candidate, undefined, false, 'evidence too short');
      return { accepted: false, ingested: false, reason: 'rejected' };
    }
    // 二审:置信度
    if (lesson.confidence < cfg.minConfidenceForLesson) {
      this.audit('reject-confidence', candidate, undefined, false, `confidence ${lesson.confidence} < ${cfg.minConfidenceForLesson}`);
      return { accepted: false, ingested: false, reason: 'rejected' };
    }

    const patternKey = candidate.patternKey ?? derivePatternKey(lesson.scenario);

    // 三审:patternKey 查重 → 命中折叠递增,不新建(研究 GAP-2)
    const folded = this.deps.ledger.foldRecurrence(patternKey, 'lesson');
    if (folded) {
      folded.failureCount = Math.max(folded.failureCount, lesson.failureCount + 1);
      folded.confidence = Math.max(folded.confidence, lesson.confidence);
      this.deps.ledger.upsert(folded);
      this.audit('lesson-fold', candidate, undefined, false, `folded into ${folded.memoryKey.slice(0, 12)}`);
      // 折叠也提交新版教训到 MemOS(MemOS 无 update,只能新增 v+1;保留原语义)
      // 配额:折叠提交同样扣一次当日额度
      if (!this.quotaOrFail(candidate)) {
        return { accepted: false, ingested: false, reason: 'quota' };
      }
      const res = await this.safeSubmit(
        () => this.deps.writer.submitLesson(this.maybeRedactLesson({ ...lesson, failureCount: folded.failureCount }, cfg)),
        candidate,
      );
      const ingested = cfg.verifyIngestion && res.submitted
        ? await this.deps.writer.verifyIngestion(lesson.correctApproach, {
            maxRetries: cfg.maxVerifyRetries,
            initialDelayMs: cfg.verifyInitialDelayMs,
            backoffFactor: cfg.verifyBackoffFactor,
            minRelativity: cfg.minVerifyRelativity,
            searchTimeoutMs: cfg.searchTimeoutMs,
          })
        : res.submitted;
      this.audit('lesson', candidate, res.taskId, ingested, ingested ? undefined : 'verify-failed');
      return {
        accepted: res.submitted,
        ingested,
        reason: 'duplicate-fold',
        memoryKey: folded.memoryKey,
        patternKey,
        failureCount: folded.failureCount,
      };
    }

    // 未命中:失败次数未达标不写
    if (lesson.failureCount < cfg.minFailuresForLesson) {
      this.audit('reject-min-failures', candidate, undefined, false,
        `failureCount ${lesson.failureCount} < ${cfg.minFailuresForLesson}`);
      return { accepted: false, ingested: false, reason: 'rejected' };
    }

    // ⚠️ 修复(真实环境):同 contentKey 已在账本中时,upsert 覆盖会重置 triage/status。
    // 先查已有条目,保留其确认状态(triage/status/hitCount),避免把用户已确认的教训打回 pending。
    const existing = this.deps.ledger.get(contentKeyOf(lesson.correctApproach));
    const entry = this.deps.ledger.createEntry({
      content: lesson.correctApproach,
      kind: 'lesson',
      patternKey,
      confidence: lesson.confidence,
      failureCount: lesson.failureCount,
      importance: lesson.severity === 'high' ? 0.9 : lesson.severity === 'medium' ? 0.7 : 0.5,
      // 检索场景:explicitable 的适用场景标签 + 教训本身的中文 scenario 文本(供任务意图匹配)
      scenarios: [...new Set([...(lesson.applicableScenarios ?? []), lesson.scenario].filter(Boolean))],
      // 已确认过的教训不被重置回 pending(研究 GAP-3:确认状态一旦产生应保持)
      triage: existing ? existing.triage : 'pending',
      note: `source=${candidate.source}${existing ? ' (re-entry)' : ''}`,
    });
    if (existing) {
      entry.status = existing.status;
      entry.hitCount = existing.hitCount;
    }

    // 配额:提交新 lesson 前检查(成功后才落账本,被拒不残留)
    if (!this.quotaOrFail(candidate)) {
      return { accepted: false, ingested: false, reason: 'quota' };
    }

    const res = await this.safeSubmit(
      () => this.deps.writer.submitLesson(this.maybeRedactLesson(lesson, cfg)),
      candidate,
    );
    if (!res.submitted) {
      return { accepted: false, ingested: false, reason: 'rejected' };
    }

    const ingested = cfg.verifyIngestion
      ? await this.deps.writer.verifyIngestion(lesson.correctApproach, {
          maxRetries: cfg.maxVerifyRetries,
          initialDelayMs: cfg.verifyInitialDelayMs,
          backoffFactor: cfg.verifyBackoffFactor,
          minRelativity: cfg.minVerifyRelativity,
          searchTimeoutMs: cfg.searchTimeoutMs,
        })
      : true;
    this.deps.ledger.upsert(entry);
    this.audit('lesson', candidate, res.taskId, ingested, ingested ? undefined : 'verify-failed');
    entry.hitCount += 1;
    this.deps.ledger.upsert(entry);
    return {
      accepted: true,
      ingested,
      reason: ingested ? 'ok' : 'verify-failed',
      memoryKey: entry.memoryKey,
      patternKey,
      failureCount: entry.failureCount,
    };
  }

  // ---------- 私有 ----------

  private maybeRedactFact(fact: VerifiedFact, cfg: WriteGateConfig): VerifiedFact {
    if (!cfg.redactEnabled) return fact;
    return {
      ...fact,
      fact: redactText(fact.fact),
      verificationMethod: redactText(fact.verificationMethod),
      evidence: redactText(fact.evidence),
      tags: fact.tags?.map((t) => redactText(t)),
    };
  }

  private maybeRedactLesson(lesson: Lesson, cfg: WriteGateConfig): Lesson {
    if (!cfg.redactEnabled) return lesson;
    return {
      ...lesson,
      scenario: redactText(lesson.scenario),
      mistake: redactText(lesson.mistake),
      correctApproach: redactText(lesson.correctApproach),
      evidence: redactText(lesson.evidence),
      applicableScenarios: lesson.applicableScenarios?.map((s) => redactText(s)),
    };
  }

  /** 提交失败不抛到上层:返回 submitted=false 并审计 */
  private async safeSubmit(
    fn: () => Promise<{ taskId?: string; success: boolean }>,
    candidate: WriteCandidate,
  ): Promise<{ submitted: boolean; taskId?: string }> {
    try {
      const res = await fn();
      return { submitted: res.success, taskId: res.taskId };
    } catch (error) {
      this.audit('submit-error', candidate, undefined, false, String(error));
      return { submitted: false };
    }
  }

  private audit(
    kind: string,
    candidate: WriteCandidate,
    taskId: string | undefined,
    ingested: boolean,
    error?: string,
  ): void {
    const content =
      candidate.kind === 'fact'
        ? candidate.fact?.fact ?? ''
        : candidate.lesson?.correctApproach ?? candidate.lesson?.scenario ?? '';
    // patternKey 未显式传入时,从内容推导(保证审计可追溯,研究 GAP-2)
    const patternKey =
      candidate.patternKey ??
      (candidate.kind === 'lesson'
        ? derivePatternKey(candidate.lesson?.scenario ?? '')
        : derivePatternKey(candidate.fact?.fact ?? ''));
    this.deps.audit.record({
      type: candidate.kind,
      content: sanitizeValue(content) as string,
      submitted: ingested,
      ingested,
      taskId,
      error,
      at: new Date().toISOString(),
      // 附加 gate 标记与 patternKey,便于统计(研究 GAP-2 可追溯)
      patternKey,
      gate: 'write-gate',
    } as never); // 扩展字段经 as never 兼容现有 MemoryWriteResult
  }

  /** 每日配额(本地计数,按日期重置;与 refiner 的 bumpQuota 同语义) */
  private bumpQuota(maxPerDay: number): boolean {
    const now = new Date().toISOString().slice(0, 10);
    if (now !== this.today) {
      this.today = now;
      this.writtenToday = 0;
    }
    if (this.writtenToday >= maxPerDay) return false;
    this.writtenToday += 1;
    return true;
  }
}