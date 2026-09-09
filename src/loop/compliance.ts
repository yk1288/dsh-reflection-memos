/**
 * 遵守验证 + 自评触发(v5.0 redesign:loop/compliance.ts;O3)
 *
 * 让"不重复犯错"可度量、让"低质量完成"被复盘:
 *
 * A. compliance 遵守验证:
 *    - Applier 在 pre-step 注入时,把"本轮注入的教训 memoryKeys"记录到 session
 *      上下文(appliedLessonsBySession),并保留注入文本;
 *    - turn/end 时,对照该轮轨迹:
 *        · 轨迹中出现"与教训 contentHash 相关的错误迹象"(关键词/命令失败)
 *          → 判 violated(violationCount+1,审计 lesson-violated)
 *        · 工具调用全部成功且完成 → 判 compliant(reinforcementCount+1,审计 lesson-complied)
 *        · 无工具调用/纯问答 → 判 not-applicable(不写计数)
 *    - 轻量启发式(无子代理调用):从教训文本提取 2-4 字名词/动词作关键词,
 *      与 turn 的 tool/result 错误摘要做包含匹配。可配置关闭。
 *
 * B. self-eval 自评触发:
 *    - turn/end completed 且该轮有 ≥3 次工具调用时,若其中失败/重试占比高
 *      (失败率 ≥ 0.5)→ 视为"看似完成但质量差",emit reflection/user-correction
 *      意图的深度反思(signal 给现有自动反思链)。
 *
 * 说明:O3 文档原设计用"子代理自评",真实环境子代理稳定性有限(曾现
 * no subagent provider),本实现先落地"启发式信号",子代理精评作为可选开关。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AuditLogger } from '../audit/logger';
import type { MemoryStore } from '../core/memory-store';
import { redactText } from '../core/redact';

export interface AppliedLessonRecord {
  memoryKey: string;
  patternKey?: string;
  text: string; // 注入文本(脱敏后)
}

export interface ComplianceConfig {
  enableCompliance: boolean;      // turn/end 验证
  enableSelfEval: boolean;        // completed 低质量自评触发
  selfEvalToolCallMin: number;    // 触发自评的最小工具调用数
  selfEvalFailRatio: number;      // 失败率阈值(≥ 判低质量)
  keywordChars: number;           // 提取关键词最小长度
  violateOnCompleted: boolean;    // completed 也纳入违规考量(命中教训错误关键词记违反)
}

/** 从教训文本提取轻量错误关键词(中文短语优先,英文词次之) */
export function extractKeywords(text: string, minLen = 2, max = 16): string[] {
  const t = text ?? '';
  const zhWords = new Set<string>();
  const enWords = new Set<string>();
  // 英文/数字词(领域性强,优先保留)
  for (const m of t.match(/[a-zA-Z0-9_-]{3,}/g) ?? []) {
    enWords.add(m.toLowerCase());
  }
  // 中文:2-4 字滑动片段,排除停用词
  const zh = t.replace(/[^一-鿿]/g, ' ');
  for (const seg of zh.split(/\s+/).filter((s) => s.length >= 2)) {
    const maxLen = Math.min(4, seg.length);
    for (let len = minLen; len <= maxLen; len++) {
      for (let i = 0; i + len <= seg.length; i++) {
        const frag = seg.slice(i, i + len);
        if (!/^(不要|应当|必须|避免|应该|需要|因为|所以|以及|并且|或者|如果|然后|最后|这个|那个|一个)$/.test(frag)) {
          zhWords.add(frag);
        }
      }
    }
  }
  // 英文优先(领域词),再补中文片段;总名额 max
  return [...enWords, ...zhWords].slice(0, max);
}

export class ComplianceModule {
  /** sessionId → 该轮注入的教训记录 */
  private appliedBySession = new Map<string, AppliedLessonRecord[]>();

  constructor(
    private ctx: Context,
    private audit: AuditLogger,
    private store: MemoryStore,
    private config: () => ComplianceConfig,
  ) {
    const anyCtx = this.ctx as any;
    // ⚠️ 修复(实测):DSH 明细事件流是 session/event(内含 turn/end 子事件),
    // 不是顶层 turn/end 事件 —— 此前订阅错事件名导致 handleTurnEnd 从未触发
    anyCtx.on('session/event', (session: any, event: any) => {
      if (!event || event.type !== 'turn/end') return;
      try {
        void this.handleTurnEnd(session, event);
      } catch (e) {
        this.audit.debug('compliance', `turn/end 处理失败: ${String(e)}`);
      }
    });
  }

  /** Applier 注入后登记(supplier 从 applier 调用) */
  recordApplied(sessionId: string, lessons: AppliedLessonRecord[]): void {
    if (!lessons.length) return;
    this.appliedBySession.set(sessionId, lessons);
  }

  private async handleTurnEnd(session: any, event: any): Promise<void> {
    const cfg = this.config();
    const sessionId = session?.id ?? '';
    const applied = this.appliedBySession.get(sessionId);
    // 会话已结束(turn/end)后再清空,避免陈旧记录跨轮复用
    this.appliedBySession.delete(sessionId);
    if (!applied || applied.length === 0) {
      // 诊断:无注入记录(可能 pre-step 未登记或 session id 不一致)
      this.audit.debug('compliance', `turn/end(session ${sessionId.slice(0, 8)}) 无注入记录,skip`);
      return;
    }

    const reasonKind = event?.data?.reason?.kind;
    const completed = reasonKind === 'completed';
    this.audit.debug('compliance', `turn/end(session ${sessionId.slice(0, 8)}) reason=${reasonKind} applied=${applied.length} enable=${cfg.enableCompliance}`);

    if (cfg.enableCompliance) {
      // 收集本轮轨迹文本(失败/错误迹象)
      const trajectory = this.collectTurnTraces(session, event);
      const failedRatio = this.failRatio(trajectory);

      for (const rec of applied) {
        const entry = this.store.ledger.get(rec.memoryKey);
        if (!entry || entry.kind !== 'lesson') continue;
        // 关键词:教训正文 + patternKey 分词(补召回键,提升命中稳定性)
        const kws = [
          ...extractKeywords(rec.text, cfg.keywordChars),
          ...extractKeywords(rec.patternKey ?? '', cfg.keywordChars),
        ].slice(0, 20);
        // O3 判定(2026-09-09 强化):completed 也纳入违规考量(带病完成)。
        // - violated:轨迹命中与教训相关的错误关键词 → 无论 completed/aborted 都记违反
        //   (用户指令「把 completed 也纳入违规考量」;cfg.violateOnCompleted 可关回保守语义)
        // - 任务非完成且失败率超高 → 也记违反
        const hitsErrorTrace = this.trajectoryHitsKeywords(trajectory, kws);
        const violated = hitsErrorTrace && (cfg.violateOnCompleted || !completed)
          || (!completed && failedRatio >= cfg.selfEvalFailRatio);
        if (violated) {
          entry.violationCount += 1;
          entry.hitCount += 1;
          entry.lastSeen = new Date().toISOString();
          this.store.ledger.upsert(entry);
          this.audit.debug('compliance', `violated ${rec.patternKey ?? rec.memoryKey.slice(0, 8)} (session ${sessionId.slice(0, 8)})`);
          this.emitLessonEvent('lesson/violated', rec, entry.violationCount);
        } else if (completed) {
          // 完成且无教训相关错误痕迹 → 计遵守
          entry.reinforcementCount += 1;
          entry.hitCount += 1;
          entry.lastSeen = new Date().toISOString();
          this.store.ledger.upsert(entry);
          this.audit.debug('compliance', `complied ${rec.patternKey ?? rec.memoryKey.slice(0, 8)} (session ${sessionId.slice(0, 8)})`);
          this.emitLessonEvent('lesson/complied', rec, entry.reinforcementCount);
        }
      }
    }

    // B. self-eval:completed 但工具失败率高的轮子 → 触发深度反思信号
    if (cfg.enableSelfEval && completed) {
      const traces = this.collectTurnTraces(session, event);
      const ratio = this.failRatio(traces);
      const callCount = this.toolCallCount(traces);
      if (callCount >= cfg.selfEvalToolCallMin && ratio >= cfg.selfEvalFailRatio) {
        this.audit.debug('compliance', `self-eval 低质量完成(calls=${callCount} failRatio=${ratio.toFixed(2)}),触发反思`);
        (this.ctx as any).emit('reflection/user-correction', {
          message: `(self-eval) 本任务工具失败率 ${Math.round(ratio * 100)}%,请深度反思质量`,
          sessionId,
        });
      }
    }
  }

  /** 收集 session 本轮(从 last turn 开始)的 tool/call 与 tool/result 摘要 */
  private collectTurnTraces(session: any, turnEndEvent: any): string[] {
    const lines: string[] = [];
    try {
      const events: any[] = session?.events ?? [];
      // 只取当前 turn 的事件(turnEndEvent.turn 之前不跨轮)
      const turn = turnEndEvent?.data?.turn ?? 0;
      for (const ev of events) {
        if (typeof ev?.turn === 'number' && ev.turn !== turn) continue;
        if (ev.type === 'tool/result') {
          const text = JSON.stringify(ev.data ?? {}).slice(0, 2000);
          lines.push(text);
        } else if (ev.type === 'tool/call') {
          lines.push(JSON.stringify(ev.data ?? {}).slice(0, 500));
        } else if (ev.type === 'assistant/message') {
          const txt = JSON.stringify(ev.data ?? {}).slice(0, 1000);
          lines.push(txt);
        }
      }
    } catch {
      // 无法读取 session 事件时宽容
    }
    return lines;
  }

  private failRatio(traces: string[]): number {
    const calls = this.toolCallCount(traces);
    if (calls === 0) return 0;
    const fail = traces.filter((t) => /error|failed|failure|exception|nonzero|exit code [1-9]|报错|失败|错误/i.test(t)).length;
    return fail / calls;
  }

  private toolCallCount(traces: string[]): number {
    // tool/call 与 tool/result 都计一次(去重按摘要前缀)
    return traces.filter((t) => t.includes('"type":"tool/') || t.startsWith('{"')).length;
  }

  private trajectoryHitsKeywords(traces: string[], kws: string[]): boolean {
    if (kws.length === 0) return false;
    const lines = traces.map((t) => t.toLowerCase());
    // 防误报:违规判定要求"教训关键词命中 且 该行含错误迹象"。
    // 若成功轨迹只是提到教训里的工具名(如 launch-stop.sh)但无错误,不判违反
    // (错误迹象:报错词 / 非零退出 / 失败 / 未找到 / 拒绝等)
    const mustHaveError = /error|failed|failure|exception|nonzero|exit code [1-9]|报错|失败|错误|not found|404|无权限|拒绝|corrupt|invalid/i;
    return kws.some((kw) => {
      if (!kw) return false;
      return lines.some((line) => (kw.length >= 3 ? line.includes(kw) : line.includes(kw)) && mustHaveError.test(line));
    });
  }

  private emitLessonEvent(eventName: string, rec: AppliedLessonRecord, count: number): void {
    (this.ctx as any).emit(eventName, {
      memoryKey: rec.memoryKey,
      patternKey: rec.patternKey,
      count,
    });
  }

  /** 汇总注入教训(供 /lesson-check) */
  stats(): { appliedTotal: number; byPattern: Record<string, number> } {
    let appliedTotal = 0;
    const byPattern: Record<string, number> = {};
    for (const recs of this.appliedBySession.values()) {
      for (const r of recs) {
        appliedTotal += 1;
        byPattern[r.patternKey ?? r.memoryKey.slice(0, 8)] = (byPattern[r.patternKey ?? r.memoryKey.slice(0, 8)] ?? 0) + 1;
      }
    }
    return { appliedTotal, byPattern };
  }
}

/** 辅助:Applier 注入后把记录给 compliance(会话 id 从 decision/session 提取) */
export function asAppliedRecord(memoryKey: string, patternKey: string | undefined, text: string): AppliedLessonRecord {
  return { memoryKey, patternKey, text: redactText(text) };
}