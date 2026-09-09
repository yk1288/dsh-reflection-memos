/**
 * dsh-reflection-memos 插件入口(v3.2 文档 5.2)
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config';
import { ConfigSchema, installSettings, getConfig, gateConfigFrom } from './config';
import { PlannerModule } from './modules/planner';
import { ExecutorModule } from './modules/executor';
import { ObserverModule } from './modules/observer';
import { ReflectorModule } from './modules/reflector';
import { RefinerModule } from './modules/refiner';
import { registerCommands } from './commands';
import { AuditLogger } from './audit/logger';
import { MemoryStore } from './core/memory-store';
import { ApplierModule } from './loop/applier';
import { EvolverModule } from './loop/evolver';
import { ReporterModule } from './loop/reporter';
import { RetrievalPipeline } from './core/retrieval';
import { MemOSWriter } from './backends/memos-backend';
import { resolveMemOSApiKey } from './backends/api-key';

export const name = 'dsh-reflection-memos';

export const inject = [
  'agents',
  'sessions',
  'commands',
  'subagents',
  'skills',
  'goals',
  'systemPrompt',
  'credentials',
];

const MEMO_RULES = `
【记忆使用规则】
你在回答问题时会收到系统注入的记忆（来自 MemOS 长期记忆），请按以下规则使用：

1. 记忆分级：
   - 带「verified_fact」标签的记忆：经过验证的事实，置信度高，可直接引用
   - 带「lesson_learned」标签的记忆：经验教训，务必遵守，避免重复踩坑
   - 不带上述标签的记忆：普通记忆，引用时注意验证

2. 优先级：
   - 同主题下，优先使用带 verified_fact 标签的记忆
   - 同主题下有多条记忆时，优先使用时间更新的
   - 教训记忆优先级高于普通事实记忆

3. 验证义务：
   - 涉及关键参数、配置、命令时，即使有 verified_fact 记忆，也建议通过工具二次确认
   - 如果发现记忆与实际结果不符，立即触发反思流程
`;

// 自动反思熔断:连续失败次数与暂停截止时间(避免死循环烧 token)
let autoReflectFails = 0;
let autoReflectPausedUntil = 0;
const AUTO_REFLECT_FAIL_LIMIT = 3;
const AUTO_REFLECT_PAUSE_MS = 30 * 60 * 1000;

/** 自动反思失败:累计,达到阈值则熔断暂停;成功则清零 */
function registerAutoReflectOutcome(ctx: Context, audit: AuditLogger, ok: boolean): void {
  if (ok) {
    autoReflectFails = 0;
    return;
  }
  autoReflectFails += 1;
  if (autoReflectFails >= AUTO_REFLECT_FAIL_LIMIT) {
    autoReflectPausedUntil = Date.now() + AUTO_REFLECT_PAUSE_MS;
    audit.debug('circuit-breaker', `连续失败 ${autoReflectFails} 次,自动反思暂停至 ${new Date(autoReflectPausedUntil).toISOString()}`);
  }
}

export function apply(ctx: Context, initialConfig: Config): void {
  // 注册设置面板;配置热更新通过 getConfig() 动态读取
  installSettings(ctx, initialConfig);
  const getCfg = () => getConfig();

  const audit = new AuditLogger();
  const executor = new ExecutorModule(ctx, getCfg, audit);
  const planner = new PlannerModule(ctx, getCfg, () => executor.getCurrentAgent(), audit);
  const observer = new ObserverModule(ctx, getCfg, audit);
  const reflector = new ReflectorModule(ctx, getCfg, () => executor.getCurrentAgent(), audit);

  // v5.0 M1:MemoryStore 是唯一写入口 —— writerProvider 惰性解析(apply 同步,credentials 异步),
  // gateConfig 由现有配置实时映射(热更新友好);RefinerModule 改为经 store 提交。
  const memoryStore = new MemoryStore({
    writerProvider: async () => {
      const memos = getCfg().memos;
      if (!memos.userId) throw new Error('memos.userId 未配置');
      const apiKey = await resolveMemOSApiKey(ctx, memos.apiKeyEnv);
      return new MemOSWriter({
        baseUrl: memos.baseUrl,
        apiKey,
        userId: memos.userId,
        timeoutMs: getCfg().performance.addTimeoutMs,
        redact: true, // v5.0 默认脱敏(GAP-1)
      });
    },
    audit,
    gateConfig: () => gateConfigFrom(getCfg()),
  });
  const refiner = new RefinerModule(ctx, getCfg, audit, memoryStore);

  // v5.0 M2:应用层—— agent/pre-step 注入相关教训(双区),让 agent 动手前就知道"别踩的坑"
  const applier = new ApplierModule(ctx, getCfg, audit, memoryStore);

  // v5.0 M3:演化引擎—— 衰减/合并/晋升/会话整合(记忆进化,能力进化 O5)
  const evolver = new EvolverModule(ctx, getCfg, audit, memoryStore, () => ({
    decayAfterDays: 30,
    archiveAfterDays: 60,
    importanceBoostFactor: 3,
    minReinforcementForPromotion: 3,
    maxViolationRateForPromotion: 0.2,
  }));

  // v5.0 M4:闭环度量/报告—— 让进化可量化 + 元优化建议(O7)
  const reporter = new ReporterModule(memoryStore.ledger);

  // 注入记忆使用规则到系统提示词变量(第二参数是 (context) => string 函数)
  const systemPrompt: any = (ctx as any).get('systemPrompt') ?? (ctx as any).systemPrompt;
  if (systemPrompt?.variable) {
    systemPrompt.variable('memo_rules', () => MEMO_RULES);
  }

  // 模块事件接线:统一走 Cordis 事件总线(observer 内部用 ctx.emit 发出)
  (ctx as any).on('reflection/task-complete', async (payload: any) => {
    const cfg = getCfg();
    if (!payload?.observation) return;
    if (!cfg.reflection.enableTaskReflection) return;
    // 熔断:暂停期内不自动反思(手动 /reflect 不受影响)
    if (Date.now() < autoReflectPausedUntil) return;
    const level = payload.success ? 'task' : 'deep';
    audit.debug('reflect-start', `level=${level} events=${payload.observation.keyEvents?.length}`);
    try {
      const result = await reflector.reflect(payload.observation, level);
      const summary = await refiner.processReflectionResult(result as never);
      registerAutoReflectOutcome(ctx, audit, true);
      audit.debug('reflect-done', `facts=${result.verifiedFacts.length} lessons=${result.lessons.length} ingested=${summary.ingestedCount} failed=${summary.failedCount}`);
      audit.recordReflection({
        level,
        errors: result.errors.length,
        facts: result.verifiedFacts.length,
        lessons: result.lessons.length,
        at: new Date().toISOString(),
      });
      ctx.logger.debug(`自动反思完成: 入库 ${summary.ingestedCount} 失败 ${summary.failedCount}`);
    } catch (error) {
      registerAutoReflectOutcome(ctx, audit, false);
      audit.debug('reflect-error', String(error));
      ctx.logger.warn(`自动反思失败: ${String(error)}`);
    }
  });

  (ctx as any).on('reflection/subtask-failed', async () => {
    if (!getCfg().reflection.enableImmediateReflection) return;
    try {
      const observation = observer.collectCurrentObservation();
      const result = await reflector.reflect(observation, 'immediate');
      await refiner.processReflectionResult(result as never);
    } catch (error) {
      ctx.logger.warn(`即时反思失败: ${String(error)}`);
    }
  });

  (ctx as any).on('reflection/user-correction', async (payload: any) => {
    if (!getCfg().reflection.enableImmediateReflection) return;
    try {
      const observation = observer.collectCurrentObservation();
      observation.userFeedback = payload?.message;
      const result = await reflector.reflect(observation, 'immediate');
      await refiner.processReflectionResult(result as never);
    } catch (error) {
      ctx.logger.warn(`用户纠错反思失败: ${String(error)}`);
    }
  });

  // 注册命令
  registerCommands(ctx, {
    getReflector: () => reflector,
    getRefiner: () => refiner,
    getObserver: () => observer,
    getExecutor: () => executor,
    getPlanner: () => planner,
    getStore: () => memoryStore,
    getApplier: () => applier,
    getEvolver: () => evolver,
    getReporter: () => reporter,
  });

  // 周期反思(默认关闭)
  if (getCfg().reflection.enablePeriodicReflection) {
    const intervalMs = getCfg().reflection.periodicIntervalHours * 60 * 60 * 1000;
    (ctx as any).setInterval(() => {
      const observation = observer.collectCurrentObservation();
      if (!observation.trajectorySummary) return;
      reflector
        .reflect(observation, 'periodic')
        .then(result => refiner.processReflectionResult(result as never))
        .catch((error: unknown) => ctx.logger.warn(`周期反思失败: ${String(error)}`));
    }, intervalMs);
  }

  // 暴露服务供其他插件调用(带前缀命名,防冲突)
  (ctx as any).provide('reflectionMemos', {
    reflect: (obs: never, level: string) => reflector.reflect(obs, level),
    getAuditLog: () => refiner.getAuditLog(),
    getStats: () => observer.getStats(),
  });

  // v5.0 M0:暴露 MemoryStore 服务(账本查询/统计/教训检索;M1 追加 write)
  (ctx as any).provide('memoryStore', {
    query: (filter: never) => memoryStore.query(filter),
    activeLessons: (scenario: string, limit?: number) => memoryStore.activeLessons(scenario, limit),
    stats: () => memoryStore.stats(),
    ledger: memoryStore.ledger,
  });

  // v5.0 M2:暴露 Applier 检索服务(供命令/其他插件查询注入能力)
  const retrievalOptions = () => ({
    coreZoneMax: getCfg().applier.coreZoneMax,
    contextZoneMax: getCfg().applier.contextZoneMax,
    maxInjectionChars: getCfg().applier.maxInjectionChars,
    maxItemChars: getCfg().applier.maxItemChars,
    enableAck: getCfg().applier.enableAck,
  });
  (ctx as any).provide('lessonInjector', {
    retrieve: (intent: string) =>
      new RetrievalPipeline(memoryStore.ledger, retrievalOptions).retrieve({ intent }),
    applier,
  });

  // v5.0 M3:暴露 Evolver 服务(手动 /evolve 与周期作业共用)
  (ctx as any).provide('evolverService', {
    run: (jobs: never) => evolver.run(jobs),
  });

  // v5.0 M4:暴露 Reporter 服务(记忆质量报告)
  (ctx as any).provide('memoryReporter', {
    report: () => reporter.report(),
    format: (report: never) => reporter.format(report),
  });

  ctx.logger.info('dsh-reflection-memos loaded');
}

// 命名导出 Config(schemastery Schema),供 Cordis 加载器解析配置默认值
// (loader 先取 exports.default ?? exports,再读插件对象上的 .Config,.name,.inject,.apply)
export { ConfigSchema as Config } from './config';

// 供 Cordis 加载器使用的默认导出(与命名导出等价,双保险)
export default { name, inject, Config: ConfigSchema, apply };