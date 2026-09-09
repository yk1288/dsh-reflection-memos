/**
 * 记忆编辑工具(v5.0 redesign:tools/memory-tools.ts;O1)
 *
 * 让 agent 在执行中主动读写记忆(受监督):通过 DSH 的 tool seam 暴露三个工具:
 * - memos_lookup(query):查账本当前 active 且已确认的教训(替代裸 search,过滤 superseded/archived)
 * - memos_lesson_ack(scenario):本轮任务开始,声明"将遵守教训 X"(O6 配套,计入遵守前置信号)
 * - memos_correct(memoryKey, reason):受限写 —— 不直接写 MemOS,只登记"更正请求"
 *   (真正的 v+1 修正走既有反思闭环);每日限量,护栏防顺手乱写
 *
 * 注:DSH 插件工具注册走 ctx.tools.register(defineTool({...})),(对齐 dsh-tool-cordis)。
 * 需要 @deepseek-ai/dsh-tools 的 defineTool;若宿主未提供,注册静默跳过(tools 不可用不影响主插件)。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { AuditLogger } from '../audit/logger';
import type { MemoryStore } from '../core/memory-store';
import type { EvolutionLedger } from '../core/ledger';

export interface MemoryToolsOptions {
  /** memos_correct 每日上限,默认 5 */
  correctPerDayLimit: number;
}

interface Registry {
  register(tool: unknown): unknown;
}

export class MemoryTools {
  private correctToday = 0;
  private correctDay = '';

  constructor(
    private ctx: Context,
    private audit: AuditLogger,
    private store: MemoryStore,
    private options: () => MemoryToolsOptions,
  ) {
    this.tryRegister();
  }

  private tryRegister(): void {
    const tools: Registry | undefined = (this.ctx as any).tools;
    if (!tools?.register) {
      this.audit.debug('memory-tools', 'ctx.tools 不可用,记忆工具未注册(不影响主插件)');
      return;
    }
    try {
      tools.register(this.lookupTool());
      tools.register(this.ackTool());
      tools.register(this.correctTool());
      this.audit.debug('memory-tools', '已注册 memos_lookup / memos_lesson_ack / memos_correct');
    } catch (error) {
      this.audit.debug('memory-tools', `工具注册失败: ${String(error)}`);
    }
  }

  // ---------- memos_lookup ----------
  private lookupTool(): unknown {
    return {
      name: 'memos_lookup',
      description:
        '查询 MemOS 教训库(只读):返回当前 active 且已确认的教训(过滤 superseded/merged/archived)。' +
        '参数 query:任务意图/场景关键词;limit:返回条数(默认 3,最多 5)。' +
        '返回每条教训的 patternKey、失败次数、重要性与正文。不要在不知道经验时重复踩坑——先查。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', required: true, description: '任务意图或场景关键词' },
          limit: { type: 'integer', required: false, description: '返回条数,默认 3' },
        },
      },
      run: async (args: { query?: string; limit?: number }) => {
        const q = (args?.query ?? '').trim();
        if (!q) return { ok: false, error: 'query 不能为空' };
        const limit = Math.min(Math.max(args?.limit ?? 3, 1), 5);
        // 复用 RetrievalPipeline 语义:active + acknowledged 才返回
        const { RetrievalPipeline } = await import('../core/retrieval');
        const ledger = this.store.ledger as EvolutionLedger;
        const pipeline = new RetrievalPipeline(ledger, () => ({
          coreZoneMax: 2,
          contextZoneMax: limit,
          maxInjectionChars: 2000,
          maxItemChars: 500,
          enableAck: false,
        }));
        const build = pipeline.retrieve({ intent: q });
        return { ok: true, current: [] as string[], recalled: build.lessons.map((l) => ({ patternKey: l.patternKey, failureCount: l.failureCount, importance: l.importance, text: l.text })) };
      },
    };
  }

  // ---------- memos_lesson_ack ----------
  private ackTool(): unknown {
    return {
      name: 'memos_lesson_ack',
      description:
        '声明本轮将遵守某条已注入/已查询的教训(O6 配套)。' +
        '参数 patternKey:教训的 patternKey(取自 memos_lookup 或注入块)。' +
        '调用后系统记录"已声明遵守",若本轮仍违反则该教训 violation 权重×2。',
      parameters: {
        type: 'object',
        properties: {
          patternKey: { type: 'string', required: true, description: '要遵守的教训 patternKey' },
        },
      },
      run: async (args: { patternKey?: string }) => {
        const pk = (args?.patternKey ?? '').trim();
        if (!pk) return { ok: false, error: 'patternKey 不能为空' };
        const entry = this.store.ledger.query({ kind: 'lesson', patternKey: pk })[0];
        if (!entry) return { ok: false, error: `未找到 patternKey=${pk} 的教训` };
        this.audit.debug('memory-tools', `lesson-ack ${pk}`);
        return { ok: true, acknowledged: true, patternKey: pk };
      },
    };
  }

  // ---------- memos_correct(受限写) ----------
  private correctTool(): unknown {
    return {
      name: 'memos_correct',
      description:
        '受限写:请求更正一条已存在的教训(不直接写 MemOS)。' +
        '参数 memoryKey:账本 memoryKey(取自身 memos_lookup 返回);reason:更正理由(≥10 字符)。' +
        '本工具只登记更正请求(记入审计),真正 v+1 修正仍由反思闭环决定 —— 防止 agent 顺手乱写。' +
        '每日上限 5 次。',
      parameters: {
        type: 'object',
        properties: {
          memoryKey: { type: 'string', required: true, description: '账本 memoryKey' },
          reason: { type: 'string', required: true, description: '更正理由(≥10 字符)' },
        },
      },
      run: async (args: { memoryKey?: string; reason?: string }) => {
        const key = (args?.memoryKey ?? '').trim();
        const reason = (args?.reason ?? '').trim();
        if (!key) return { ok: false, error: 'memoryKey 不能为空' };
        if (reason.length < 10) return { ok: false, error: `reason 至少 10 字符(当前 ${reason.length})` };
        const entry = this.store.ledger.get(key);
        if (!entry) return { ok: false, error: `账本无此 memoryKey(${key.slice(0, 12)}…)` };

        // 护栏:每日限次
        const now = new Date().toISOString().slice(0, 10);
        if (now !== this.correctDay) { this.correctDay = now; this.correctToday = 0; }
        if (this.correctToday >= this.options().correctPerDayLimit) {
          return { ok: false, error: `今日更正已达上限(${this.options().correctPerDayLimit} 次)` };
        }
        this.correctToday += 1;

        this.audit.debug('memory-tools', `correct-request ${key.slice(0, 8)}: ${reason.slice(0, 60)}`);
        // 登记 correction-request 事件;真正落库由反思闭环/人工评估(此处只审计)
        (this.ctx as any).emit('lesson/correct-request', { memoryKey: key, reason, patternKey: entry.patternKey });
        return { ok: true, registered: 'correction-request', memoryKey: key, note: '已登记,真正修正由反思闭环评估' };
      },
    };
  }
}