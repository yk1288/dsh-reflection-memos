/**
 * MemoryStore 门面(v5.0 redesign 第 3.1 节 / G1)
 *
 * 一个记忆抽象:读(query)、写(submit,内部必走 WriteGate)、工作态(state)。
 * 后端装配只发生在 index.ts;新代码只依赖本门面,不再直接 new MemOSWriter。
 *
 * M1:writer 改为惰性 writerProvider —— apiKey/凭据解析只在首次写入时执行
 * (apply() 是同步的,而 credentials.resolve 是异步,不能在装配期拿到 writer)。
 */
import type { MemOSWriter } from '../backends/memos-backend';
import { LedgerBackend } from '../backends/ledger-backend';
import { EvolutionLedger } from './ledger';
import { WriteGate, derivePatternKey } from './write-gate';
import type { WriteGateConfig, WriteCandidate } from './write-gate';
import type { EvolutionEntry, EvolutionFilter } from '../types/evolution';
import type { AuditLogger } from '../audit/logger';

export interface MemoryStoreDeps {
  /** 惰性 writer 工厂:首次写入时调用(M1);传 null = 只读/账本模式(M0) */
  writerProvider: (() => Promise<MemOSWriter>) | null;
  audit: AuditLogger;
  ledgerDir?: string;
  gateConfig?: () => WriteGateConfig;
}

export class MemoryStore {
  readonly ledger: EvolutionLedger;
  private gate: WriteGate | null = null;
  private gatePromise: Promise<WriteGate> | null = null;

  constructor(private deps: MemoryStoreDeps) {
    const backend = new LedgerBackend({ dir: deps.ledgerDir });
    this.ledger = new EvolutionLedger(backend);
  }

  /** 写入候选(唯一写入口;M1 起 refiner 经此提交) */
  submit(candidate: WriteCandidate): Promise<{ accepted: boolean; ingested: boolean; reason?: string; memoryKey?: string }> {
    if (!this.deps.gateConfig || !this.deps.writerProvider) {
      return Promise.resolve({ accepted: false, ingested: false, reason: 'gate-not-enabled' });
    }
    return this.ensureGate().then((gate) => gate.submit(candidate));
  }

  /** 只读查询:账本优先(MemOS search 由调用方按需叠加) */
  query(filter: EvolutionFilter): EvolutionEntry[] {
    return this.ledger.query(filter);
  }

  /**
   * 按意图取 active 且已确认的教训(检索注入用,研究 GAP-3:只服务 active/acknowledged)。
   * 匹配宽松策略:task intent 命中任一存储 scenario 标签,或命中 lesson 正文(乱序关键词),
   * 或命中 patternKey 的 symptom 段 —— 中文任务意图与半结构化 scenario 标签难以精确对应,
   * 故按"任一证据命中即相关"召回,宁多勿漏由 limit 收敛。
   */
  activeLessons(intent: string, limit = 3): EvolutionEntry[] {
    const needle = intent.trim().toLowerCase();
    const entries = this.ledger
      .query({ kind: 'lesson' })
      .filter((e) => e.status === 'active' && e.triage !== 'pending')
      .map((e) => {
        // 相关分:真正命中存储字段的越靠前
        let score = 0;
        const haystacks: string[] = [...(e.scenarios ?? []), (e.patternKey ?? ''), e.category ?? ''];
        if ((e.contentHash ?? '').toLowerCase().includes(needle)) score += 2;
        if (haystacks.some((h) => h && h.toLowerCase().includes(needle))) score += 1;
        // 若 needle 非单字,还按 patternKey symptom 子串做软命中(score 0.5)
        if (needle.length > 1 && e.patternKey) {
          const symptom = (e.patternKey.split('.')[1] ?? '').toLowerCase();
          if (symptom && (symptom.includes(needle) || needle.includes(symptom) || symptom.length >= 2 && needle.includes(symptom.slice(0, 2)))) score += 0.5;
        }
        return { entry: e, score };
      })
      .filter((x) => x.score > 0)
      .sort(
        (a, b) =>
          b.score +
            b.entry.importance * (b.entry.failureCount + 1) -
          (a.score + a.entry.importance * (a.entry.failureCount + 1)),
      )
      .map((x) => x.entry)
      .slice(0, limit);
    return entries;
  }

  /** 命中登记(排序/衰减依据) */
  touch(memoryKey: string): void {
    this.ledger.touch(memoryKey);
  }

  /** 统计 */
  stats(): { total: number; active: number; pending: number; lessons: number; facts: number } {
    const all = this.ledger.all();
    return {
      total: all.length,
      active: all.filter((e) => e.status === 'active').length,
      pending: all.filter((e) => e.triage === 'pending').length,
      lessons: all.filter((e) => e.kind === 'lesson').length,
      facts: all.filter((e) => e.kind === 'fact').length,
    };
  }

  /** patternKey 推导工具(暴露给观察/演化层复用) */
  static derivePatternKey(scenario: string): string {
    return derivePatternKey(scenario);
  }

  private ensureGate(): Promise<WriteGate> {
    if (this.gate) return Promise.resolve(this.gate);
    if (this.gatePromise) return this.gatePromise;
    this.gatePromise = (async () => {
      if (!this.deps.writerProvider) throw new Error('WriteGate 需要 writerProvider(gate-not-enabled)');
      const writer = await this.deps.writerProvider();
      const gate = new WriteGate({
        writer,
        ledger: this.ledger,
        audit: this.deps.audit,
        config: this.deps.gateConfig!,
      });
      this.gate = gate;
      return gate;
    })();
    return this.gatePromise;
  }
}