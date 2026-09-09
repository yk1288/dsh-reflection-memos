/**
 * 配置注册(v5.0:适配 DSH 当前 settings 服务)
 *
 * 真实环境修正(2026-09-09):v3.2 的 `installSettingsSection` 在当前 DSH
 * (`@deepseek-ai/dsh-settings`) 已不存在且被移除;官方 memos-cloud 插件使用
 * `ctx.inject(['settings'], child => child.settings.register(ns, Schema, { base }))` 拿到
 * `scope`(含 `get()` 热更新),本插件改为同一模式:
 *   - 命名空间:`dsh-reflection-memos`(唯一,符合小写连字符)
 *   - 注册后 `current = () => scope.get()`,实现配置热更新
 *   - 卸载时回退到合并默认(apply 期闭包)
 * 注:`@deepseek-ai/schemastery` 只有默认导出(`z` 即默认 Schema)。
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';

export const ConfigSchema = z.object({
  memos: z.object({
    baseUrl: z.string().default('https://memos.memtensor.cn/api/openmem/v1'),
    apiKeyEnv: z.string().default('MEMOS_API_KEY'),
    userId: z.string().description('用户 ID（必须与 memos-cloud 配置一致）'),
  }),
  reflection: z.object({
    enableImmediateReflection: z.boolean().default(true),
    enableTaskReflection: z.boolean().default(true),
    enablePeriodicReflection: z.boolean().default(false),
    periodicIntervalHours: z.number().default(24),
    autoReflectOnTaskComplete: z.boolean().default(true),
    autoReflectCooldownMs: z.number().default(1800000),
    autoEarlyStopOnFailure: z.boolean().default(false),
    minTrajectoryEventsForAutoReflect: z.number().default(8),
    minConfidenceForFact: z.number().default(0.8),
    minConfidenceForLesson: z.number().default(0.7),
    requireEvidence: z.boolean().default(true),
    evidenceMinChars: z.number().default(20),
    maxReflectionRetries: z.number().default(2),
  }),
  refiner: z.object({
    writeVerifiedFacts: z.boolean().default(true),
    writeLessons: z.boolean().default(true),
    autoUpdateSkills: z.boolean().default(false),
    minFailuresForLesson: z.number().default(2),
    verifyIngestion: z.boolean().default(true),
    maxVerifyRetries: z.number().default(5),
    maxMemoriesPerDay: z.number().default(50),
  }),
  performance: z.object({
    asyncReflection: z.boolean().default(true),
    reflectionTimeoutMs: z.number().default(120000),
    addTimeoutMs: z.number().default(10000),
    searchTimeoutMs: z.number().default(8000),
    verifyInitialDelayMs: z.number().default(3000),
    verifyBackoffFactor: z.number().default(1.8),
    minVerifyRelativity: z.number().default(0.6),
    subagentProvider: z.string().default('opencode-go'),
    subagentModel: z.string().default('deepseek-v4-flash'),
  }),
  // v5.0 M2:应用层/检索注入配置(O6 双区注入 + ack)
  applier: z.object({
    enableLessonInjection: z.boolean().default(true),
    coreZoneMax: z.number().default(2).description('核心区教训上限(常驻高价值)'),
    contextZoneMax: z.number().default(3).description('情境区教训上限(任务相关)'),
    maxInjectionChars: z.number().default(600).description('单次注入总字符预算'),
    maxItemChars: z.number().default(200).description('单条注入字符预算'),
    enableAck: z.boolean().default(true).description('注入块附带 ack 提醒'),
    enableCompliance: z.boolean().default(false).description('turn/end 遵守验证(O3)'),
    enableSelfEval: z.boolean().default(false).description('completed 低质量自评触发深度反思(O3)'),
    selfEvalToolCallMin: z.number().default(3).description('自评触发最小工具调用数'),
    selfEvalFailRatio: z.number().default(0.5).description('自评失败率阈值(≥ 判低质量)'),
    correctPerDayLimit: z.number().default(5).description('memos_correct 每日上限(O1)'),
    violateOnCompleted: z.boolean().default(true).description('O3:completed 带病完成也纳入违规(命中教训错误关键词记违反)'),
  }),
});

/** 配置类型(手动声明,schemastery rc 版 Schema.T 类型不完备) */
export interface Config {
  memos: {
    baseUrl: string;
    apiKeyEnv: string;
    userId: string;
  };
  reflection: {
    enableImmediateReflection: boolean;
    enableTaskReflection: boolean;
    enablePeriodicReflection: boolean;
    periodicIntervalHours: number;
    autoReflectOnTaskComplete: boolean;
    autoReflectCooldownMs: number;
    autoEarlyStopOnFailure: boolean;
    minTrajectoryEventsForAutoReflect: number;
    minConfidenceForFact: number;
    minConfidenceForLesson: number;
    requireEvidence: boolean;
    evidenceMinChars: number;
    maxReflectionRetries: number;
  };
  refiner: {
    writeVerifiedFacts: boolean;
    writeLessons: boolean;
    autoUpdateSkills: boolean;
    minFailuresForLesson: number;
    verifyIngestion: boolean;
    maxVerifyRetries: number;
    maxMemoriesPerDay: number;
  };
  performance: {
    asyncReflection: boolean;
    reflectionTimeoutMs: number;
    addTimeoutMs: number;
    searchTimeoutMs: number;
    verifyInitialDelayMs: number;
    verifyBackoffFactor: number;
    minVerifyRelativity: number;
    subagentProvider: string;
    subagentModel: string;
  };
  applier: {
    enableLessonInjection: boolean;
    coreZoneMax: number;
    contextZoneMax: number;
    maxInjectionChars: number;
    maxItemChars: number;
    enableAck: boolean;
    enableCompliance: boolean;
    enableSelfEval: boolean;
    selfEvalToolCallMin: number;
    selfEvalFailRatio: number;
    correctPerDayLimit: number;
    violateOnCompleted: boolean;
  };
}

/** 完整默认配置(与 ConfigSchema 的 .default() 保持一致;userId 留空,运行时校验) */
export const DEFAULT_CONFIG: Config = {
  memos: {
    baseUrl: 'https://memos.memtensor.cn/api/openmem/v1',
    apiKeyEnv: 'MEMOS_API_KEY',
    userId: '',
  },
  reflection: {
    enableImmediateReflection: true,
    enableTaskReflection: true,
    enablePeriodicReflection: false,
    periodicIntervalHours: 24,
    autoReflectOnTaskComplete: true,
    autoReflectCooldownMs: 1800000,
    autoEarlyStopOnFailure: false,
    minTrajectoryEventsForAutoReflect: 8,
    minConfidenceForFact: 0.8,
    minConfidenceForLesson: 0.7,
    requireEvidence: true,
    evidenceMinChars: 20,
    maxReflectionRetries: 2,
  },
  refiner: {
    writeVerifiedFacts: true,
    writeLessons: true,
    autoUpdateSkills: false,
    minFailuresForLesson: 2,
    verifyIngestion: true,
    maxVerifyRetries: 5,
    maxMemoriesPerDay: 50,
  },
  performance: {
    asyncReflection: true,
    reflectionTimeoutMs: 120000,
    addTimeoutMs: 10000,
    searchTimeoutMs: 8000,
    verifyInitialDelayMs: 3000,
    verifyBackoffFactor: 1.8,
    minVerifyRelativity: 0.6,
    subagentProvider: 'opencode-go',
    subagentModel: 'deepseek-v4-flash',
  },
  applier: {
    enableLessonInjection: true,
    coreZoneMax: 2,
    contextZoneMax: 3,
    maxInjectionChars: 600,
    maxItemChars: 200,
    enableAck: true,
    enableCompliance: false,
    enableSelfEval: false,
    selfEvalToolCallMin: 3,
    selfEvalFailRatio: 0.5,
    correctPerDayLimit: 5,
    violateOnCompleted: true,
  },
};

/** 一层深合并:用户配置(loader 可能只传用户写的字段)覆盖默认值 */
function mergeConfig(base: Config, override: Partial<Config> | undefined): Config {
  const result: Config = {
    memos: { ...base.memos, ...(override?.memos ?? {}) },
    reflection: { ...base.reflection, ...(override?.reflection ?? {}) },
    refiner: { ...base.refiner, ...(override?.refiner ?? {}) },
    performance: { ...base.performance, ...(override?.performance ?? {}) },
    applier: { ...base.applier, ...(override?.applier ?? {}) },
  };
  return result;
}

/** 配置源 thunk:apply() 先指向合并默认,settings 注册后指向 scope.get()(热更新) */
let current: () => Config = () => DEFAULT_CONFIG;

/**
 * 注册配置到 DSH settings 服务(v5.0 适配)。
 * 模式与官方 memos-cloud 插件一致:`ctx.inject(['settings'])` → `settings.register(ns, Schema, { base })`。
 * 返回后 `getConfig()` 即读到用户覆盖;插件卸载时回退到 entry 合并默认。
 */
export function installSettings(ctx: Context, defaultConfig: Config): void {
  // 1) 先让 current 指向"完整默认值 + 用户配置"的合并结果(apply 同步期即可用)
  const base = mergeConfig(DEFAULT_CONFIG, defaultConfig);
  // userId 回退链:settings 配置 → MEMOS_USER_ID 环境变量 → ''(运行时 ensureWriter 报错)
  if (!base.memos.userId) {
    const envUserId = process.env.MEMOS_USER_ID;
    if (envUserId && envUserId.trim()) base.memos.userId = envUserId.trim();
  }
  current = () => base;

  // 2) settings 服务存在时注册命名空间,scope.get() 覆盖用户配置 → 热更新
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = (settingsCtx as any).settings.register(
      'dsh-reflection-memos',
      ConfigSchema,
      { base },
    );
    current = () => scope.get() as Config;
    // 插件/fiber 卸载时回退到 entry 合并默认
    (settingsCtx as any).effect(() => () => {
      current = () => base;
    });
  });
}

/** 动态读取当前(含用户设置覆盖)的配置 */
export function getConfig(): Config {
  return current();
}

/**
 * 将现有 Config(沿 v3.2 的 reflection/refiner/performance 命名空间)映射为 WriteGateConfig。
 * M1 起 WriteGate 是唯一写入闸门,此处保证"旧配置键 → 闸门"零用户改动。
 */
export function gateConfigFrom(config: Config): import('./core/write-gate').WriteGateConfig {
  return {
    evidenceMinChars: config.reflection.evidenceMinChars,
    minConfidenceForFact: config.reflection.minConfidenceForFact,
    minConfidenceForLesson: config.reflection.minConfidenceForLesson,
    maxMemoriesPerDay: config.refiner.maxMemoriesPerDay,
    minFailuresForLesson: config.refiner.minFailuresForLesson,
    verifyIngestion: config.refiner.verifyIngestion,
    redactEnabled: true, // v5.0 默认开启脱敏(研究 GAP-1)
    minVerifyRelativity: config.performance.minVerifyRelativity,
    maxVerifyRetries: config.refiner.maxVerifyRetries,
    verifyInitialDelayMs: config.performance.verifyInitialDelayMs,
    verifyBackoffFactor: config.performance.verifyBackoffFactor,
    searchTimeoutMs: config.performance.searchTimeoutMs,
  };
}