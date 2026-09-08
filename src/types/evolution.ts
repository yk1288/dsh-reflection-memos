/**
 * 演化账本核心类型(v5.0 redesign 第 3.1/3.4 节)
 *
 * 账本是"进化的决策者"(唯一工作态):版本链、状态、重要性、统计都在这里,
 * MemOS 只做历史的记录者。相比 v4.0 账本模型,本版本吸收源码研究的两项修订:
 * - patternKey: SIA 项目的稳定去重键(area.symptom),语义相同措辞不同的错误不再重复入库
 * - triage: pending 人工分流 —— 自动链路产物不立即 active,确认后才参与召回注入
 */
import type { MemoryStatus, MemoryKind, TriageStatus } from './memory';

/** 账本条目(对应 ~/.dsh/reflection/evolution.db 的一行 JSONL) */
export interface EvolutionEntry {
  /** 主键 = 内容指纹 sha256(content 前 80 字符) */
  memoryKey: string;
  kind: MemoryKind;
  status: MemoryStatus;
  /** 分流态:自动链路产物默认 pending,人工/高频命中确认后才 active */
  triage: TriageStatus;
  version: number;
  /** 本版本替代了哪些 memoryKey */
  supersedes: string[];
  /** 本版本被哪个 memoryKey 替代 */
  supersededBy?: string;
  confidence: number;
  /** 教训:累计失败次数 */
  failureCount: number;
  /** 教训:被遵守且成功的次数 */
  reinforcementCount: number;
  /** 教训:注入后仍违反的次数 */
  violationCount: number;
  /** 被召回/命中次数(检索权重里的 recency 依据之一) */
  hitCount: number;
  /** 稳定去重键:area.symptom(如 deps.module-not-found),查重主键 */
  patternKey?: string;
  /** 重要性 0-1(检索排序:relativity × (0.6+0.4×importance) × recencyBoost) */
  importance: number;
  firstSeen: string;
  lastSeen: string;
  category?: string;
  scenarios: string[];
  contentHash: string;
  note?: string;
}

/** 账本查询筛选项 */
export interface EvolutionFilter {
  kind?: MemoryKind;
  status?: MemoryStatus;
  triage?: TriageStatus;
  category?: string;
  scenario?: string;
  patternKey?: string;
  memoryKey?: string;
}

/** 演化操作(合并/更正/衰减/晋升)的通用落地结果 */
export interface EvolveOutcome {
  op: EvolveOpType;
  producedKey: string;
  supersededKeys: string[];
  ok: boolean;
  error?: string;
}

export type EvolveOpType =
  | 'consolidate' // 合并
  | 'correct'     // 更正
  | 'decay'       // 衰减
  | 'revive'      // 复活(衰减后重新命中)
  | 'promote'     // 晋升
  | 'synthesize'; // 会话整合(episodic)