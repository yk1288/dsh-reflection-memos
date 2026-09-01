/**
 * 配置注册(v3.2 文档 5.3)
 *
 * ⚠️ 关键点:
 * - `@deepseek-ai/schemastery` 只有默认导出(`export { Schema as default }`),没有命名导出 z
 * - `installSettingsSection` 返回 void(scope 在内部闭包中),外部拿不到;
 *   正确姿势是保存 setSource 传入的配置 thunk,之后用 getConfig() 动态读取 → 支持配置热更新
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';

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
};

/** 一层深合并:用户配置(loader 可能只传用户写的字段)覆盖默认值 */
function mergeConfig(base: Config, override: Partial<Config> | undefined): Config {
  const result: Config = {
    memos: { ...base.memos, ...(override?.memos ?? {}) },
    reflection: { ...base.reflection, ...(override?.reflection ?? {}) },
    refiner: { ...base.refiner, ...(override?.refiner ?? {}) },
    performance: { ...base.performance, ...(override?.performance ?? {}) },
  };
  return result;
}

/** 配置源 thunk:由 installSettingsSection 的 setSource 注入 */
let current: () => Config = () => DEFAULT_CONFIG;

export function installSettings(ctx: Context, defaultConfig: Config): void {
  // 关键:先让 current 指向"完整默认值 + 用户配置"的合并结果。
  // settings 服务的注入回调是异步的,apply() 内同步的 getConfig() 必须立即拿到可用配置,
  // 否则 getCfg().reflection 会是 undefined 导致启动崩溃。
  const base = mergeConfig(DEFAULT_CONFIG, defaultConfig);
  // userId 回退链:settings 配置 → MEMOS_USER_ID 环境变量 → ''(运行时 ensureWriter 报错)
  if (!base.memos.userId) {
    const envUserId = process.env.MEMOS_USER_ID;
    if (envUserId && envUserId.trim()) base.memos.userId = envUserId.trim();
  }
  current = () => base;
  installSettingsSection(
    ctx,
    settingsNamespace('dsh-reflection-memos'),
    ConfigSchema,
    base,
    {
      // setSource 是"设置系统把指向已解析配置的 thunk 交给我们保存"，不是我们提供 getter
      setSource: (source) => {
        current = source;
      },
      onChange: () => {
        ctx.logger.info('Reflection config updated');
      },
      // validate 通过 throw 拒绝;返回值被忽略。
      // 注意:这里必须非阻塞 —— settings 注册发生在异步注入回调中,
      // 在此抛错会导致注册失败/启动异常。userId 等业务校验留到运行时
      // (ensureWriter 会抛 "memos.userId 未配置")。
      validate: () => {},
    },
  );
}

/** 动态读取当前(含用户设置覆盖)的配置 */
export function getConfig(): Config {
  return current();
}