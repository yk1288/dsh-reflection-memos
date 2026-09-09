/**
 * 应用层(v5.0 redesign:loop/applier.ts;O6 双区注入)
 *
 * 职责:在 agent/pre-step(每轮首个模型步骤前)把"相关教训"注入执行上下文,
 * 让 agent 在动手前就知道"别踩的坑"。M2 范围:注入 + ack 提示 + 审计/统计;
 * compliance 遵守验证(enableCompliance)预留到 M2+。
 *
 * 设计要点:
 * - 不碰 systemPrompt(DSH 结论:pre-step 只能改 messages);
 * - 注入形态:user 消息后追加一条"经验提醒"块(紧凑、预算内);
 * - 只注入账本里 active 且 triage!=='pending' 的教训(GAP-3);
 * - 命中即记审计 lesson-injected;后续可被 /lesson-check 统计。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config';
import type { AuditLogger } from '../audit/logger';
import { RetrievalPipeline } from '../core/retrieval';
import type { MemoryStore } from '../core/memory-store';

export class ApplierModule {
  constructor(
    private ctx: Context,
    private config: () => Config,
    private audit: AuditLogger,
    private store: MemoryStore,
  ) {
    const anyCtx = this.ctx as any;
    // pre-step:注入教训块(在现有 pre-step 之后执行,不阻塞)
    anyCtx.on('agent/pre-step', (payload: any, next: any) => {
      try {
        this.maybeInject(payload);
      } catch (error) {
        this.audit.debug('applier', `pre-step 注入失败: ${String(error)}`);
      }
      return next();
    }, { prepend: false });
  }

  /** 从 pre-step payload 推断任务意图(最新 user 文本)并注入 */
  private maybeInject(payload: any): void {
    const cfg = this.config();
    if (!cfg.applier.enableLessonInjection) return;
    if (!payload?.messages || !Array.isArray(payload.messages)) return;

    const intent = this.extractIntent(payload.messages);
    if (!intent) return;

    const pipeline = new RetrievalPipeline(this.store.ledger, () => ({
      coreZoneMax: cfg.applier.coreZoneMax,
      contextZoneMax: cfg.applier.contextZoneMax,
      maxInjectionChars: cfg.applier.maxInjectionChars,
      maxItemChars: cfg.applier.maxItemChars,
      enableAck: cfg.applier.enableAck,
    }));

    const build = pipeline.retrieve({ intent });
    if (!build.hit) return;

    // 注入:在最后一条 user 消息后追加一块(与 memos-cloud 召回同形态,便于模型识别)
    const lastUserIndex = this.lastUserMessageIndex(payload.messages);
    const block = { type: 'text' as const, text: build.block };
    if (lastUserIndex >= 0) {
      const msg = payload.messages[lastUserIndex];
      const content = Array.isArray(msg.content) ? [...msg.content] : [];
      content.push(block);
      msg.content = content;
    } else {
      // 无 user 消息时追加到消息尾
      payload.messages.push({
        role: 'user',
        content: [{ type: 'text', text: build.block }],
      });
    }

    this.audit.debug('applier', `注入 ${build.lessons.length} 条教训, intent=${intent.slice(0, 40)} keys=${build.lessons.map((l) => l.memoryKey.slice(0, 8)).join(',')}`);
  }

  /** 提取最近 user 文本(忽略 tool/assistant;含运行时快照时优先其后真实用户文本) */
  private extractIntent(messages: any[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg || msg.role !== 'user') continue;
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const text = blocks
        .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('\n')
        .trim();
      if (text && !text.startsWith('Current runtime context')) {
        return text;
      }
    }
    return '';
  }

  private lastUserMessageIndex(messages: any[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') return i;
    }
    return -1;
  }
}