/**
 * 斜杠命令注册(v3.2 文档 5.4):ctx.commands.register
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ReflectorModule } from '../modules/reflector';
import type { RefinerModule } from '../modules/refiner';
import type { ObserverModule } from '../modules/observer';
import type { ExecutorModule } from '../modules/executor';
import type { PlannerModule } from '../modules/planner';

export interface ReflectionModules {
  getReflector: () => ReflectorModule;
  getRefiner: () => RefinerModule;
  getObserver: () => ObserverModule;
  getExecutor: () => ExecutorModule;
  getPlanner: () => PlannerModule;
}

export function registerCommands(
  ctx: Context,
  modules: ReflectionModules,
): void {
  const commands: any = (ctx as any).commands;
  if (!commands?.register) {
    ctx.logger.warn('commands 服务不可用,斜杠命令未注册');
    return;
  }

  // /reflect:手动触发反思
  commands.register({
    name: 'reflect',
    description: '手动触发对当前任务的反思,提炼经验写入 MemOS',
    input: { hint: '可选:指定反思范围' },
    handler: async (invocation: any) => {
      const observer = modules.getObserver();
      const reflector = modules.getReflector();
      const refiner = modules.getRefiner();

      const observation = observer.collectCurrentObservation();
      // 反思子代理可传入 invocation.signal,便于命令取消/超时终止
      const result = await reflector.reflect(observation, 'manual', invocation?.signal);
      const summary = await refiner.processReflectionResult(result as never);

      return {
        kind: 'success' as const,
        text:
          `反思完成。\n` +
          `- 发现问题:${result.errors.length} 个\n` +
          `- 验证事实:${result.verifiedFacts.length} 条\n` +
          `- 经验教训:${result.lessons.length} 条\n` +
          `- 成功入库:${summary.ingestedCount} 条\n` +
          `- 入库失败:${summary.failedCount} 条`,
      };
    },
  });

  // /plan-and-execute:先规划再执行,子任务自动推进
  commands.register({
    name: 'plan-and-execute',
    description: '先规划任务再执行,完成后自动反思沉淀',
    input: { hint: '任务描述' },
    handler: async (invocation: any) => {
      const goal = (invocation?.rawInput ?? '').trim();
      if (!goal) {
        return { kind: 'error' as const, text: '用法:/plan-and-execute <任务描述>' };
      }
      const planner = modules.getPlanner();
      const executor = modules.getExecutor();

      // 0. 命令可能先于回合 pre-step 执行,先补抓当前 agent
      executor.captureAgent(invocation?.agent);

      // 1. 生成结构化计划(独立 Planner 子代理)
      const plan = await planner.plan(goal);
      const planText = plan.subtasks
        .map((st, i) => `${i + 1}. ${st.description} [${st.checkpointType}]`)
        .join('\n');

      // 2. 挂载计划状态机并注入第一个子任务(executor 按 turn/end 自动推进)
      const sessionId = invocation?.agent?.session?.id ?? '';
      executor.startPlan(sessionId, plan);

      return {
        kind: 'success' as const,
        text:
          `✅ 计划已生成(${plan.subtasks.length} 步),开始自动执行:\n\n${planText}\n\n` +
          `每个子任务完成后自动推进下一步;遇阻塞会记录(可配置早停)。` +
          `全部完成或需要干预时会停下,之后可用 /reflect 沉淀经验。`,
      };
    },
  });

  // /memos-stat:记忆统计
  commands.register({
    name: 'memos-stat',
    description: '查看反思闭环的记忆统计',
    handler: async () => {
      const stats = modules.getRefiner().getStats();
      return {
        kind: 'success' as const,
        text:
          `反思闭环记忆统计:\n` +
          `- 总提交数:${stats.totalSubmitted}\n` +
          `- 成功入库:${stats.totalIngested}\n` +
          `- 入库失败:${stats.totalFailed}\n` +
          `- 今日写入:${stats.todayWritten}\n` +
          `- 事实记忆:${stats.factCount} 条\n` +
          `- 教训记忆:${stats.lessonCount} 条`,
      };
    },
  });
}
