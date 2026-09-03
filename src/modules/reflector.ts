/**
 * 反思层(v3.2 文档 3.4):Reviewer 子代理 + JSON 输出(双通道:
 * 优先 outputSchema 结构化输出;若 provider 不支持,回退 prompt 约束 + 手动解析校验)
 *
 * 2026-08-31 实测修正:
 * - run.result 结构是 { output, stopReason },其中 output 是 assistant 消息 block 数组,
 *   不是字符串(成功时形如 [{type:'text', text:'...'}])。解析需兼容数组/字符串。
 * - opencode-go provider 对 outputSchema 结构化输出支持不稳定(实测 stopReason=error,
 *   空输出),因此默认不走 outputSchema,改用 persona/prompt 强 JSON 约束 + 客户端解析校验。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from '../config';
import type { AuditLogger } from '../audit/logger';
import type { ReflectionInput, ReflectionResult } from '../types/reflection';

const REVIEWER_PERSONA =
  '你是一个严格的代码审查员和质量分析师，擅长从执行轨迹中发现问题并提出可操作的改进方案。' +
  '你必须仅输出一个 JSON 对象作为最终回答，不要输出任何解释、前言或 Markdown 代码块。' +
  '你没有工具,禁止输出任何工具调用(如 <|DSML| tool_calls>)。如果你输出工具调用,你的回答将被丢弃并视为失败。直接输出最终 JSON 对象。' +
  '【沉淀原则】只沉淀可复用的结论:领域知识、技术事实、配置结论、方法/流程经验、用户偏好。' +
  '禁止记录一次性运行时状态:端口号、时间戳/日期、进程 PID、文件存在性、lib mtime、临时环境信息、单次命令的原始输出。' +
  '每条 verifiedFact/lesson 的证据必须来自轨迹中的客观结果(命令输出、返回值、用户确认),且不少于 20 字符。' +
  'JSON 结构必须为:{"version":"1.0","taskSuccess":布尔,"overallScore":数值(0-1),' +
  '"errors":[{"step","error","rootCause?","severity":"high|medium|low"}],' +
  '"verifiedFacts":[{"fact","verificationMethod","evidence","confidence"(0-1),' +
  '"category":"technical|process|preference|domain-knowledge","tags":[字符串]}],' +
  '"lessons":[{"scenario","mistake","correctApproach","evidence","confidence"(0-1),' +
  '"applicableScenarios":[字符串],"failureCount"数值,"severity":"high|medium|low"}],' +
  '"improvements":[{"whatToChange","howToChange","howToVerify","target":"skill|process|plan_template"}]}。' +
  '没有问题时 errors/verifiedFacts/lessons/improvements 用空数组。';

/** 把 run.result 的 output(block 数组或字符串)归一为纯文本 */
export function extractOutputText(output: unknown): string {
  if (typeof output === 'string') return output.trim();
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const block of output) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    return parts.join('\n').trim();
  }
  return '';
}

/** 从子代理 session 事件中提取失败详情(turn/end 的 reason.failure、error 类事件) */
export function extractChildError(child: any): string {
  try {
    const events: any[] = child?.session?.events ?? [];
    const tail = events.slice(-40);
    const pieces: string[] = [];
    const errText = (value: unknown): string =>
      typeof value === 'string' ? value : JSON.stringify(value);

    for (const ev of tail) {
      if (!ev || typeof ev !== 'object') continue;
      const data = ev.data ?? {};
      const reason = data.reason;
      const failure = data.failure ?? reason?.failure;
      const candidates: unknown[] = [failure?.message, failure?.error, reason?.message];
      for (const c of candidates) {
        if (c != null && String(c).trim()) {
          pieces.push(`[${ev.type}] ${errText(c).slice(0, 300)}`);
        }
      }
      if (ev.type === 'assistant/error' || ev.type === 'llm/error' || ev.type === 'request/error') {
        pieces.push(`[${ev.type}] ${JSON.stringify(data).slice(0, 400)}`);
      }
      // turn/end:完整打印 reason(blocked/aborted/error 的判定依据)
      if (ev.type === 'turn/end' && reason != null) {
        pieces.push(`[turn/end] reason=${JSON.stringify(reason).slice(0, 500)}`);
      }
    }
    if (pieces.length === 0) {
      const types = tail.map(e => e?.type).join(',');
      return `(未找到错误字段,事件序列: ${types.slice(0, 300)})`;
    }
    return pieces.join('\n').slice(0, 1500);
  } catch {
    return '(无法读取子代理事件)';
  }
}

export class ReflectorModule {
  constructor(
    private ctx: Context,
    private config: () => Config,
    private getAgent: () => any,
    private audit?: AuditLogger,
  ) {}

  /** 反思:拉起独立 Reviewer 子代理(spawn),输出解析 + 三审 */
  async reflect(input: ReflectionInput, _level: string, signal?: AbortSignal): Promise<ReflectionResult> {
    const agent = this.getAgent();
    if (!agent) {
      throw new Error('当前没有可用的 agent 引用(尚未观察到 agent/pre-step 事件)');
    }

    // start() 返回 run 对象(不是最终结果!),必须 await run.result 取结果
    const subagents: any = (this.ctx as any).subagents;
    if (!subagents?.start) throw new Error('subagents 服务不可用');

    // 重试:子代理输出工具调用/非 JSON 时重启一次(persona 强化约束)
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.reflectOnce(subagents, agent, input, signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = /工具调用|DSML|不是合法 JSON|返回空输出/.test(message);
        if (attempt >= maxAttempts || !retryable) throw error;
        this.audit?.debug('reflect-retry', `attempt=${attempt} 原因: ${message.slice(0, 200)}`);
      }
    }
    throw new Error('unreachable');
  }

  private async reflectOnce(subagents: any, agent: any, input: ReflectionInput, signal?: AbortSignal): Promise<ReflectionResult> {
    const subagentsStart: any = subagents;

    const run = await subagentsStart.start('spawn', {
      label: 'reviewer',

      // ⚠️ prompt 必须是 content block 数组(createUserMessage 的 content 形状),
      // 传字符串会导致子代理内部 message.content.map is not a function。
      // 官方 subagent 工具即:prompt: [{ type: 'text', text: args.prompt }]。
      prompt: [{ type: 'text', text: JSON.stringify(input) }],
      parent: agent,
      // ⚠️ signal 必须可用:startInProcessRun 第一行就访问 request.signal.aborted,
      // 自动触发路径(任务反思/用户纠错)不传 signal,缺省给默认 AbortController
      signal: signal ?? new AbortController().signal,
      // ⚠️ maxDepth 是"相对根的绝对深度":childDepth = parentDepth + 1 必须 <= maxDepth。
      // 自动反思可能在嵌套较深的子代理会话触达 depth 3-4,实测 maxDepth 3 会超限,
      // 取 8 宽裕兜底。防递归靠"reviewer 无工具 + 不主动开子代理",不靠 maxDepth 小。
      maxDepth: 32, // 放宽护栏:reviewer 无工具不会真递归,避免嵌套场景 depth 超限
      // 默认不走 outputSchema:当前 provider(opencode-go)结构化输出不稳定,
      // 改由 persona 强约束 + 下方 JSON.parse 校验(见文件头注释)。
      persona: REVIEWER_PERSONA,
      toolFilter: { allow: [] }, // Reviewer 不需要工具(对象类型,不是数组)
      // 继承 parent 的 provider/model(opencode-go + deepseek-v4-flash 已正常运行)
      // 不传 agentOptions 或传空对象时 child 完全继承 parent,避免 catalog 冲突导致路由到错误 provider
      agentOptions: {},
    });

    let settled;
    try {
      try {
        settled = await run.result;
      } finally {
        // 关键:释放子代理(防数量累积)
        await run?.dispose?.().catch?.((e: unknown) => this.audit?.debug('reflector', `dispose 失败: ${String(e)}`));
      }
    } catch (error) {
      // run.result 本身 reject:子代理基础设施/LLM 调用失败
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Reviewer 子代理底层失败: ${detail.slice(0, 500)}`);
    }
    if (!settled) throw new Error('Reviewer 子代理失败: run.result 为空');
    if (settled.stopReason === 'error') {
      const raw = extractOutputText(settled.output);
      const childDetail = extractChildError(run.localAgent);
      throw new Error(
        `Reviewer 子代理失败 (stopReason=error)${raw ? `, 输出: ${raw.slice(0, 300)}` : ''}\n` +
        `子代理事件详情:\n${childDetail}`,
      );
    }

    // 优先取"最后一条纯文本助手消息"(子代理可能先调工具再给 JSON);
    // 兜底用 run.result 的 output
    let output = extractFinalTextFromChild(run.localAgent);
    if (!output) output = extractOutputText(settled.output);
    if (!output) throw new Error('Reviewer 返回空输出');

    const parsed = extractJsonObject(output) as ReflectionResult | null;
    if (!parsed) {
      throw new Error(`Reviewer 输出不是合法 JSON。原文: ${output.slice(0, 300)}`);
    }

    return this.tripleCheck(parsed);
  }

  private childAgentOptions(): { provider?: string; model?: string } {
    // 空对象:子代理完全继承 parent 的 provider/model(parent opencode-go + deepseek-v4-flash 已正常运行)
    // 不显式覆盖,避免 opencode-go/deepseek catalog 冲突导致路由到错误 provider
    return {};
  }

  /** 三审(二审证据、三审置信度);一审由 JSON.parse + 结构约束在下方完成 */
  private tripleCheck(result: ReflectionResult): ReflectionResult {
    const cfg = this.config();
    const minEvidence = cfg.reflection.evidenceMinChars;
    const enoughEvidence = (evidence: string): boolean => (evidence ?? '').trim().length >= minEvidence;

    if (!Array.isArray(result.verifiedFacts)) result.verifiedFacts = [];
    if (!Array.isArray(result.lessons)) result.lessons = [];
    if (!Array.isArray(result.errors)) result.errors = [];

    result.verifiedFacts = result.verifiedFacts.filter(
      f => enoughEvidence(f.evidence) && f.confidence >= cfg.reflection.minConfidenceForFact,
    );
    result.lessons = result.lessons.filter(
      l => enoughEvidence(l.evidence) && l.confidence >= cfg.reflection.minConfidenceForLesson,
    );
    return result;
  }
}

/** 从子代理事件流中提取"最后一条纯文本 assistant 消息"(跳过含工具调用的消息) */
export function extractFinalTextFromChild(child: any): string {
  try {
    const events: any[] = child?.session?.events ?? [];
    let latestText = '';
    for (const ev of events) {
      if (!ev || ev.type !== 'assistant/message') continue;
      const blocks: any[] = ev.data?.message?.content;
      if (!Array.isArray(blocks)) continue;
      const texts: string[] = [];
      let hasToolCall = false;
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool-call' || block.type === 'tool_call') hasToolCall = true;
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      }
      if (texts.length > 0 && !hasToolCall) latestText = texts.join('\n').trim();
    }
    return latestText;
  } catch {
    return '';
  }
}

/** 从任意子代理文本中提取 JSON 对象(兼容 DSML 包裹/前后缀噪声) */
export function extractJsonObject(text: string): unknown | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
