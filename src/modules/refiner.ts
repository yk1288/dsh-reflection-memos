/**
 * 修正层(v3.2 文档 3.5):MemOS 唯一写入入口,add/message + search 轮询验证
 */
import type { Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { Config } from '../config';
import { MemOSWriter } from '../memos/client';
import type { AuditLogger } from '../audit/logger';
import type { Lesson, ReflectionResult, ReflectionStats, VerifiedFact } from '../types/reflection';

function parseFailureCount(text: string): number {
  const match = /第\s*(\d+)\s*次|failure_count[：:\s]+(\d+)/.exec(text ?? '');
  if (!match) return 0;
  return Number(match[1] ?? match[2]) || 0;
}

export class RefinerModule {
  private writer: MemOSWriter | null = null;
  private today = '';
  private writtenToday = 0;

  constructor(
    private ctx: Context,
    private config: () => Config,
    private audit: AuditLogger,
  ) {}

  /** 处理一次反思结果:写入验证事实与教训,轮询验证入库,记录审计 */
  async processReflectionResult(result: ReflectionResult): Promise<{ ingestedCount: number; failedCount: number }> {
    const cfg = this.config();
    if (!cfg.refiner.writeVerifiedFacts && !cfg.refiner.writeLessons) {
      return { ingestedCount: 0, failedCount: 0 };
    }

    const writer = await this.ensureWriter();
    let ingested = 0;
    let failed = 0;
    const stamp = new Date().toISOString();

    if (cfg.refiner.writeVerifiedFacts) {
      for (const fact of result.verifiedFacts) {
        if (!this.bumpQuota()) {
          this.audit.record({ type: 'fact', content: fact.fact, submitted: false, ingested: false, error: 'daily quota exceeded', at: stamp });
          failed += 1;
          continue;
        }
        try {
          const submitted = await writer.submitVerifiedFact(fact);
          const ingestedOk = await this.verifyIfEnabled(writer, fact.fact);
          this.audit.record({
            type: 'fact',
            content: fact.fact,
            submitted: submitted.success,
            ingested: ingestedOk,
            taskId: submitted.taskId,
            at: stamp,
          });
          if (ingestedOk) ingested += 1;
          else failed += 1;
        } catch (error) {
          this.audit.record({ type: 'fact', content: fact.fact, submitted: false, ingested: false, error: String(error), at: stamp });
          failed += 1;
        }
      }
    }

    if (cfg.refiner.writeLessons) {
      for (const lesson of result.lessons) {
        if (!this.bumpQuota()) {
          this.audit.record({ type: 'lesson', content: lesson.scenario, submitted: false, ingested: false, error: 'daily quota exceeded', at: stamp });
          failed += 1;
          continue;
        }
        try {
          const outcome = await this.processLesson(lesson, writer);
          const ingestedOk = outcome.submitted
            ? await this.verifyIfEnabled(writer, lesson.correctApproach)
            : false;
          this.audit.record({
            type: 'lesson',
            content: lesson.correctApproach,
            submitted: outcome.submitted,
            ingested: outcome.submitted && ingestedOk,
            error: outcome.reason,
            at: stamp,
          });
          if (outcome.submitted && ingestedOk) ingested += 1;
          else failed += 1;
        } catch (error) {
          this.audit.record({ type: 'lesson', content: lesson.scenario, submitted: false, ingested: false, error: String(error), at: stamp });
          failed += 1;
        }
      }
    }

    return { ingestedCount: ingested, failedCount: failed };
  }

  /** 教训查重与递增:命中则 failureCount+1 重新提交;未达标(低于阈值)不写 */
  private async processLesson(lesson: Lesson, writer: MemOSWriter): Promise<{ submitted: boolean; reason?: string }> {
    const cfg = this.config();

    const existing = await writer
      .searchMemory(lesson.scenario, {
        limit: 5,
        relativity: 0.5,
        filter: { user: { tags: { contains: 'lesson_learned' } } },
        timeoutMs: cfg.performance.searchTimeoutMs,
      })
      .catch(() => []);

    const matched = existing[0];
    if (matched) {
      // 已有同类教训:递增 failureCount,重新提交新版本(MemOS 无 update 接口)
      const count = parseFailureCount(matched.memory_value ?? '');
      lesson.failureCount = Math.max(lesson.failureCount, count + 1);
    } else if (lesson.failureCount < cfg.refiner.minFailuresForLesson) {
      return { submitted: false, reason: `failureCount ${lesson.failureCount} < ${cfg.refiner.minFailuresForLesson}` };
    }

    const res = await writer.submitLesson(lesson);
    return { submitted: res.success };
  }

  private async verifyIfEnabled(writer: MemOSWriter, content: string): Promise<boolean> {
    const cfg = this.config();
    if (!cfg.refiner.verifyIngestion) return true;
    return writer.verifyIngestion(content, {
      maxRetries: cfg.refiner.maxVerifyRetries,
      initialDelayMs: cfg.performance.verifyInitialDelayMs,
      backoffFactor: cfg.performance.verifyBackoffFactor,
      minRelativity: cfg.performance.minVerifyRelativity,
      searchTimeoutMs: cfg.performance.searchTimeoutMs,
    });
  }

  /** 每日写入配额(本地计数,按日期重置) */
  private bumpQuota(): boolean {
    const cfg = this.config();
    const now = new Date().toISOString().slice(0, 10);
    if (now !== this.today) {
      this.today = now;
      this.writtenToday = 0;
    }
    if (this.writtenToday >= cfg.refiner.maxMemoriesPerDay) return false;
    this.writtenToday += 1;
    return true;
  }

  private async ensureWriter(): Promise<MemOSWriter> {
    if (this.writer) return this.writer;
    const cfg = this.config().memos;
    if (!cfg.userId) throw new Error('memos.userId 未配置');
    const apiKey = await this.resolveApiKey(cfg.apiKeyEnv);
    this.writer = new MemOSWriter({
      baseUrl: cfg.baseUrl,
      apiKey,
      userId: cfg.userId,
      timeoutMs: this.config().performance.addTimeoutMs,
    });
    return this.writer;
  }

  private async resolveApiKey(apiKeyEnv: string): Promise<string> {
    const credentials: any = (this.ctx as any).get('credentials');
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

  getStats(): ReflectionStats {
    return this.audit.statsToday();
  }

  getAuditLog(): string[] {
    return [];
  }
}