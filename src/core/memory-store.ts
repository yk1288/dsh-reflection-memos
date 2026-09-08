/**
 * MemoryStore 门面(v5.0 redesign 第 3.1 节 / G1)
 *
 * 一个记忆抽象:读(query)、写(submit,内部必走 WriteGate)、工作态(state)。
 * 后端装配只发生在 index.ts;新代码只依赖本门面,不再直接 new MemOSWriter。
 *
 * M0 阶段:门面已可独立组装(Writer + Ledger + 可选 WriteGate),
 * 但现有 refiner 写路径暂不切换(M1 迁移),因此 gate 缺省惰性创建。
 */
import type { MemOSWriter } from '../backends/memos-backend';
import { LedgerBackend } from '../backends/ledger-backend';
import { EvolutionLedger } from './ledger';
import { WriteGate, derivePatternKey } from './write-gate';
import type { WriteGateConfig, WriteCandidate } from './write-gate';
import type { EvolutionEntry, EvolutionFilter } from '../types/evolution';
import type { AuditLogger } from '../audit/logger';

export interface MemoryStoreDeps {
  /** M0:可为 null(账本/查询立即可用);M1 接入 WriteGate 时必填 */
  writer: MemOSWriter | null;
  audit: AuditLogger;
  ledgerDir?: string;
  gateConfig?: () => WriteGateConfig;
}

export class MemoryStore {
  readonly ledger: EvolutionLedger;
  private gate: WriteGate | null = null;

  constructor(private deps: MemoryStoreDeps) {
    const backend = new LedgerBackend({ dir: deps.ledgerDir });
    this.ledger = new EvolutionLedger(backend);
  }

  /** 写入候选(唯一写入口;M1 后 refiner 迁移到此) */
  submit(candidate: WriteCandidate): Promise<{ accepted: boolean; ingested: boolean; reason?: string; memoryKey?: string }> {
    if (!this.deps.gateConfig || !this.deps.writer) {
      return Promise.resolve({ accepted: false, ingested: false, reason: 'gate-not-enabled' });
    }
    return this.ensureGate().submit(candidate);
  }

  /** 只读查询:账本优先(MemOS search 由调用方按需叠加) */
  query(filter: EvolutionFilter): EvolutionEntry[] {
    return this.ledger.query(filter);
  }

  /** 按场景取 active 且已确认的教训(检索注入用,研究 GAP-3:只服务 active/acknowledged) */
  activeLessons(scenario: string, limit = 3): EvolutionEntry[] {
    const entries = this.ledger
      .query({ kind: 'lesson' })
      .filter((e) => e.status === 'active' && e.triage !== 'pending')
      .filter(
        (e) =>
          e.scenarios.includes(scenario) ||
          (e.patternKey && scenario.includes(e.patternKey.split('.')[1] ?? '')),
      )
      .sort(
        (a, b) =>
          b.importance * (b.failureCount + 1) - a.importance * (a.failureCount + 1),
      )
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

  private ensureGate(): WriteGate {
    if (!this.gate) {
      if (!this.deps.writer) throw new Error('WriteGate 需要 MemOSWriter(gate-not-enabled)');
      this.gate = new WriteGate({
        writer: this.deps.writer,
        ledger: this.ledger,
        audit: this.deps.audit,
        config: this.deps.gateConfig!,
      });
    }
    return this.gate;
  }
}