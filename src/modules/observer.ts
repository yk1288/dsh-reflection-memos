/**
 * 观察层(v3.2 文档 3.3):采集 session/event 事件流,维护任务轨迹缓存
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config';
import type { AuditLogger } from '../audit/logger';
import type { KeyEvent, ReflectionInput } from '../types/reflection';

interface SessionTrace {
  sessionId: string;
  events: KeyEvent[];
  lastUserText: string;
  consecutiveToolFailures: number;
  lastAutoReflectAt: number;
}

const USER_CORRECTION_PATTERN = /(错了|不对|不是这样|纠正|别用|应该|重新|不要|失败|bug|报错)/;

function extractText(blocks: unknown[]): string {
  if (!Array.isArray(blocks)) return '';
  const items = (blocks as Array<{ type?: string; text?: string }>).filter(
    b => b && b.type === 'text' && typeof b.text === 'string',
  );
  return items.map(b => (b.text as string)).join('\n').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function summarizeEvent(event: { type: string; data: any }): string {
  switch (event.type) {
    case 'user/message': {
      const text = extractText(event.data?.content);
      return text ? `用户:${truncate(text, 500)}` : '';
    }
    case 'assistant/message': {
      const text = extractText(event.data?.message?.content);
      return text ? `助手:${truncate(text, 300)}` : '';
    }
    case 'tool/call': {
      const blocks = event.data?.message?.content;
      if (Array.isArray(blocks)) {
        const call = blocks.find((b: any) => b && b.type === 'tool-call');
        if (call) return `工具调用:${call.name}(${truncate(String(call.arguments ?? ''), 200)})`;
      }
      return '';
    }
    case 'tool/result': {
      const blocks = event.data?.message?.content;
      if (Array.isArray(blocks)) {
        const result = blocks.find((b: any) => b && b.type === 'tool-result');
        if (result) return `工具结果:${truncate(extractText(result.content), 300)}`;
      }
      return '';
    }
    default:
      return '';
  }
}

function looksLikeError(text: string): boolean {
  return /(error|failed|failure|exception|exit code [1-9]|报错|失败|错误)/i.test(text);
}

export class ObserverModule {
  private traces = new Map<string, SessionTrace>();
  private lastActiveSession = '';

  constructor(
    private ctx: Context,
    private config: () => Config,
    private audit: AuditLogger,
  ) {
    // rc 版类型对自定义事件不友好,统一走宽松访问
    const anyCtx = this.ctx as any;
    anyCtx.on('session/event', (session: any, event: any) => {
      this.handle(session, event);
    });
  }

  private handle(session: any, event: any): void {
    // 关键:忽略子代理会话(subagent)的回合事件。
    // 否则反思子代理自己的 turn/end 会再次触发 task-complete → 又拉起新反思子代理 → 无限递归
    // (深度曾一路涨到 33)。与官方 memos-cloud 的 includeSubagents=false 语义一致。
    if (session && (session.header?.origin === 'subagent' || session.header?.origin === 'subagent-fork')) {
      return;
    }
    const sessionId = session?.id ?? 'unknown';
    this.lastActiveSession = sessionId;
    const trace: SessionTrace = this.traces.get(sessionId) ?? { sessionId, events: [], lastUserText: '', consecutiveToolFailures: 0, lastAutoReflectAt: 0 };
    this.traces.set(sessionId, trace);

    if (!event || typeof event.type !== 'string') return;

    // 用户消息
    if (event.type === 'user/message') {
      const text = extractText(event.data?.content);
      if (text) {
        trace.lastUserText = text;
        if (USER_CORRECTION_PATTERN.test(text)) {
          const anyCtx = this.ctx as any;
    anyCtx.emit('reflection/user-correction' as never, { message: text, sessionId });
        }
      }
    }

    const summary = summarizeEvent(event);
    if (summary) {
      trace.events.push({
        seq: event.seq ?? 0,
        time: event.time ?? Date.now(),
        turn: event.turn ?? 0,
        type: event.type,
        summary,
      });
    }

    // 工具失败连续计数
    if (event.type === 'tool/result') {
      const failed = looksLikeError(summary);
      trace.consecutiveToolFailures = failed ? trace.consecutiveToolFailures + 1 : 0;
      if (
        trace.consecutiveToolFailures >= 2 &&
        this.config().reflection.enableImmediateReflection
      ) {
        const anyCtx = this.ctx as any;
    anyCtx.emit('reflection/subtask-failed' as never, {
          sessionId,
          consecutiveToolFailures: trace.consecutiveToolFailures,
        });
        trace.consecutiveToolFailures = 0;
      }
    }

    // 回合结束 → 任务完成/失败信号(自动反思:带"值得反思"过滤 + 冷却节流)
    if (event.type === 'turn/end') {
      const reasonKind = event.data?.reason?.kind;
      const success = reasonKind === 'completed';
      if (success || reasonKind === 'aborted' || reasonKind === 'error') {
        const cfg = this.config();
        const worthy = this.worthyOfReflection(trace, cfg.reflection.minTrajectoryEventsForAutoReflect);
        const cooled = Date.now() - (trace.lastAutoReflectAt ?? 0) >= cfg.reflection.autoReflectCooldownMs;
        this.audit.debug('task-complete', JSON.stringify({
          sessionId, reasonKind, success,
          enableTaskReflection: cfg.reflection.enableTaskReflection,
          autoReflectOnTaskComplete: cfg.reflection.autoReflectOnTaskComplete,
          worthy, events: trace.events.length,
          cooled, lastAutoReflectAt: trace.lastAutoReflectAt,
        }));
        if (cfg.reflection.enableTaskReflection && cfg.reflection.autoReflectOnTaskComplete && worthy && cooled) {
          trace.lastAutoReflectAt = Date.now();
          const observation = this.buildObservation(trace);
          const anyCtx = this.ctx as any;
          anyCtx.emit('reflection/task-complete' as never, {
            observation,
            success,
            sessionId,
          });
        }
      }
    }

    // 内存缓存上限,防止无界增长
    if (trace.events.length > 2000) {
      trace.events = trace.events.slice(-1000);
    }
  }

  /** 构建当前活跃任务的反思输入 */
  collectCurrentObservation(): ReflectionInput {
    const trace = this.traces.get(this.lastActiveSession);
    if (!trace) {
      return { taskGoal: '', successCriteria: [], trajectorySummary: '', keyEvents: [] };
    }
    return this.buildObservation(trace);
  }

  private buildObservation(trace: SessionTrace): ReflectionInput {
    const keyEvents = trace.events.slice(-200);
    const trajectorySummary = truncate(
      keyEvents.map(e => `[${e.type}] ${e.summary}`).join('\n'),
      8000,
    );
    return {
      taskGoal: truncate(trace.lastUserText, 500),
      successCriteria: [],
      trajectorySummary,
      keyEvents,
    };
  }

  /** "值得反思"判断:轨迹里有工具调用/失败,或事件数达到阈值(纯闲聊不反思) */
  private worthyOfReflection(trace: SessionTrace, minEvents: number): boolean {
    if (trace.events.length >= minEvents) return true;
    return trace.events.some(
      e => e.type === 'tool/call' || e.type === 'tool/result' || /(error|失败|错误|exception)/i.test(e.summary),
    );
  }

  getStats(): { activeSessions: number; bufferedEvents: number } {
    let bufferedEvents = 0;
    for (const trace of this.traces.values()) bufferedEvents += trace.events.length;
    return { activeSessions: this.traces.size, bufferedEvents };
  }
}