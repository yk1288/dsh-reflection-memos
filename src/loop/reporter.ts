/**
 * 闭环度量/报告层(v5.0 redesign:loop/reporter.ts;O7 元优化)
 *
 * 让"自我进化"可量化:聚合账本 + 审计,产出指标与元优化建议。
 * 指标(对齐设计第 8 节验证标准):
 * - 记忆有效性:active 占比(目标 >70%)
 * - 教训遵守率:reinforcement/(reinforcement+violation)(目标 >60% 爬升)
 * - 教训复发率:violation/total(目标持续下降,4 周 <25%)
 * - 注入活跃:命中 hitCount 汇总(证明 M2 注入在用)
 * - 演化产品:merged(合并)、promoted Sk ill、episodic
 * - 元优化建议(O7):违反率高→加强/合并;pending 堆积→确认或调阈值;active 占比低→合并
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { EvolutionLedger } from '../core/ledger';

export interface LedgerHealthMetrics {
  total: number;
  active: number;
  activeRatio: number;
  pending: number;
  acknowledged: number;
  decayed: number;
  archived: number;
  merged: number;
  lessons: number;
  facts: number;
  episodic: number;
  inUseLessons: number;         // acknowledged + reinforcementCounter>0 的教训数
}

export interface LessonEffectMetrics {
  lessonTotal: number;
  injectedHits: number;          // 命中注入次数(hitCount 汇总)
  reinforcementSum: number;
  violationSum: number;
  complianceRate: number;        // 0..1;无记录时为 null
  recurrenceRate: number;        // 0..1;无记录时为 null
  topViolations: Array<{ patternKey: string; violations: number; failureCount: number; reinforcement: number }>;
}

export interface MemoryReport {
  generatedAt: string;
  health: LedgerHealthMetrics;
  lessons: LessonEffectMetrics;
  evolution: { consolidated: number; promotedSkills: string[]; skillsDir: string };
  recommendations: string[];
}

export class ReporterModule {
  constructor(
    private ledger: EvolutionLedger,
    private skillsDir: string = path.join(os.homedir(), '.dsh', 'skills'),
  ) {}

  /** 生成一份报告(纯读,无副作用) */
  report(): MemoryReport {
    const entries = this.ledger.all();
    const lessons = entries.filter((e) => e.kind === 'lesson');
    const facts = entries.filter((e) => e.kind === 'fact');
    const episodic = entries.filter((e) => e.kind === 'episodic');

    const health: LedgerHealthMetrics = {
      total: entries.length,
      active: entries.filter((e) => e.status === 'active').length,
      activeRatio: entries.length ? entries.filter((e) => e.status === 'active').length / entries.length : 0,
      pending: entries.filter((e) => e.triage === 'pending').length,
      acknowledged: lessons.filter((e) => e.triage !== 'pending').length,
      decayed: entries.filter((e) => e.status === 'decayed').length,
      archived: entries.filter((e) => e.status === 'archived').length,
      merged: entries.filter((e) => e.status === 'merged').length,
      lessons: lessons.length,
      facts: facts.length,
      episodic: episodic.length,
      inUseLessons: lessons.filter((e) => e.triage !== 'pending' || e.reinforcementCount > 0).length,
    };

    const re = lessons.reduce((s, e) => s + e.reinforcementCount, 0);
    const vi = lessons.reduce((s, e) => s + e.violationCount, 0);
    const hits = lessons.reduce((s, e) => s + e.hitCount, 0);
    const totalEffort = re + vi;
    const lessonMetrics: LessonEffectMetrics = {
      lessonTotal: lessons.length,
      injectedHits: hits,
      reinforcementSum: re,
      violationSum: vi,
      complianceRate: totalEffort > 0 ? re / totalEffort : null,
      recurrenceRate: totalEffort > 0 ? vi / totalEffort : null,
      topViolations: lessons
        .filter((e) => e.violationCount > 0)
        .sort((a, b) => b.violationCount - a.violationCount)
        .slice(0, 5)
        .map((e) => ({
          patternKey: e.patternKey ?? '?',
          violations: e.violationCount,
          failureCount: e.failureCount,
          reinforcement: e.reinforcementCount,
        })),
    };

    const promotedSkills = this.listPromotedSkills();
    const report: MemoryReport = {
      generatedAt: new Date().toISOString(),
      health,
      lessons: lessonMetrics,
      evolution: {
        consolidated: entries.filter((e) => e.status === 'merged').length,
        promotedSkills,
        skillsDir: this.skillsDir,
      },
      recommendations: [],
    };
    report.recommendations = this.buildRecommendations(report);
    return report;
  }

  /** 列出本插件晋升的 Skill(lesson-* 目录) */
  private listPromotedSkills(): string[] {
    try {
      if (!fs.existsSync(this.skillsDir)) return [];
      return fs
        .readdirSync(this.skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('lesson-'))
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  /** 元优化建议(O7):报告驱动插件自身调参方向的建议(人工确认后生效) */
  private buildRecommendations(r: MemoryReport): string[] {
    const recs: string[] = [];
    // 有效性
    if (r.health.activeRatio < 0.7 && r.health.total > 0) {
      recs.push(`记忆有效性 ${Math.round(r.health.activeRatio * 100)}% < 70%:建议运行 /evolve --consolidate 合并冗余,或确认 pending 教训(/lesson-confirm)。`);
    }
    // pending 堆积
    if (r.health.pending > 10) {
      recs.push(`有 ${r.health.pending} 条 pending 教训待确认:GAP-3 分流积压,建议批量 /lesson-confirm 或调低 reflection.autoReflectOnTaskComplete 频率。`);
    }
    // 遵守/复发
    if (r.lessons.complianceRate !== null && r.lessons.complianceRate < 0.6) {
      recs.push(`教训遵守率 ${Math.round(r.lessons.complianceRate * 100)}% < 60%:注入未充分被遵循,建议提高 coreZoneMax 或对高违反教训升级 severity。`);
    }
    if (r.lessons.recurrenceRate !== null && r.lessons.recurrenceRate > 0.25) {
      recs.push(`教训复发率 ${Math.round(r.lessons.recurrenceRate * 100)}% > 25%:同类错误仍高频,建议 /evolve --promote 将高频教训沉淀为 Skill。`);
    }
    // 违反最高项
    for (const t of r.lessons.topViolations.slice(0, 2)) {
      recs.push(`高风险教训「${t.patternKey}」已违反 ${t.violations} 次:建议人工复核其正确做法,或合并进 Skill(-promote)。`);
    }
    // 无记录
    if (r.lessons.reinforcementSum + r.lessons.violationSum === 0 && r.lessons.lessonTotal > 0) {
      recs.push(`暂无遵守/违反记录(需要 M2+/turn-end 验证钩子):可先观察注入(hitCount=${r.lessons.injectedHits})。`);
    }
    if (recs.length === 0) {
      recs.push('各项指标健康,无需调整。');
    }
    return recs;
  }

  /** 人类可读文本(命令输出用) */
  format(report: MemoryReport): string {
    const pct = (x: number | null): string => (x === null ? 'N/A' : `${Math.round(x * 100)}%`);
    return [
      `记忆质量报告(${report.generatedAt.slice(0, 19)}Z)`,
      `· 账本:${report.health.total} 条(fact ${report.health.facts} / lesson ${report.health.lessons} / episodic ${report.health.episodic})`,
      `· 有效性:active ${report.health.active}(${pct(report.health.activeRatio)}) | pending ${report.health.pending} | decayed ${report.health.decayed} | archived ${report.health.archived} | merged ${report.health.merged}`,
      `· 教训效果:注入命中 ${report.lessons.injectedHits} 次 | 遵守 ${report.lessons.reinforcementSum} / 违反 ${report.lessons.violationSum}`,
      `· 遵守率:${pct(report.lessons.complianceRate)} | 复发率:${pct(report.lessons.recurrenceRate)}(目标 遵守>60% / 复发<25%)`,
      `· 演化:合并 ${report.evolution.consolidated} | 晋升 Skill:${report.evolution.promotedSkills.length ? report.evolution.promotedSkills.join(', ') : '无'}`,
      ``,
      `【建议(元优化)】`,
      ...report.recommendations.map((s) => `  - ${s}`),
    ].join('\n');
  }
}