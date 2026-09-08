/**
 * 修正层(v5.0 redesign M1:单一写入闸门迁移)
 *
 * v3.2:refiner 内建 MemOSWriter + 配额 + 验证 + 教训查重,是"事实上的写入实现";
 * v5.0 M1:这些职责全部下沉到 WriteGate(core/write-gate.ts),refiner 只做两件事:
 *   1. 把反思结果转成 WriteCandidate(事实/教训)
 *   2. 交给 MemoryStore.submit(唯一写入口),汇总 ingested/failed
 *
 * 对外兼容:processReflectionResult 返回 { ingestedCount, failedCount } 不变,
 * /reflect /memos-stat 等命令无需改动;写入审计统一带 gate: write-gate 标记。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config';
import type { AuditLogger } from '../audit/logger';
import type { MemoryStore } from '../core/memory-store';
import type { ReflectionResult, ReflectionStats } from '../types/reflection';

export class RefinerModule {
  constructor(
    private ctx: Context,
    private config: () => Config,
    private audit: AuditLogger,
    private store: MemoryStore,
  ) {}

  /**
   * 处理一次反思结果:构造候选 → MemoryStore.submit(单一闸门)→ 汇总。
   * 评审(in_reflector.tripleCheck 三审)、脱敏、配额、验证、审计全部在 WriteGate 内完成。
   */
  async processReflectionResult(result: ReflectionResult): Promise<{ ingestedCount: number; failedCount: number }> {
    const cfg = this.config();
    if (!cfg.refiner.writeVerifiedFacts && !cfg.refiner.writeLessons) {
      return { ingestedCount: 0, failedCount: 0 };
    }

    let ingested = 0;
    let failed = 0;

    if (cfg.refiner.writeVerifiedFacts) {
      for (const fact of result.verifiedFacts) {
        const outcome = await this.store.submit({ kind: 'fact', fact, source: 'reflection' });
        if (outcome.accepted && outcome.ingested) ingested += 1;
        else failed += 1;
      }
    }

    if (cfg.refiner.writeLessons) {
      for (const lesson of result.lessons) {
        const outcome = await this.store.submit({ kind: 'lesson', lesson, source: 'reflection' });
        if (outcome.accepted && outcome.ingested) ingested += 1;
        else failed += 1;
      }
    }

    return { ingestedCount: ingested, failedCount: failed };
  }

  getStats(): ReflectionStats {
    return this.audit.statsToday();
  }

  getAuditLog(): string[] {
    return [];
  }
}