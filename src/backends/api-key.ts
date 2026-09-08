/**
 * MemOS API Key 解析(v5.0 redesign:M1 共享)
 *
 * 从 refiner.ts 提出,供 MemoryStore(writerProvider)与 RefinerModule 共用:
 * 优先 DSH credentials 服务,回退环境变量。单一实现,避免迁移后双轨漂移。
 */
import type { Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

export async function resolveMemOSApiKey(ctx: Context, apiKeyEnv: string): Promise<string> {
  const credentials: any = (ctx as any).get('credentials');
  if (credentials?.resolve) {
    try {
      const resolved = await credentials.resolve(credentialRef(apiKeyEnv));
      const value = resolved?.value;
      if (typeof value === 'string' && value.trim()) return value;
    } catch {
      // fall through
    }
  }
  const env = process.env[apiKeyEnv];
  if (env && env.trim()) return env;
  throw new Error(`无法解析 MemOS API Key(${apiKeyEnv} 未配置或凭据不可用)`);
}