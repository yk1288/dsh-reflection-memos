/**
 * 审计日志(v3.2 文档 5.1):追加写 ~/.dsh/reflection/audit-YYYY-MM-DD.jsonl
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { MemoryWriteResult, ReflectionStats } from '../types/reflection';

export class AuditLogger {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? path.join(os.homedir(), '.dsh', 'reflection');
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(date = new Date()): string {
    const stamp = date.toISOString().slice(0, 10);
    return path.join(this.dir, `audit-${stamp}.jsonl`);
  }

  /** 记录一次写入结果 */
  record(result: MemoryWriteResult): void {
    this.ensureDir();
    fs.appendFileSync(this.fileFor(), `${JSON.stringify(result)}\n`, 'utf-8');
  }

  /** 调试日志(无条件追加,用于排查自动链路;失败不影响主流程) */
  debug(area: string, message: string): void {
    try {
      this.ensureDir();
      const file = path.join(this.dir, `debug-${new Date().toISOString().slice(0, 10)}.log`);
      fs.appendFileSync(file, `${new Date().toISOString()} [${area}] ${message}\n`, 'utf-8');
    } catch {
      // 调试日志失败不影响主流程
    }
  }

  /** 记录一次反思执行摘要 */
  recordReflection(summary: {
    level: string;
    taskId?: string;
    errors: number;
    facts: number;
    lessons: number;
    at: string;
  }): void {
    this.ensureDir();
    fs.appendFileSync(this.fileFor(), `${JSON.stringify({ kind: 'reflection', ...summary })}\n`, 'utf-8');
  }

  /** 从今日日志聚合统计 */
  statsToday(): ReflectionStats {
    const file = this.fileFor();
    const stats: ReflectionStats = {
      totalSubmitted: 0,
      totalIngested: 0,
      totalFailed: 0,
      todayWritten: 0,
      factCount: 0,
      lessonCount: 0,
    };
    if (!fs.existsSync(file)) return stats;

    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown> & { type?: string };
        if (entry.kind === 'reflection') {
          stats.factCount += (entry as { facts?: number }).facts ?? 0;
          stats.lessonCount += (entry as { lessons?: number }).lessons ?? 0;
          continue;
        }
        if (!entry || typeof entry.submitted !== 'boolean') continue;
        stats.totalSubmitted += 1;
        if (entry.ingested) stats.totalIngested += 1;
        else stats.totalFailed += 1;
      } catch {
        // 跳过损坏行
      }
    }
    stats.todayWritten = stats.totalSubmitted;
    return stats;
  }
}