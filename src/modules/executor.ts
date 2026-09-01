/**
 * 执行层(v3.2 文档 3.2,第三期实现):
 * - agent/pre-step 缓存 agent 引用
 * - 计划状态机:startPlan 挂载子任务计划,按 turn/end 结果逐个子任务注入推进
 * - 早停:可选(默认关),子任务失败时 agent.cancel
 */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Config } from '../config';
import type { AuditLogger } from '../audit/logger';
import type { SubTask, TaskPlan } from './planner';

interface PlanState {
  taskId: string;
  goal: string;
  subtasks: SubTask[];
  currentIndex: number; // -1 = 尚未注入任何子任务
  startedAt: number;
}

export class ExecutorModule {
  private agent: any = null;
  private plans = new Map<string, PlanState>(); // sessionId -> plan

  constructor(
    private ctx: Context,
    private config: () => Config,
    private audit: AuditLogger,
  ) {
    // agent/pre-step:仅缓存 agent 引用,不修改 messages
    (this.ctx as any).on('agent/pre-step', (payload: any, next: any) => {
      if (payload && payload.agent) this.agent = payload.agent;
      return next();
    }, { prepend: true });

    // 计划推进:turn/end 判定当前子任务结果 → 推进/早停/完成
    (this.ctx as any).on('session/event', (session: any, event: any) => {
      if (!event || event.type !== 'turn/end') return;
      this.advancePlan(session, event);
    });
  }

  getCurrentAgent(): any {
    return this.agent;
  }

  /** 命令/事件侧补抓 agent(命令可能先于 pre-step 执行) */
  captureAgent(agent: any): void {
    if (agent) this.agent = agent;
  }

  /** 挂载新计划并注入第一个子任务 */
  startPlan(sessionId: string, plan: TaskPlan): void {
    this.plans.set(sessionId, {
      taskId: plan.taskId,
      goal: plan.goal,
      subtasks: plan.subtasks,
      currentIndex: -1,
      startedAt: Date.now(),
    });
    this.audit.debug('plan-start', `taskId=${plan.taskId} subtasks=${plan.subtasks.length}`);
    this.injectNext(sessionId);
  }

  private injectNext(sessionId: string): boolean {
    const plan = this.plans.get(sessionId);
    if (!plan) return false;
    const next = plan.subtasks[plan.currentIndex + 1];
    if (!next) return false;
    plan.currentIndex += 1;
    this.injectSubtask(sessionId, next);
    return true;
  }

  private injectSubtask(sessionId: string, subtask: SubTask): void {
    const plan = this.plans.get(sessionId);
    if (!plan || !this.agent) return;
    const total = plan.subtasks.length;
    const text =
      `【计划执行 · 子任务 ${subtask.order + 1}/${total}】${subtask.description}\n` +
      `成功标准:\n${subtask.successCriteria.map(c => `- ${c}`).join('\n')}\n` +
      `请现在执行该子任务;完成后自然收尾,由系统自动推进下一步。遇到阻塞请明确说明,不要擅自扩大范围。`;
    try {
      const msg = createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text }],
      });
      this.agent.steer(msg); // steer 直接让空闲 agent 转向执行子任务(followup/inject 不会唤醒空闲 agent)
      this.audit.debug('plan-inject', `session=${sessionId} subtask=${subtask.order + 1}/${total}`);
    } catch (error) {
      this.audit.debug('executor', `inject 失败: ${String(error)}`);
    }
  }

  private advancePlan(session: any, event: any): void {
    const sessionId = session?.id as string;
    const plan = this.plans.get(sessionId);
    if (!plan) return;

    const reasonKind = event.data?.reason?.kind;
    const ok = reasonKind === 'completed';
    const done = plan.currentIndex >= plan.subtasks.length - 1;
    this.audit.debug('plan-advance', JSON.stringify({
      sessionId,
      taskId: plan.taskId,
      currentIndex: plan.currentIndex,
      total: plan.subtasks.length,
      reasonKind,
      ok,
      done,
    }));

    if (!ok && this.config().reflection.autoEarlyStopOnFailure) {
      // 早停:子任务失败,取消 agent 终止执行
      this.plans.delete(sessionId);
      try {
        this.agent?.cancel?.({ kind: 'user', reason: 'subtask failed, early stop' }, {});
      } catch (error) {
        this.audit.debug('executor', `cancel 失败: ${String(error)}`);
      }
      this.audit.debug('plan-stop', `taskId=${plan.taskId} 子任务 ${plan.currentIndex + 1} 失败,早停`);
      return;
    }

    if (done) {
      this.plans.delete(sessionId);
      this.audit.debug('plan-done', `taskId=${plan.taskId} 全部 ${plan.subtasks.length} 步完成`);
      return;
    }

    this.injectNext(sessionId);
  }
}