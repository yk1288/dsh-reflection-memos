/**
 * 账本核心(v5.0 redesign:core/ledger.ts)
 *
 * 负责 EvolutionEntry 的构造、状态机、版本链约束:
 * - 状态机:new → active ↔ (superseded/merged/decayed → archived)
 * - 防循环:supersedes 有向图禁止 A→B→A
 * - 版本链上限:同一 patternKey/scenario 超过 maxVersionChain 强制走合并
 * - 指纹主键:sha256(content 前 80 字符)
 */
import { createHash } from 'node:crypto';
import type { EvolutionEntry, EvolutionFilter } from '../types/evolution';
import type { MemoryKind, TriageStatus } from '../types/memory';
import type { LedgerBackend } from '../backends/ledger-backend';

export interface EntrySeed {
  content: string;
  kind: MemoryKind;
  version?: number;
  supersedes?: string[];
  confidence?: number;
  failureCount?: number;
  reinforcementCount?: number;
  violationCount?: number;
  patternKey?: string;
  importance?: number;
  category?: string;
  scenarios?: string[];
  triage?: TriageStatus;
  note?: string;
}

/** 版本链上限:超过后强制合并(设计第 3.3 节规则 2) */
export const DEFAULT_MAX_VERSION_CHAIN = 5;

/** 内容指纹(sh256 前 16 位 hex 已足够碰撞免疫,便于肉眼核对) */
export function contentKey(content: string): string {
  return createHash('sha256').update(content.slice(0, 80)).digest('hex').slice(0, 16);
}

export class EvolutionLedger {
  constructor(
    private backend: LedgerBackend,
    private maxVersionChain: number = DEFAULT_MAX_VERSION_CHAIN,
  ) {}

  // ---------- 构造 ----------

  /** 由反思/演化候选生成账本条目(写入前统一经此构造,保证字段完整) */
  createEntry(seed: EntrySeed): EvolutionEntry {
    const now = new Date().toISOString();
    return {
      memoryKey: contentKey(seed.content),
      kind: seed.kind,
      status: 'active',
      triage: seed.triage ?? 'pending', // 自动链路默认 pending(研究 GAP-3)
      version: seed.version ?? 1,
      supersedes: seed.supersedes ?? [],
      confidence: seed.confidence ?? 0.8,
      failureCount: seed.failureCount ?? 0,
      reinforcementCount: seed.reinforcementCount ?? 0,
      violationCount: seed.violationCount ?? 0,
      hitCount: 0,
      patternKey: seed.patternKey,
      importance: seed.importance ?? 0.5,
      firstSeen: now,
      lastSeen: now,
      category: seed.category,
      scenarios: seed.scenarios ?? [],
      contentHash: seed.content,
      note: seed.note,
    };
  }

  // ---------- 状态机 ----------

  /** 状态迁移;非法迁移抛错(防 A→B→A 循环由 supersede 检查保证) */
  transition(memoryKey: string, target: EvolutionEntry['status']): boolean {
    const entry = this.backend.get(memoryKey);
    if (!entry) return false;
    const allowed: Record<EvolutionEntry['status'], EvolutionEntry['status'][]> = {
      active: ['superseded', 'merged', 'decayed', 'archived'],
      superseded: [], // 终态(除非 revive)
      merged: [],
      decayed: ['active', 'archived'], // revive 或归档
      archived: [],
    };
    if (!allowed[entry.status].includes(target)) {
      throw new Error(
        `非法状态迁移: ${entry.status} → ${target} (memoryKey=${memoryKey.slice(0, 12)}…)`,
      );
    }
    entry.status = target;
    this.backend.upsert(entry);
    return true;
  }

  /** 确认分流:pending → acknowledged(人工 /evolve --confirm 或高频命中) */
  acknowledge(memoryKey: string): boolean {
    const entry = this.backend.get(memoryKey);
    if (!entry) return false;
    if (entry.triage === 'pending') {
      entry.triage = 'acknowledged';
      this.backend.upsert(entry);
      return true;
    }
    return false;
  }

  // ---------- 版本与复发 ----------

  /**
   * 教训复发折叠(研究 GAP-2 的落地):
   * 按 patternKey 找到已有 active 条目 → 折叠(failureCount+1、lastSeen 更新),不新建。
   * 返回折叠对象;无命中返回 null(调用方决定新建)。
   */
  foldRecurrence(patternKey: string, kind: MemoryKind): EvolutionEntry | null {
    const candidates = this.backend.query({ patternKey, kind });
    if (candidates.length === 0) return null;
    const hit = candidates.sort((a, b) => b.version - a.version)[0];
    hit.failureCount += 1;
    hit.hitCount += 1;
    hit.lastSeen = new Date().toISOString();
    this.backend.upsert(hit);
    return hit;
  }

  /** 同 patternKey 的版本计数;达到上限返回 true(演化层应强制合并) */
  exceedsVersionChain(patternKey: string, kind: MemoryKind): boolean {
    const versions = this.backend.query({ patternKey, kind }).length;
    return versions >= this.maxVersionChain;
  }

  /** 命中登记(hitCount + lastSeen;检索注入时调用,供衰减/排序使用) */
  touch(memoryKey: string): void {
    const entry = this.backend.get(memoryKey);
    if (!entry) return;
    entry.hitCount += 1;
    entry.lastSeen = new Date().toISOString();
    this.backend.upsert(entry);
  }

  // ---------- 查询 ----------

  query(filter: EvolutionFilter): EvolutionEntry[] {
    return this.backend.query(filter);
  }

  /** 写入/更新(委托后端原子写) */
  upsert(entry: EvolutionEntry): void {
    this.backend.upsert(entry);
  }

  /** 批量写入(演化作业产物) */
  upsertMany(entries: EvolutionEntry[]): void {
    this.backend.upsertMany(entries);
  }

  get(memoryKey: string): EvolutionEntry | undefined {
    return this.backend.get(memoryKey);
  }

  all(): EvolutionEntry[] {
    return this.backend.all();
  }

  count(): number {
    return this.backend.count();
  }
}

/**
 * 防 supersedes 循环:禁止 A 被已有后代链再次替代
 * (在演化层写 supersedes 前调用;M0 骨架,循环检查由演化作业使用)
 */
export function wouldCreateCycle(ledger: EvolutionLedger, fromKey: string, toKey: string): boolean {
  if (fromKey === toKey) return true;
  // 沿 supersedes 向上追溯 fromKey 的祖先,若 toKey 已在祖先链中 → 循环
  let cur = ledger.get(toKey);
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur.memoryKey)) break;
    seen.add(cur.memoryKey);
    for (const parent of cur.supersedes ?? []) {
      if (parent === fromKey) return true;
      cur = ledger.get(parent);
    }
    if (cur && cur.supersedes?.length === 0) break;
  }
  return false;
}