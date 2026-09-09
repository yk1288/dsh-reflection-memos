/**
 * 应用层(v5.0 redesign:loop/applier.ts;O6 双区注入)
 *
 * 职责:在 agent/pre-step(每轮首个模型步骤前)把"相关教训"注入执行上下文,
 * 让 agent 在动手前就知道"别踩的坑"。M2 范围:注入 + ack 提示 + 审计/统计;
 * compliance 遵守验证(enableCompliance)预留到 M2+。
 *
 * 真实环境修正(2026-09-09):
 * - pre-step 的 messages 是冻结对象,不能改 msg.content → 参照 memos-cloud 模式,
 *   `await next()` 取 decision,构造新消息数组,在首条用户消息前插入注入块
 *   (insertRecallBeforeDirectUser 同款不可变插入),返回 { ...decision, messages }。
 * - 事件注册 `{ prepend: true }`(与 memos-cloud 一致)。
 */
import type { Context } from '@deepseek-ai/cordis';
import { randomUUID } from 'node:crypto';
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
    anyCtx.on('agent/pre-step', async (payload: any, next: any) => {
      // 与 memos-cloud 相同:先 await next() 拿 decision(后续注入/决策后的 messages)
      const decision = await next();
      try {
        return this.maybeInject(decision);
      } catch (error) {
        this.audit.debug('applier', `pre-step 注入失败: ${String(error)}`);
        return decision; // 失败不阻塞
      }
    }, { prepend: true });
  }

  /** 从 decision.messages 推断任务意图并注入(不可变构造) */
  private maybeInject(decision: any): any {
    const cfg = this.config();
    if (!cfg.applier.enableLessonInjection) return decision;
    if (!decision?.messages || !Array.isArray(decision.messages)) return decision;

    const intent = this.extractIntent(decision.messages);
    if (!intent) return decision;

    const pipeline = new RetrievalPipeline(this.store.ledger, () => ({
      coreZoneMax: cfg.applier.coreZoneMax,
      contextZoneMax: cfg.applier.contextZoneMax,
      maxInjectionChars: cfg.applier.maxInjectionChars,
      maxItemChars: cfg.applier.maxItemChars,
      enableAck: cfg.applier.enableAck,
    }));

    const build = pipeline.retrieve({ intent });
    if (!build.hit) return decision;

    const injected = this.insertBeforeFirstUserMessage(decision.messages, build.block, intent);
    this.audit.debug(
      'applier',
      `注入 ${build.lessons.length} 条教训, intent=${intent.slice(0, 40)} keys=${build.lessons.map((l) => l.memoryKey.slice(0, 8)).join(',')}`,
    );
    return { ...decision, messages: injected };
  }

  /**
   * 不可变插入:在第一条 source.kind==='user' 的消息前插入注入块(参照 memos-cloud
   * insertRecallBeforeDirectUser)。不去改冻结消息对象的 content。
   */
  private insertBeforeFirstUserMessage(messages: any[], block: string, intent: string): any[] {
    const index = messages.findIndex((m) => m?.source?.kind === 'user');
    if (index < 0) return [...messages];
    const injectionMsg = {
      id: randomUUID(), // 消息 id 必需: harness assertMessageEventShape 要求 user/message 带非空 id
      role: 'user',
      source: { kind: 'plugin', plugin: 'dsh-reflection-memos', form: 'lesson-injection', intent },
      content: [{ type: 'text', text: block }],
    };
    return [...messages.slice(0, index), injectionMsg, ...messages.slice(index)];
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
}