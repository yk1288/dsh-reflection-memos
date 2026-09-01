/**
 * 规划层(v3.2 文档 3.1,第三期实现):
 * 用独立 Planner 子代理把目标分解为带成功标准的子任务,
 * 由 ExecutorModule 状态机逐个子任务驱动执行。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config';
import type { AuditLogger } from '../audit/logger';
import { extractChildError, extractFinalTextFromChild, extractJsonObject } from './reflector';

export interface SubTask {
  id: string;
  description: string;
  order: number;
  successCriteria: string[];
  checkpointType: 'auto' | 'manual' | 'tool-verify';
  dependsOn: number[]; // 依赖的子任务 order(0-based)
}

export interface TaskPlan {
  taskId: string;
  goal: string;
  subtasks: SubTask[];
}

const PLANNER_PERSONA =
  '你是一个任务规划专家。给定一个目标,把它分解为有序、可执行、可验证的原子子任务。' +
  '你必须仅输出一个 JSON 对象,不要输出任何解释、前言或 Markdown 代码块。' +
  'JSON 结构:{"goal": "目标", "subtasks": [{"description": "子任务描述(一句话)", ' +
  '"successCriteria": ["可验证的成功标准(自然语言,3-5 条)"], ' +
  '"checkpointType": "auto|manual|tool-verify", "dependsOn": [依赖的子任务序号, 0-based]} ...]}' +
  '要求:3-8 个子任务;每个子任务独立、顺序合理、可验证;不要把目标拆得过碎。' +
  '你没有工具,禁止输出任何工具调用(如 <|DSML| tool_calls>)。如果你输出工具调用,你的回答将被丢弃并视为失败。直接输出最终 JSON 对象。';

interface PlannerOutcome {
  goal: string;
  subtasks: Array<{
    description: string;
    successCriteria: string[];
    checkpointType?: 'auto' | 'manual' | 'tool-verify';
    dependsOn?: number[];
  }>;
}

/** 从子代理 run.result 提取文本(与 reflector 同一规则) */
function extractOutputText(output: unknown): string {
  if (typeof output === 'string') return output.trim();
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const block of output) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

export class PlannerModule {
  constructor(
    private ctx: Context,
    private config: () => Config,
    private getAgent: () => any,
    private audit?: AuditLogger,
  ) {}

  /** 生成任务计划(拉起独立 Planner 子代理) */
  async plan(goal: string): Promise<TaskPlan> {
    const agent = this.getAgent();
    if (!agent) throw new Error('没有可用的 agent 引用(尚未观察到 agent/pre-step)');

    const subagents: any = (this.ctx as any).subagents;
    if (!subagents?.start) throw new Error('subagents 服务不可用');

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.planOnce(subagents, agent, goal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = /工具调用|DSML|不是合法 JSON|未产出任何子任务/.test(message);
        this.audit?.debug('plan-error', `attempt=${attempt} ${message.slice(0, 800)}`);
        if (attempt >= maxAttempts || !retryable) {
          // 不空手失败:降级为单任务兜底计划,保证 /plan-and-execute 有产出
          return this.fallbackPlan(goal);
        }
      }
    }
    throw new Error('unreachable');
  }

  private childAgentOptions(): { provider?: string; model?: string } {
    // 空对象:子代理完全继承 parent 的 provider/model(parent opencode-go + deepseek-v4-flash 已正常运行)
    return {};
  }

  /** 子代理失败时的兜底计划:目标作为唯一子任务直接执行,保证 /plan-and-execute 有产出 */
  private fallbackPlan(goal: string): TaskPlan {
    const plan: TaskPlan = {
      taskId: `task_${Date.now()}`,
      goal,
      subtasks: [
        {
          id: 'sub_1',
          description: goal,
          order: 0,
          successCriteria: ['完成目标所述任务', '处理过程中无未解决的阻塞错误'],
          checkpointType: 'auto',
          dependsOn: [],
        },
      ],
    };
    this.audit?.debug('plan-fallback', `子代理规划失败,降级为单任务计划: ${goal.slice(0, 120)}`);
    return plan;
  }

  private async planOnce(subagents: any, agent: any, goal: string): Promise<TaskPlan> {
    const run = await subagents.start('spawn', {
      label: 'planner',
      prompt: [{ type: 'text', text: JSON.stringify({ goal }) }],
      parent: agent,
      signal: new AbortController().signal,
      maxDepth: 32, // 放宽护栏:planner 无工具不会真递归,避免嵌套场景 depth 超限
      persona: PLANNER_PERSONA,
      toolFilter: { allow: [] },
      // 继承 parent 的 provider/model(opencode-go + deepseek-v4-flash 已正常运行)
      agentOptions: {},
    });

    let settled: any;
    try {
      settled = await run.result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Planner 子代理底层失败: ${detail.slice(0, 500)}`);
    }
    if (!settled || settled.stopReason === 'error') {
      const detail = settled ? extractChildError(run.localAgent) : '(run.result 为空)';
      throw new Error(`Planner 子代理失败 (stopReason=${settled?.stopReason})\n子代理事件详情:\n${detail || '(无)'}`);
    }

    // 优先取"最后一条纯文本助手消息";兜底用 run.result 的 output
    let output = extractFinalTextFromChild(run.localAgent);
    if (!output) output = extractOutputText(settled.output);
    const parsed = extractJsonObject(output) as PlannerOutcome | null;
    if (!parsed) {
      throw new Error(`Planner 输出不是合法 JSON。原文: ${output.slice(0, 300)}`);
    }
    if (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
      throw new Error('Planner 未产出任何子任务');
    }

    const subtasks: SubTask[] = parsed.subtasks.map((raw, index) => ({
      id: `sub_${index + 1}`,
      description: raw.description,
      order: index,
      successCriteria: Array.isArray(raw.successCriteria) && raw.successCriteria.length > 0
        ? raw.successCriteria
        : ['子任务完成且无阻塞错误'],
      checkpointType: raw.checkpointType ?? 'auto',
      dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn : [],
    }));

    return {
      taskId: `task_${Date.now()}`,
      goal: parsed.goal || goal,
      subtasks,
    };
  }
}