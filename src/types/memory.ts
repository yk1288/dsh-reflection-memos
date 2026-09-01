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