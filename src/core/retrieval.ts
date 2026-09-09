/**
 * 统一检索/注入管线(v5.0 redesign 第 3.3 节;O6 双区注入)
 *
 * 从"任务意图"到"注入文本"的一条管线:
 *   ① 召回:账本内快筛(教训 kind + active + triage!=='pending')
 *   ② 覆盖:账本过滤由 LedgerBackend 天然保证(superseded/merged/archived 不 active)
 *   ③ 排序:score = 相关性 × (0.6 + 0.4×importance) × recencyBoost
 *   ④ 双区:核心区(coreZone,常驻高价值)+ 情境区(contextZone,任务相关);预算内
 *   ⑤ ack:注入块带"说明将如何应用"提示(enableAck)
 *
 * 检索只服务 active 且已确认(研究 GAP-3):pending 自动链路产物不注入。
 * 命中条目登记 hitCount(touch),供衰减/排序使用。
 */
import type { EvolutionEntry } from '../types/evolution';
import type { EvolutionLedger } from './ledger';

export interface RetrievalInput {
  /** 任务意图(最新 user 文本) */
  intent: string;
  /** 核心区候选(keyword/theme 命中,常驻高价值),缺省取重要性最高的教训 */
  coreZone?: string;
}

export interface RetrievalOptions {
  coreZoneMax: number;
  contextZoneMax: number;
  maxInjectionChars: number;
  maxItemChars: number;
  enableAck: boolean;
}

export interface InjectedLesson {
  memoryKey: string;
  zone: 'core' | 'context';
  patternKey?: string;
  importance: number;
  failureCount: number;
  text: string; // 脱敏后待注入文本
  score: number;
}

export interface InjectionBuild {
  /** 是否命中并生成注入块 */
  hit: boolean;
  lessons: InjectedLesson[];
  /** 待注入提示块(user 消息追加);无命中为空串 */
  block: string;
}

/** 双区注入文本模板 */
function lessonText(entry: EvolutionEntry, maxChars: number): string {
  // 优先用正确做法(correctApproach 语义即正式教训),无则回退 contentHash(全文摘要/教训正文)
  const raw =
    (entry.contentHash ?? '').trim().length > 0
      ? entry.contentHash
      : '';
  const base = raw || '请参考相关经验。';
  return base.length <= maxChars ? base : `${base.slice(0, maxChars)}…`;
}

/** 简单关键词/子串相关性(α 先薄:账本小,无需 embedding) */
function keywordScore(intent: string, entry: EvolutionEntry): number {
  const needle = intent.toLowerCase();
  if (!needle) return 0;
  const haystack = [
    entry.contentHash ?? '',
    entry.scenarios?.join(' ') ?? '',
    entry.patternKey ?? '',
    entry.category ?? '',
  ]
    .join(' ')
    .toLowerCase();
  // 精确子串 +0.6;任何词元(≥2 字符)命中 +0.4
  let score = 0;
  if (haystack.includes(needle)) score += 0.6;
  for (const token of needle.split(/\s+/).filter((t) => t.length >= 2)) {
    if (haystack.includes(token)) score += 0.4;
  }
  return score;
}

export class RetrievalPipeline {
  constructor(
    private ledger: EvolutionLedger,
    private options: () => RetrievalOptions,
  ) {}

  /** 主入口:意图 → 注入块(含核心区 + 情境区教训) */
  retrieve(input: RetrievalInput): InjectionBuild {
    const opts = this.options();
    // 候选:教训、active、已确认(非 pending)(GAP-3)
    const candidates = this.ledger
      .query({ kind: 'lesson' })
      .filter((e) => e.status === 'active' && e.triage !== 'pending');

    if (candidates.length === 0) {
      return { hit: false, lessons: [], block: '' };
    }

    // 相关分:关键词命中 + importance/failureCount 权重
    const scored = candidates
      .map((entry) => {
        const rel = keywordScore(input.intent, entry);
        // recency:lastSeen 越近越靠前(轻衰减:7 天内 +0.15)
        const recency =
          Date.now() - new Date(entry.lastSeen).getTime() < 7 * 86400_000 ? 0.15 : 0;
        const score = rel + (0.6 + 0.4 * entry.importance) * (1 + entry.failureCount) / 10 + recency;
        return { entry, rel, score };
      })
      .sort((a, b) => b.score - a.score);

    const lessons: InjectedLesson[] = [];
    let budget = opts.maxInjectionChars;

    // 核心区:high importance 教训(常驻,≥0.8 且 failureCount ≥ 1)—— 不要求关键词命中
    const coreCandidates = scored.filter(
      (s) => s.entry.importance >= 0.8 && s.entry.failureCount >= 1,
    );
    for (const { entry } of coreCandidates.slice(0, opts.coreZoneMax)) {
      const text = lessonText(entry, opts.maxItemChars);
      if (text.length + 8 > budget) break;
      budget -= text.length + 8;
      lessons.push({
        memoryKey: entry.memoryKey,
        zone: 'core',
        patternKey: entry.patternKey,
        importance: entry.importance,
        failureCount: entry.failureCount,
        text,
        score: 1,
      });
      this.ledger.touch(entry.memoryKey);
    }

    // 情境区:关键词命中(rel > 0)的任务相关教训
    const usedKeys = new Set(lessons.map((l) => l.memoryKey));
    for (const { entry, rel, score } of scored) {
      if (rel <= 0 || usedKeys.has(entry.memoryKey)) continue;
      if (lessons.length >= opts.coreZoneMax + opts.contextZoneMax) break;
      const text = lessonText(entry, opts.maxItemChars);
      if (text.length + 8 > budget) continue;
      budget -= text.length + 8;
      lessons.push({
        memoryKey: entry.memoryKey,
        zone: 'context',
        patternKey: entry.patternKey,
        importance: entry.importance,
        failureCount: entry.failureCount,
        text,
        score,
      });
      this.ledger.touch(entry.memoryKey);
    }

    if (lessons.length === 0) {
      return { hit: false, lessons: [], block: '' };
    }

    const block = this.buildBlock(lessons, input.intent, opts.enableAck);
    return { hit: true, lessons, block };
  }

  private buildBlock(lessons: InjectedLesson[], intent: string, enableAck: boolean): string {
    const lines = lessons.map((l, i) => {
      const tag = l.zone === 'core' ? '核心经验' : '相关经验';
      return `${i + 1}.【${tag}】${l.text}`;
    });
    let block = `【经验提醒(来自 MemOS 教训库)】\n${lines.join('\n')}`;
    if (enableAck) {
      block += `\n(如适用,请在本轮开头用一句话说明将如何应用以上经验。)`;
    }
    // 每次注入都带上意图,便于审计/调试
    block = `[意图: ${intent.slice(0, 40)}]\n${block}`;
    return block;
  }
}