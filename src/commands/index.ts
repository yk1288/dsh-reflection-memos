/**
 * 斜杠命令注册(v3.2 文档 5.4):ctx.commands.register
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ReflectorModule } from '../modules/reflector';
import type { RefinerModule } from '../modules/refiner';
import type { ObserverModule } from '../modules/observer';
import type { ExecutorModule } from '../modules/executor';
import type { PlannerModule } from '../modules/planner';
import type { SubtaskExecutionResult } from '../modules/executor';
import type { MemoryStore } from '../core/memory-store';
import { RetrievalPipeline } from '../core/retrieval';
import type { ApplierModule } from '../loop/applier';
import type { EvolverModule } from '../loop/evolver';
import type { ReporterModule } from '../loop/reporter';
import type { ComplianceModule } from '../loop/compliance';
import type { MemoryTools } from '../tools/memory-tools';

export interface ReflectionModules {
  getReflector: () => ReflectorModule;
  getRefiner: () => RefinerModule;
  getObserver: () => ObserverModule;
  getExecutor: () => ExecutorModule;
  getPlanner: () => PlannerModule;
  getStore: () => MemoryStore;
  getApplier?: () => ApplierModule;
  getEvolver?: () => EvolverModule;
  getReporter?: () => ReporterModule;
  getCompliance?: () => ComplianceModule;
  getMemoryTools?: () => MemoryTools;
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

      // 0. 补抓 agent(命令可能先于 pre-step 执行)
      executor.captureAgent(invocation?.agent);

      // 1. 生成结构化计划(独立 Planner 子代理)
      const plan = await planner.plan(goal);
      const planText = plan.subtasks
        .map((st, i) => `${i + 1}. ${st.description} [${st.checkpointType}]`)
        .join('\n');

      // 2. 用 runMaintenance 保持 agent 上下文存活,顺序 spawn 子任务
      //    (命令返回后 agent turn 结束上下文失效,runMaintenance 保持活跃直到子任务全部完成)
      const results = await invocation.agent.runMaintenance(async () => {
        return executor.executePlan(plan);
      });

      // 3. 汇总结果
      const resultText = results.map((r: SubtaskExecutionResult, i: number) => {
        const status = r.stopReason === 'completed' ? '✅' : r.stopReason === 'error' ? '❌' : `⚠️(${r.stopReason})`;
        const snippet = r.output.slice(0, 200).replace(/\n/g, ' ');
        return `${i + 1}. ${status} ${r.subtask.description.slice(0, 60)}...${snippet ? `\n   ${snippet}` : ''}`;
      }).join('\n');

      return {
        kind: 'success' as const,
        text:
          `📋 计划(${plan.subtasks.length} 步)执行完成:\n\n${resultText}\n\n` +
          `共 ${results.length} 步,可用 /reflect 沉淀经验。`,
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

  // /lesson-confirm:确认待分流教训(M2)—— 将 triage=pending 的教训置为 acknowledged,使其可被检索注入
  // 用法:/lesson-confirm [patternKey 前缀] —— 无参数时列出全部待确认教训
  commands.register({
    name: 'lesson-confirm',
    description: '确认反思产出的待分流教训,使其可被检索注入(M2)',
    input: { hint: '可选:patternKey 前缀;留空列出全部' },
    handler: async (invocation: any) => {
      const store = modules.getStore();
      const pending = store.query({ kind: 'lesson', triage: 'pending' });
      const prefix = (invocation?.rawInput ?? '').trim();

      if (!prefix) {
        if (pending.length === 0) {
          return { kind: 'success' as const, text: '当前没有待确认的教训。' };
        }
        const lines = pending.map(
          (e) => `- ${e.patternKey ?? '无key'} | 失败${e.failureCount}次 | ${(e.contentHash ?? '').slice(0, 40)}`,
        );
        return {
          kind: 'success' as const,
          text: `待确认教训 ${pending.length} 条:\n${lines.join('\n')}\n\n用法:/lesson-confirm <patternKey 前缀> 确认其中匹配的。`,
        };
      }

      const matched = pending.filter(
        (e) => e.patternKey && e.patternKey.startsWith(prefix),
      );
      if (matched.length === 0) {
        return {
          kind: 'error' as const,
          text: `没有匹配 "${prefix}" 的待确认教训。`,
        };
      }
      let confirmed = 0;
      for (const e of matched) {
        if (store.ledger.acknowledge(e.memoryKey)) confirmed += 1;
      }
      return {
        kind: 'success' as const,
        text: `已确认 ${confirmed} 条教训(可被检索注入)。`,
      };
    },
  });

  // /evolve:手动演化作业(M3)—— 衰减/合并/晋升/会话整合
  commands.register({
    name: 'evolve',
    description: '触发记忆演化作业(衰减/合并/晋升/会话整合)',
    input: { hint: '可选:--promote 执行晋升; --consolidate 执行合并; 默认仅衰减' },
    handler: async (invocation: any) => {
      const evolver = modules.getEvolver?.();
      if (!evolver) {
        return { kind: 'error' as const, text: 'evolver 服务不可用(尚未装配)。' };
      }
      const args = (invocation?.rawInput ?? '').trim();
      const jobs = {
        decay: true,
        promote: /\b--promote\b/.test(args),
        consolidate: /\b--consolidate\b/.test(args),
        synthesize: /\b--synthesize\b/.test(args),
      };
      const report = await evolver.run(jobs);
      const promoted = report.promoted.length > 0
        ? `\n- 晋升 Skill:${report.promoted.map((p) => `\n    ${p}`).join('')}`
        : '';
      return {
        kind: 'success' as const,
        text:
          `演化完成(${JSON.stringify(jobs)}):\n` +
          `- 衰减:${report.decayed} 项\n` +
          `- 复活:${report.revived} 项\n` +
          `- 归档:${report.archived} 项\n` +
          `- 合并:${report.consolidated} 项\n` +
          `- 会话整合:${report.synthesized} 项${promoted}` +
          (report.errors.length > 0 ? `\n- 错误:${report.errors.join('; ')}` : ''),
      };
    },
  });

  // /memory-report:记忆质量报告 + 元优化建议(M4)
  commands.register({
    name: 'memory-report',
    description: '生成记忆质量报告(账本/教训效果/演化 + 元优化建议)',
    handler: async () => {
      const reporter = modules.getReporter?.();
      if (!reporter) {
        return { kind: 'error' as const, text: 'reporter 服务不可用(尚未装配)。' };
      }
      const report = reporter.report();
      return { kind: 'success' as const, text: reporter.format(report) };
    },
  });

  // /lesson-check:教训注入/遵守/违反一览(O3 可观测性)
  // 用法:/lesson-check —— 显示账本中已确认教训的学习效果(reinforcement/violation)与注入次数
  commands.register({
    name: 'lesson-check',
    description: '查看教训注入/遵守/违反情况(O3)',
    handler: async () => {
      const store = modules.getStore();
      if (!store) return { kind: 'error' as const, text: 'store 服务不可用。' };
      const lessons = store.query({ kind: 'lesson' });
      const acked = lessons.filter((l) => l.triage !== 'pending');
      const withEffect = acked.filter((l) => l.reinforcementCount > 0 || l.violationCount > 0 || l.hitCount > 0);
      const lines = [
        `教训一览(${lessons.length} 条;已确认 ${acked.length}):`,
        `- 有学习效果记录(遵守/违反/命中):${withEffect.length} 条`,
        '',
        ...withEffect
          .slice(0, 8)
          .map((l) =>
            `· ${l.patternKey ?? '无key'} | 命中${l.hitCount} 遵守${l.reinforcementCount} 违反${l.violationCount} | ${l.contentHash.slice(0, 40)}`,
          ),
      ];
      if (withEffect.length === 0) {
        lines.push('(尚无遵守/违反记录 —— 需启用 applier.enableCompliance 后观察)');
      }
      return { kind: 'success' as const, text: lines.join('\n') };
    },
  });
}
