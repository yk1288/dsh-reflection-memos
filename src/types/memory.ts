/**
 * MemOS 记忆相关类型(v3.2 文档 4.x)
 */

/** search/memory 返回的事实记忆条目(真实字段:memory_detail_list 元素) */
export interface MemoryDetail {
  id?: string;
  memory_key?: string;
  memory_value?: string;
  relativity?: number;
  create_time?: number | string;
  update_time?: number | string;
  [key: string]: unknown;
}

/** add/message 响应信封 */
export interface AddMessageResponse {
  code: number | string;
  message?: string;
  data?: {
    success?: boolean;
    task_id?: string;
    status?: string;
  };
}

/** search/memory 响应信封 */
export interface SearchMemoryResponse {
  code: number | string;
  message?: string;
  data?: {
    memory_detail_list?: MemoryDetail[];
    preference_detail_list?: unknown[];
    tool_memory_detail_list?: unknown[];
    preference_note?: string;
  };
}

// ---------- 账本工作态类型(v5.0 redesign 第 3.1 节) ----------

/**
 * 记忆状态(账本维护的"当前状态",MemOS 只存历史):
 * - active:有效,正常召回
 * - superseded:已被新版本替代
 * - merged:已被合并进规范条目
 * - decayed:长期未命中,降级不主动召回
 * - archived:归档(不召回,保留历史)
 */
export type MemoryStatus = 'active' | 'superseded' | 'merged' | 'decayed' | 'archived';

/** 记忆种类:语义记忆(fact/lesson)与情景记忆(episodic,仅本地) */
export type MemoryKind = 'fact' | 'lesson' | 'episodic' | 'normal';

/**
 * 分流态(SIA 源码研究 GAP-3:pending 人工分流):
 * - pending:自动链路产物(错误扫描/教训升级/演化合并),未确认,不参与召回注入
 * - acknowledged:人工或高频命中确认,可参与召回
 * - active:确认且状态有效(= MemoryStatus.active 的强化表达,冗余但便于检索过滤)
 */
export type TriageStatus = 'pending' | 'acknowledged' | 'active';