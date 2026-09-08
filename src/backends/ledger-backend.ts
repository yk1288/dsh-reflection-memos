/**
 * 账本后端(v5.0 redesign:backends/ledger-backend.ts)
 *
 * 账本是"进化的决策者"(唯一工作态):版本链、状态、importance、复发统计都在这,
 * MemOS 只做历史库。存储 ~/.dsh/reflection/evolution.db(JSONL 追加 + fsync 原子写,
 * 日写量 < 千级,无需 SQLite)。
 *
 * 注意:这是 M0 新增能力,默认不接入现有流程(refiner 仍走 AuditLogger),
 * 由 core/ledger.ts 与 core/memory-store.ts 编排,行为零变化约束下先立骨架。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { EvolutionEntry, EvolutionFilter } from '../types/evolution';

export interface LedgerBackendOptions {
  /** 账本文件目录,默认 ~/.dsh/reflection */
  dir?: string;
  /** 文件名,默认 evolution.db */
  file?: string;
}

export class LedgerBackend {
  private readonly file: string;
  private cache: Map<string, EvolutionEntry> = new Map();
  private loaded = false;

  constructor(options?: LedgerBackendOptions) {
    const dir = options?.dir ?? path.join(os.homedir(), '.dsh', 'reflection');
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, options?.file ?? 'evolution.db');
    this.load();
  }

  // ---------- 读写 ----------

  /** 原子追加:写入缓存 + 追加行 + fsync(小文件直接整体重写,保证一致) */
  upsert(entry: EvolutionEntry): void {
    this.cache.set(entry.memoryKey, entry);
    this.persist();
  }

  /** 批量更新(演化作业产物),同样整体重写,一次 fsync */
  upsertMany(entries: EvolutionEntry[]): void {
    for (const entry of entries) {
      this.cache.set(entry.memoryKey, entry);
    }
    this.persist();
  }

  /** 按 memoryKey 读取 */
  get(memoryKey: string): EvolutionEntry | undefined {
    return this.cache.get(memoryKey);
  }

  /** 全部条目(演化作业扫描用) */
  all(): EvolutionEntry[] {
    return [...this.cache.values()];
  }

  /** 按筛选条件查询(账本查询优先于 MemOS 查询——设计第 12 节 #1) */
  query(filter: EvolutionFilter = {}): EvolutionEntry[] {
    const result: EvolutionEntry[] = [];
    for (const entry of this.cache.values()) {
      if (filter.kind && entry.kind !== filter.kind) continue;
      if (filter.status && entry.status !== filter.status) continue;
      if (filter.triage && entry.triage !== filter.triage) continue;
      if (filter.category && entry.category !== filter.category) continue;
      if (filter.patternKey && entry.patternKey !== filter.patternKey) continue;
      if (filter.memoryKey && entry.memoryKey !== filter.memoryKey) continue;
      if (filter.scenario && !(entry.scenarios ?? []).includes(filter.scenario)) continue;
      result.push(entry);
    }
    return result;
  }

  /** 条数(统计用) */
  count(): number {
    return this.cache.size;
  }

  // ---------- 私有 ----------

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, 'utf-8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as EvolutionEntry;
        if (entry?.memoryKey) this.cache.set(entry.memoryKey, entry);
      } catch {
        // 跳过损坏行(与 AuditLogger 同策略)
      }
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    const lines: string[] = [];
    for (const entry of this.cache.values()) {
      lines.push(JSON.stringify(entry));
    }
    fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf-8');
    // 原子替换 + fsync(防止写一半断电丢账本)
    const fd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
}