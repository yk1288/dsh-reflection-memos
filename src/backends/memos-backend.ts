/**
 * MemOS 后端(v5.0 redesign:backends/memos-backend.ts)
 *
 * 原 v3.2 memos/client.ts 原样迁入(已验证资产清单 #1/#2,逻辑零变化):
 * - POST {base}/add/message    写入(异步,服务端抽取记忆)
 * - POST {base}/search/memory  召回/验证(响应 data.memory_detail_list)
 * 认证:Authorization: Token <apiKey>
 *
 * v5.0 增量(研究 GAP-1):构造项可选 redact —— 开启后提交文本先经脱敏层,
 * 默认 false 保持与 v3.2 行为完全一致(迁移期双轨)。
 */
import type { Lesson, VerifiedFact } from '../types/reflection';
import type { AddMessageResponse, MemoryDetail, SearchMemoryResponse } from '../types/memory';
import { redactText } from '../core/redact';

/** source 字段与官方 memos-cloud core 保持一致(平台标识) */
export function memosSource(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'deepseek_harness_win';
  if (platform === 'darwin') return 'deepseek_harness_mac';
  return 'deepseek_harness_linux';
}

export interface MemOSWriterOptions {
  baseUrl: string;
  apiKey: string;
  userId: string;
  timeoutMs?: number;
  /** v5.0:开启后提交文本先脱敏(研究 GAP-1);默认 false 与 v3.2 行为一致 */
  redact?: boolean;
}

export class MemOSWriter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly userId: string;
  private readonly timeoutMs: number;
  private readonly redact: boolean;

  constructor(config: MemOSWriterOptions) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.userId = config.userId;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.redact = config.redact ?? false;
  }

  /** 提交内容统一出口:redact 开启时先脱敏 */
  private sanitize(text: string): string {
    return this.redact ? redactText(text) : text;
  }

  /**
   * 提交验证事实到 MemOS(异步)
   * 返回 taskId(如有),后续用 verifyIngestion 轮询验证入库
   */
  async submitVerifiedFact(fact: VerifiedFact): Promise<{ taskId?: string; success: boolean }> {
    const content = this.sanitize(this.buildFactMessage(fact));

    const body = {
      user_id: this.userId,
      conversation_id: 'dsh:reflection', // 固定,保持上下文连续(≤100 字符)
      messages: [{ role: 'user', content }],
      source: memosSource(),
      async_mode: true,
      allow_public: false,
      tags: ['verified_fact', `category:${fact.category}`, 'deepseek-harness', ...fact.tags],
      info: {
        // info 值必须是非空字符串!数字一律 String()
        verification_method: this.sanitize(fact.verificationMethod),
        confidence: String(fact.confidence),
        source: 'dsh-reflection-memos',
        version: '1.0',
        category: fact.category,
      },
    };

    return this.postAdd(body);
  }

  /** 提交教训记忆(异步) */
  async submitLesson(lesson: Lesson): Promise<{ taskId?: string; success: boolean }> {
    const content = this.sanitize(this.buildLessonMessage(lesson));

    const body = {
      user_id: this.userId,
      conversation_id: 'dsh:reflection',
      messages: [{ role: 'user', content }],
      source: memosSource(),
      async_mode: true,
      allow_public: false,
      tags: ['lesson_learned', 'deepseek-harness', ...lesson.applicableScenarios.map(s => `scenario:${s}`)],
      info: {
        failure_count: String(lesson.failureCount),
        severity: lesson.severity,
        confidence: String(lesson.confidence),
        source: 'dsh-reflection-memos',
      },
    };

    return this.postAdd(body);
  }

  /**
   * 验证记忆是否真的入库了
   * 轮询 search/memory,命中且 top relativity >= 阈值视为入库
   */
  async verifyIngestion(
    content: string,
    options?: {
      maxRetries?: number;
      initialDelayMs?: number;
      backoffFactor?: number;
      minRelativity?: number;
      searchTimeoutMs?: number;
    },
  ): Promise<boolean> {
    const maxRetries = options?.maxRetries ?? 5;
    const initialDelayMs = options?.initialDelayMs ?? 3000;
    const backoffFactor = options?.backoffFactor ?? 1.8;
    const minRelativity = options?.minRelativity ?? 0.6;

    let delay = initialDelayMs;

    for (let i = 0; i < maxRetries; i++) {
      await this.sleep(delay);
      delay = Math.floor(delay * backoffFactor);

      const memories = await this.searchMemory(content, {
        limit: 3,
        relativity: 0.4, // 低阈值搜,回来再判断
        timeoutMs: options?.searchTimeoutMs,
      });

      if (memories.length === 0) continue;

      // 真实响应条目带 relativity 字段
      const top = memories[0];
      if (typeof top.relativity === 'number' && top.relativity >= minRelativity) {
        return true;
      }
    }

    return false;
  }

  /**
   * 搜索记忆(用于查重、验证)
   * 真实响应结构:data.memory_detail_list[](字段 memory_key/memory_value/relativity)
   */
  async searchMemory(
    query: string,
    options?: {
      limit?: number;
      relativity?: number;
      filter?: Record<string, unknown>;
      timeoutMs?: number;
    },
  ): Promise<MemoryDetail[]> {
    const res = await this.fetchJson<SearchMemoryResponse>('/search/memory', {
      user_id: this.userId,
      query,
      memory_limit_number: options?.limit ?? 5,
      relativity: options?.relativity ?? 0.5,
      filter: options?.filter,
    }, options?.timeoutMs);

    assertOk(res);
    const list = res.data?.memory_detail_list ?? [];
    return list.map((m) => ({
      ...m,
      relativity: typeof m.relativity === 'number' ? m.relativity : undefined,
    }));
  }

  // ---------- private ----------

  private async postAdd(body: Record<string, unknown>): Promise<{ taskId?: string; success: boolean }> {
    const res = await this.fetchJson<AddMessageResponse>('/add/message', body, this.timeoutMs);
    assertOk(res);
    return {
      success: true,
      taskId: res.data?.task_id,
    };
  }

  private async fetchJson<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`MemOS HTTP ${res.status} on ${path}`);
      }
      return (await res.json()) as T;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`MemOS ${path} timed out after ${timeoutMs ?? this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Token ${this.apiKey}`,
    };
  }

  private buildFactMessage(fact: VerifiedFact): string {
    return (
      `我确认一个事实：${fact.fact}。` +
      `验证方法：${fact.verificationMethod}。` +
      `证据：${fact.evidence}。` +
      `置信度：${(fact.confidence * 100).toFixed(0)}%。` +
      `分类：${fact.category}。` +
      `标签：verified_fact, category:${fact.category}, ${fact.tags.join(', ')}。`
    );
  }

  private buildLessonMessage(lesson: Lesson): string {
    return (
      `我学到了一个教训：在${lesson.scenario}场景下，` +
      `不要${lesson.mistake}，` +
      `正确做法是${lesson.correctApproach}。` +
      `证据：${lesson.evidence}。` +
      `这是第${lesson.failureCount}次遇到同类问题。` +
      `严重程度：${lesson.severity}。` +
      `标签：lesson_learned, ${lesson.applicableScenarios.map(s => `scenario:${s}`).join(', ')}。`
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

function assertOk(res: AddMessageResponse | SearchMemoryResponse): void {
  if (res.code !== 0 && res.code !== 200 && String(res.code) !== '0' && String(res.code) !== '200') {
    throw new Error(`MemOS rejected the request: ${res.message ?? String(res.code)}`);
  }
}