/**
 * 演化引擎(v5.0 redesign:loop/evolver.ts;O2/O4/O5)
 *
 * 让 MemOS 记忆"进化"的三类作业 + Skill 晋升:
 * - decay(衰减): long 未命中(账本 lastSeen)→ 状态 decayed→archived;importance≥0.8 衰减期×3
 * - consolidate(合并): 同 category/topic 的教训候选 → 子代理裁决为规范条目(含 supersedes)
 * - promote(晋升): reinforcement≥min 且 violation 率低 → 写 Skill 到 ~/.dsh/skills/(能力进化)
 * - synthesize(会话整合, O2): episodic 摘要写入账本 kind=episodic(不写 MemOS)
 *
 * 原则(设计第 5 节):
 * - 写经 WriteGate 仍走验证(合并/更正产物);衰减只改账本;
 * - 幂等:同一次作业可重复运行不重复写;
 * - 熔断:连续失败暂停(复用自动反思熔断思路,由调用方汇总)。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config';
import type { AuditLogger } from '../audit/logger';
import type { EvolutionLedger } from '../core/ledger';
import type { MemoryStore } from '../core/memory-store';
import type { EvolutionEntry } from '../types/evolution';

export interface EvolveJobReport {
  decayed: number;
  revived: number;
  archived: number;
  consolidated: number;
  promoted: string[];
  synthesized: number;
  errors: string[];
}

export interface EvolverOptions {
  decayAfterDays: number;
  archiveAfterDays: number;
  importanceBoostFactor: number; // importance ≥0.8 的衰减期 ×factor
  minReinforcementForPromotion: number;
  maxViolationRateForPromotion: number;
  skillsDir?: string;
  enabledJobs?: { decay?: boolean; consolidate?: boolean; promote?: boolean; synthesize?: boolean };
}

export class EvolverModule {
  constructor(
    private ctx: Context,
    private config: () => Config,
    private audit: AuditLogger,
    private store: MemoryStore,
    private options: () => EvolverOptions,
  ) {}

  /** 手动/周期触发:跑 enableJobs 对应的作业 */
  async run(jobs?: Partial<{ decay: boolean; consolidate: boolean; promote: boolean; synthesize: boolean }>): Promise<EvolveJobReport> {
    const opts = this.options();
    const enabled = { decay: true, consolidate: false, promote: false, synthesize: false, ...(opts.enabledJobs ?? {}), ...(jobs ?? {}) };
    const report: EvolveJobReport = { decayed: 0, revived: 0, archived: 0, consolidated: 0, promoted: [], synthesized: 0, errors: [] };

    if (enabled.decay) {
      try {
        const r = this.runDecay(opts);
        report.decayed += r.decayed;
        report.revived += r.revived;
        report.archived += r.archived;
      } catch (e) { report.errors.push(`decay: ${String(e)}`); }
    }
    if (enabled.consolidate) {
      try {
        report.consolidated += await this.runConsolidate();
      } catch (e) { report.errors.push(`consolidate: ${String(e)}`); }
    }
    if (enabled.promote) {
      try {
        for (const name of this.runPromote(opts)) report.promoted.push(name);
      } catch (e) { report.errors.push(`promote: ${String(e)}`); }
    }
    if (enabled.synthesize) {
      try {
        report.synthesized += await this.runSynthesize();
      } catch (e) { report.errors.push(`synthesize: ${String(e)}`); }
    }

    this.audit.debug('evolve', JSON.stringify({ jobs: enabled, report }));
    return report;
  }

  // ---------- decay ----------
  private runDecay(opts: EvolverOptions): { decayed: number; revived: number; archived: number } {
    const now = Date.now();
    let decayed = 0, revived = 0, archived = 0;
    for (const entry of this.store.ledger.query({ kind: 'lesson' })) {
      if (entry.status === 'archived') continue;
      const idleDays = (now - new Date(entry.lastSeen).getTime()) / 86400_000;
      // importance 高的衰减容忍度 ×factor
      const threshold = entry.importance >= 0.8 ? opts.decayAfterDays * opts.importanceBoostFactor : opts.decayAfterDays;

      if (entry.status === 'active' && idleDays > threshold) {
        entry.status = 'decayed';
        this.store.ledger.upsert(entry);
        decayed += 1;
      } else if (entry.status === 'decayed' && idleDays < threshold) {
        entry.status = 'active'; // 复活(最近又被命中)
        this.store.ledger.upsert(entry);
        revived += 1;
      } else if (entry.status === 'decayed' && idleDays > opts.archiveAfterDays) {
        entry.status = 'archived';
        this.store.ledger.upsert(entry);
        archived += 1;
      }
    }
    return { decayed, revived, archived };
  }

  // ---------- consolidate(轻量启发式,不依赖子代理,M3 先落地) ----------
  /** 同 patternKey 版本链超额 → 保留最高 failureCount 条目,其余置 merged */
  private async runConsolidate(): Promise<number> {
    const byKey = new Map<string, EvolutionEntry[]>();
    for (const e of this.store.ledger.query({ kind: 'lesson' })) {
      const k = e.patternKey ?? 'general.unknown';
      const arr = byKey.get(k) ?? [];
      arr.push(e);
      byKey.set(k, arr);
    }
    let consolidated = 0;
    for (const [key, entries] of byKey) {
      if (entries.length < 3) continue; // 版本链至少 3 才合并
      // 保留:最高 version + 最大 failureCount 的"代表",其余 merged
      entries.sort((a, b) => b.version - a.version || b.failureCount - a.failureCount);
      const keeper = entries[0];
      for (const e of entries.slice(1)) {
        if (e.status === 'merged' || e.status === 'archived') continue;
        e.status = 'merged';
        e.note = `${e.note ?? ''} merged into ${keeper.memoryKey.slice(0, 8)}`;
        this.store.ledger.upsert(e);
        consolidated += 1;
      }
      // 代表条目补充 supersedes 记录
      keeper.supersedes = [...new Set([...(keeper.supersedes ?? []), ...entries.slice(1).map((e) => e.memoryKey)])];
      keeper.note = `${keeper.note ?? ''} consolidate-${key}`;
      this.store.ledger.upsert(keeper);
    }
    return consolidated;
  }

  // ---------- promote(晋升为 Skill,能力进化 O5) ----------
  private runPromote(opts: EvolverOptions): string[] {
    const promoted: string[] = [];
    const byKey = new Map<string, EvolutionEntry[]>();
    for (const e of this.store.ledger.query({ kind: 'lesson' })) {
      if (e.triage === 'pending') continue;
      const k = e.patternKey ?? 'general.unknown';
      const arr = byKey.get(k) ?? [];
      arr.push(e);
      byKey.set(k, arr);
    }
    for (const [key, entries] of byKey) {
      const rep = entries.find((e) => e.triage !== 'pending');
      if (!rep) continue;
      const total = rep.reinforcementCount + rep.violationCount;
      if (rep.reinforcementCount < opts.minReinforcementForPromotion) continue;
      if (total > 0 && rep.violationCount / total > opts.maxViolationRateForPromotion) continue;
      // Skill 名:保留 ASCII 字母数字与中文,其余替换为连字符;防空/非法名回退 hash
      const raw = rep.patternKey ?? 'lesson';
      const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      const name = `lesson-${(slug || raw.slice(0, 8))}`;
      const skillPath = this.writeSkill(name, rep);
      promoted.push(skillPath);
    }
    return promoted;
  }

  private writeSkill(name: string, entry: EvolutionEntry): string {
    const dir = this.options().skillsDir ?? path.join(os.homedir(), '.dsh', 'skills');
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    // description 单行化(防 YAML frontmatter 解析挂掉)
    const safeDesc = (entry.patternKey ?? '经验教训技能')
      .replace(/\n/g, ' ')
      .replace(/[:：]/g, '：');
    const body = [
      `# ${safeDesc}`,
      '',
      '## 背景',
      `- 来源:教训库 patternKey=${entry.patternKey ?? '?'}(失败 ${entry.failureCount} 次)`,
      '',
      '## 规则',
      entry.contentHash.split(/\n+/).map((l) => `- ${l}`).join('\n'),
      '',
      '## 验证',
      `- 遵守率目标:reinforcement≥${this.options().minReinforcementForPromotion},违反率≤${Math.round(this.options().maxViolationRateForPromotion * 100)}%`,
    ].join('\n');
    const file = path.join(dir, name, 'SKILL.md');
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${safeDesc}\n---\n\n${body}\n`, 'utf-8');
    this.audit.debug('evolve', `promoted → ${file}`);
    return file;
  }

  // ---------- synthesize(会话整合, O2;M3 轻量版) ----------
  /** 把"日活跃教训命中汇总"压缩为一条 episodic 摘要(真实 M3 用轨迹,此版基于账本统计) */
  private async runSynthesize(): Promise<number> {
    const hit = this.store.ledger.query({ kind: 'lesson' }).filter((e) => e.hitCount > 0);
    if (hit.length === 0) return 0;
    const now = new Date().toISOString();
    const summary = hit
      .slice(0, 8)
      .map((e) => `[${e.patternKey ?? '?'}] 命中${e.hitCount}次/失败${e.failureCount}次: ${e.contentHash.slice(0, 60)}`)
      .join('\n');
    const ep = this.store.ledger.createEntry({
      content: `Episodic 会话整合(${now.slice(0, 10)}):\n${summary}`,
      kind: 'episodic',
      importance: 0.4,
      triage: 'acknowledged', // episodic 仅本地、无需人工分流
      note: 'source=evolver-synthesize',
    });
    this.store.ledger.upsert(ep);
    return 1;
  }

  // ---------- O2 增强:轨迹级会话整合(带 scenario/steps/pitfall/outcome) ----------
  /**
   * 把"一条真实任务轨迹"(turn/end 采集)压缩为 episodic 条目。
   * 输入:observer 缓存的关键事件摘要(可选);无轨迹时回落账本统计(m3 轻量)。
   * 输出:kind=episodic,内容含 scenario/steps/pitfall/outcome(150 字内意图)。
   */
  async synthesizeTrajectory(trajectory?: { scenario?: string; steps?: string[]; pitfall?: string; outcome?: string }): Promise<string> {
    const t = trajectory ?? {};
    const scenario = (t.scenario ?? 'general').slice(0, 40);
    const steps = (t.steps ?? []).slice(0, 4);
    const content = [
      `Episodic(${scenario})`,
      t.pitfall ? `坑:${t.pitfall.slice(0, 60)}` : '',
      `结果:${(t.outcome ?? 'unknown').slice(0, 40)}`,
      ...(steps.length ? ['步骤:', ...steps.map((s) => `- ${s.slice(0, 40)}`)] : []),
    ]
      .filter(Boolean)
      .join('\n');
    const ep = this.store.ledger.createEntry({
      content,
      kind: 'episodic',
      importance: 0.5,
      triage: 'acknowledged',
      note: 'source=evolver-synthesize-trajectory',
    });
    this.store.ledger.upsert(ep);
    this.audit.debug('evolve', `synthesize-trajectory → ${ep.memoryKey.slice(0, 8)}(${scenario})`);
    return ep.memoryKey;
  }

  // ---------- O5 黄金路径即时晋升(Golden-path Harvesting) ----------
  /**
   * 在任务成功(turn/end completed)且轨迹"尝试→修正→成功"时,即时生成 Skill 草案。
   * 判定:事件流含 ≥minCalls 次工具调用、首 tail 有 error 后最终 completed(goldenPath 启发式)。
   * 命中 → 写 Skill(若 autoUpdateSkills)或返回"待确认 Skill"草案供 /evolve --promote。
   */
  async harvestGoldenPath(input: {
    sessionId: string;
    scenario: string;
    toolCalls: number;
    hadFallback: boolean; // 轨迹含"试错→修正"信号
    success: boolean;
    autoUpdateSkills?: boolean;
  }): Promise<{ harvested: boolean; skillPath?: string; draft?: { name: string; rule: string } }> {
    if (!input.success) return { harvested: false };
    if (input.toolCalls < 3) return { harvested: false }; // 条件:≥3 次工具调用
    if (!input.hadFallback) return { harvested: false }; // 条件:存在试错→修正

    const rule = `当任务涉及「${input.scenario.slice(0, 40)}」时,先按已走通的路径执行(存在试错→修正信号),避免重复试错。`;
    if (input.autoUpdateSkills ?? false) {
      const name = `golden-${input.scenario.replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '-').slice(0, 24) || 'path'}`;
      const entry = this.store.ledger.createEntry({
        content: rule,
        kind: 'lesson', // golden path 本质是可复用做法,以 lesson 落账本
        patternKey: `golden.${input.scenario.slice(0, 12)}`,
        importance: 0.8,
        failureCount: 1,
        triage: 'acknowledged',
        note: `source=harvest-golden-path session=${input.sessionId.slice(0, 8)}`,
      });
      this.store.ledger.upsert(entry);
      const skillPath = this.writeSkill(name, entry);
      this.audit.debug('evolve', `harvest golden path → ${skillPath}`);
      return { harvested: true, skillPath };
    }
    // 不自动写 → 返回草案(供 /evolve --promote 或人工确认)
    return {
      harvested: true,
      draft: { name: 'golden-' + input.scenario.slice(0, 12), rule },
    };
  }
}