/**
 * 执行层(v3.2 第三期,auto-advance 重构):
 * - agent/pre-step 缓存 agent 引用
 * - executePlan():在命令 handler 内用 spawn 子代理顺序执行每个子任务,
 *   每个子任务独立拥有主 agent 的工具(bash/read/write 等),结果直接返回。
 *   不依赖 followup/inject/steer 唤醒空闲 agent,完全自主执行。
 * - 反思层在命令返回后自动触发(已接线到 reflection/task-complete)
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config';
import type { AuditLogger } from '../audit/logger';
import type { SubTask, TaskPlan } from './planner';
import { extractOutputText } from './reflector';

export interface SubtaskExecutionResult {
  subtask: SubTask;
  stopReason: string;
  output: string;
}

export class ExecutorModule {
  private agent: any = null;

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
  }

  getCurrentAgent(): any {
    return this.agent;
  }

  captureAgent(agent: any): void {
    if (agent) this.agent = agent;
  }

  /**
   * 顺序执行计划中的每个子任务(在命令 handler 内完成,不需要状态机)。
   * 每个子任务作为独立的 spawn 子代理运行,继承主 agent 的工具(bash/read 等),
   * 子代理返回文本结果后自动推进下一个。
   *
   * 这解决了"命令返回后 agent 空闲,followup/inject/steer 无法唤醒"的根因问题。
   * 代价:命令期间 UI 显示 loading,所有子任务串行执行(约 10-30s/步 × N 步)。
   */
  async executePlan(plan: TaskPlan): Promise<SubtaskExecutionResult[]> {
    const subagents: any = (this.ctx as any).subagents;
    if (!subagents?.start) throw new Error('subagents 服务不可用');
    if (!this.agent) throw new Error('当前没有可用的 agent 引用(尚未观察到 agent/pre-step)');

    this.audit.debug('plan-execute-start', `taskId=${plan.taskId} subtasks=${plan.subtasks.length}`);
    const results: SubtaskExecutionResult[] = [];

    for (let i = 0; i < plan.subtasks.length; i++) {
      const subtask = plan.subtasks[i];
      this.audit.debug('plan-execute-step', `subtask=${i + 1}/${plan.subtasks.length} ${subtask.description.slice(0, 80)}`);

      const prompt = [
        { type: 'text', text: [
          `【计划执行 · 子任务 ${subtask.order + 1}/${plan.subtasks.length}】${subtask.description}`,
          `成功标准:`,
          ...subtask.successCriteria.map(c => `- ${c}`),
          `请现在执行该子任务并输出结果摘要。`,
        ].join('\n') },
      ];

      try {
        const run = await subagents.start('spawn', {
          label: `subtask-${subtask.id}`,
          prompt,
          parent: this.agent,
          maxDepth: 32,
          // 不传 toolFilter: 子代理继承主 agent 的工具(bash/read/write 等),能真正执行任务
          agentOptions: {},
        });

        const settled = await run.result;
        const output = extractOutputText(settled?.output);
        const stopReason = settled?.stopReason ?? 'unknown';

        results.push({ subtask, stopReason, output });
        this.audit.debug('plan-execute-done', `subtask=${i + 1} stopReason=${stopReason} outputLen=${output.length}`);

      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ subtask, stopReason: 'error', output: `执行失败: ${message.slice(0, 300)}` });
        this.audit.debug('plan-execute-error', `subtask=${i + 1} ${message.slice(0, 300)}`);
      }
    }

    this.audit.debug('plan-execute-end', `taskId=${plan.taskId} completed=${results.length} steps`);
    return results;
  }
}
