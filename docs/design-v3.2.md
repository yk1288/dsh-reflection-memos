DSH × MemOS 反思闭环架构设计文档 v3.2

> 版本：v3.2（代码级修正：修复 installSettingsSection 热更新模式、schemastery 默认导入、subagents.run.result 取结果、toolFilter 类型、outputSchema 约束、source 平台标识、模块事件总线）
> 日期：2026-08-31
> 前提：清空现有 MemOS 记忆，从零构建高质量记忆体系
> 目标栈：DeepSeek Harness (DSH) + MemOS Cloud 插件 + 自研反思插件
> 核心策略：读放开（memos-cloud 负责召回）、写收紧（反思闭环唯一写入入口）
> 写入方式：POST /add/message（异步） → 轮询 search/memory 验证入库

## v3.2 相对 v3.1 的修正清单（changelog）

1. **5.3 配置注册**：`installSettingsSection()` 真实实现**返回 void**（scope 是内部闭包变量），外部拿不到。改为官方模式：`setSource` 保存设置系统注入的配置 thunk，通过 `current()` 动态读取，支持配置热更新。
2. **5.3 schemastery 导入**：该包只有默认导出（`export { Schema as default }`），**没有命名导出 `z`**。统一 `import z from "@deepseek-ai/schemastery"`。
3. **3.4 反思层**：`ctx.subagents.start()` 返回 **run 对象**而非最终结果，必须 `await run.result` 获取 `{ stopReason, output }`；`toolFilter` 类型是 `{ allow?, deny? }` 对象，不是数组。
4. **3.4 outputSchema 约束**：subagents 仅接受 `type/properties/required/additionalItems/items/enum/const/oneOf` 结构，**禁止 pattern/format/numeric bounds（minimum/maximum 等）**，构造 schema 时注意。
5. **5.2 模块事件**：统一走 Cordis 事件总线（`ctx.emit` / `ctx.on`），与 6.1 事件表一致；对外服务命名 `reflectionMemos` 防冲突。
6. **source 字段**：对齐官方平台标识 `deepseek_harness_linux / _mac / _win`，不使用自定义字符串。

---

一、设计目标与核心原则

1.1 设计目标

1. 写入受控：所有写入 MemOS 的内容必须经过反思验证，从源头减少错误记忆
2. 召回保留：memos-cloud 插件的自动召回完全保留，不影响生产力
3. 自动纠错闭环：Agent 执行中发现错误，自动反思、自动沉淀、自动验证入库
4. 可追溯可审计：每条记忆有来源、有验证过程、有写入记录
5. 零侵入内核：基于 DSH 插件机制 + MemOS 公开 API 实现，不改内核

1.2 核心原则

- 写入两步走：add/message 异步提交 → 轮询 search/memory 验证入库，不假设写入即时可见
- 分层晋升：DSH Session Log（原始层）→ 插件本地候选（待验证层）→ MemOS（正式记忆层）
- 证据必选：每条写入候选必须附带可验证的证据，无证据不提交
- 渐进式构建：记忆随使用逐步积累，质量随时间提升
- 妥协说明：MemOS 服务端抽取不保证原样入库，"写入即正确"降级为"写入意图正确 + 入库后验证"

二、整体架构

2.1 五层闭环模型

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│   │  规划层   │───▶│  执行层   │───▶│  观察层   │              │
│   │ Plan     │    │ Execute  │    │ Observe  │              │
│   └──────────┘    └──────────┘    └────┬─────┘              │
│        ▲                               │                    │
│        │                               ▼                    │
│   ┌────┴─────┐                  ┌──────────┐                │
│   │  修正层   │◀─────────────────│  反思层   │                │
│   │ Refine   │                  │ Reflect  │                │
│   └──────────┘                  └──────────┘                │
│        │                                                     │
│        └──── 唯一写入通道：add/message + search 验证 ────┐    │
│                                                          ▼    │
│                     ┌───────────────────────────────────┐    │
│                     │    MemOS（纯净，从零构建）          │    │
│                     │  · 服务端自动抽取记忆               │    │
│                     │  · 召回：memos-cloud 插件负责       │    │
│                     └───────────────────────────────────┘    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

2.2 插件架构

```
dsh-reflection-memos（主插件）
├── module-planner      # 规划层：任务分解 + 成功标准（基于 DSH goal 机制）
├── module-executor     # 执行层：agent/pre-step + session/event 检查点
├── module-observer     # 观察层：session/event 采集 + 结果校验
├── module-reflector    # 反思层：subagents.spawn + outputSchema 强制 JSON
└── module-refiner      # 修正层：add/message 提交 + search 验证 + Skill 文件写入
```

依赖声明（Cordis 标准写法）：

```typescript
export const inject = [
  'agents',       // AgentRegistry：创建/恢复 Agent
  'sessions',     // Session 管理 + 事件流
  'commands',     // 斜杠命令注册
  'subagents',    // 子代理（Reviewer）
  'skills',       // Skill 注册表（只读）
  'goals',        // Goal 驱动（任务执行）
  'systemPrompt', // 系统提示词变量注入（记忆使用规则）
];
```

2.3 与现有插件的关系

| 插件                   | 职责                      | 交互方式                                                             |
| -------------------- | ----------------------- | ---------------------------------------------------------------- |
| memos-cloud          | 记忆召回（每轮自动检索） + 回合结束自动写入 | 关闭 `addEnabled`，保留 `recallEnabled`；本插件通过 API 直接调用 add/message 写入 |
| dsh-agent-loop       | Agent 主循环               | 通过 `agent/pre-step` 钩子缓存 agent 引用 + 注入检查点提示                      |
| dsh-session          | Session 管理 + 事件日志       | 监听 `session/event` 获取 tool/call、tool/result、turn/start、turn/end  |
| dsh-subagent         | 子代理能力                   | `ctx.subagents.start('spawn', request)` 拉起 Reviewer，`await run.result` 取结果 |
| dsh-skill-filesystem | Skill 文件管理              | 反思产出的新 Skill 写入 `~/.dsh/skills/` 目录，watcher 自动发现               |
| dsh-system-prompt    | 系统提示词                   | 通过 `ctx.systemPrompt.variable()` 注入记忆使用规则                        |

三、各层详细设计

3.1 规划层（Planner Module）

职责

任务执行前，将用户需求分解为可验证的子任务，每个子任务定义明确的成功标准。

实现方式

基于 DSH 的 `goals` 服务驱动任务执行。规划结果作为 goal 的 objective 输入。

- 轻量方案：使用 DSH 内置的 plan mode（`/plan` 命令）
- 增强方案：自研规划逻辑，输出结构化子任务列表，通过 `ctx.goals.create()` 驱动执行

数据结构

```typescript
interface TaskPlan {
  taskId: string;
  goal: string;
  subtasks: SubTask[];
}

interface SubTask {
  id: string;
  description: string;
  order: number;
  successCriteria: string[];
  checkpointType: 'auto' | 'manual' | 'tool-verify';
  dependsOn: string[];
}
```

触发方式

- 用户输入 `/plan-and-execute` 命令时触发
- 可配置：复杂任务（预计超过 N 步）自动进入规划模式

3.2 执行层（Executor Module）

职责

按规划执行任务，在关键节点插入检查点，不等到任务结束才发现错误。

实现方式

通过 DSH 的 `agent/pre-step` 钩子 + `session/event` 事件流插入检查逻辑：

| 钩子/事件                           | 用途                                                         |
| ------------------------------- | ---------------------------------------------------------- |
| `agent/pre-step`                | 每步执行前，从 `payload.agent` 获取 agent 引用并缓存；修改 messages 注入检查点提示 |
| `session/event` → `tool/result` | 工具返回时检查是否成功，失败则触发即时反思                                      |
| `session/event` → `turn/end`    | 回合结束时判断子任务是否完成，运行成功标准校验；根据 `reason.kind` 判断任务完成/失败   |
| `agent/error`                   | Agent 出错时捕获错误信息                                            |

早停机制：在 `session/event` 的 `tool/result` 或 `turn/end` 中判定子任务失败后，从 pre-step 缓存的 agent 引用调用 `agent.cancel({ kind: 'user', reason: 'Subtask verification failed' }, {})` 终止执行，触发即时反思。

检查点验证逻辑

- tool/result：检查工具调用是否成功（exit code、错误信息、返回数据格式）
- turn/end：检查当前回合是否完成了一个子任务
- 判定完成：`event.data.reason.kind === 'completed'` → 任务完成，触发任务反思
- 判定失败：`event.data.reason.kind === 'aborted'` 或 `'error'` → 深度反思

3.3 观察层（Observer Module）

职责

采集任务执行的全量数据，作为反思的事实依据。所有反思必须基于可验证的事实。

数据来源

全部来自 `session/event` 事件流（DSH 原生）：

| 事件类型                | 说明     | 用途               |
| ------------------- | ------ | ---------------- |
| `turn/start`        | 回合开始   | 记录轮次             |
| `turn/end`          | 回合结束   | 记录轮次结果，触发子任务完成判断 |
| `user/message`      | 用户消息   | 捕获用户反馈、纠错意图      |
| `assistant/message` | 助手回复   | 记录输出             |
| `tool/call`         | 工具调用发起 | 捕获调用参数           |
| `tool/result`       | 工具调用返回 | 捕获执行结果，判断成功/失败   |

事件对象结构：`{ seq, time, turn, type, data }`

采集与存储

- 实时采集：通过 `ctx.on('session/event', handler)` 监听事件流（handler 签名 `(session, event) => void`）
- 任务结束汇总：`turn/end` 且 `reason.kind === 'completed'` 触发汇总
- 本地存储：插件本地维护当前任务的轨迹缓存（内存 + 可选持久化到 `~/.dsh/reflection/`）

反思触发条件

| 触发条件   | 检测方式                                                                 | 反思级别     |
| ------ | -------------------------------------------------------------------- | -------- |
| 工具连续失败 | `session/event` → `tool/result` 中 error 连续 ≥ 2 次                     | 即时反思     |
| 用户纠错意图 | `session/event` → `user/message` 中匹配关键词                              | 即时反思     |
| 任务完成   | `session/event` → `turn/end` + `reason.kind === 'completed'`         | 任务反思     |
| 任务失败   | `session/event` → `turn/end` + `reason.kind === 'aborted' / 'error'` | 任务反思（深度） |
| 手动触发   | `/reflect` 命令                                                        | 按需       |
| 周期触发   | `ctx.setInterval`（Cordis 定时器）                                        | 周期反思     |

3.4 反思层（Reflector Module）

职责

分析执行轨迹，找出错误根因，生成可操作的改进方案。输出严格 JSON，通过 outputSchema 强制约束，不靠格式重试。

实现方式：Reviewer 子代理（spawn）

使用 `ctx.subagents.start('spawn', request)` 拉起独立的 Reviewer 子代理。

- 用 spawn 不用 fork：spawn 是 one-shot 全新上下文，审查更客观；fork 继承父代理上下文，不适合独立审查
- 用 outputSchema 不用重试：schema 强制 JSON 输出，比"格式不对重试"更可靠、更省 token

子代理启动方式（含结果获取）：

```typescript
import type { Context } from '@deepseek-ai/cordis';
import type { ReflectionInput, ReflectionResult } from '../types/reflection';

// 在 agent/pre-step 中缓存 agent 引用（payload.agent）
let currentAgent: any = null;
// ctx.on('agent/pre-step', (payload) => { currentAgent = payload.agent; });

/**
 * ⚠️ outputSchema 约束（subagents 内部 assertObjectJsonSchema 校验）：
 * 只允许 type / properties / required / additionalItems / items / enum / const / oneOf；
 * 禁止 pattern、format、minimum/maximum 等 numeric bounds。
 * 例如 OverallScore 只能写 { type: 'number' }，不能写 { type: 'number', minimum: 0, maximum: 1 }。
 */
export async function runReviewer(
  ctx: Context,
  input: ReflectionInput,
  signal?: AbortSignal,
): Promise<ReflectionResult> {
  if (!currentAgent) throw new Error('currentAgent is null: no agent/pre-step observed yet');

  // start() 返回 run 对象（不是最终结果！）
  const run = await ctx.subagents.start('spawn', {
    label: 'reviewer',
    prompt: JSON.stringify(input),       // 反思输入序列化后传入
    parent: currentAgent,                 // 触发反思的 agent（从 pre-step 缓存获取）
    signal,                               // 传入调用方 AbortSignal，便于超时终止
    maxDepth: 1,                          // 只允许一层，防止递归
    outputSchema: reflectionSchema,       // 用 schema 强制 JSON 输出
    persona: '你是一个严格的代码审查员和质量分析师，擅长从执行轨迹中发现问题并提出可操作的改进方案。输出必须严格遵循给定的 JSON Schema。',
    toolFilter: { allow: [] },            // 对象类型 { allow?, deny? }，禁止全部工具
    agentOptions: {},                     // 可选 { provider?, model?, maxTokens? }
  });

  // 关键：取结果的唯一方式 —— await run.result
  const { stopReason, output } = await run.result;
  if (stopReason === 'error') throw new Error('Reviewer 子代理失败');

  return JSON.parse(output) as ReflectionResult;  // outputSchema 保证是合法 JSON
}
```

反思输入

```typescript
interface ReflectionInput {
  taskGoal: string;
  successCriteria: string[];
  trajectorySummary: string;   // 执行轨迹摘要（控制 token）
  keyEvents: KeyEvent[];       // 关键事件（工具调用、错误、用户反馈）
  userFeedback?: string;       // 用户纠错内容（如有）
}
```

反思输出契约（严格 JSON，由 outputSchema 强制）

```typescript
interface ReflectionResult {
  version: '1.0';
  taskSuccess: boolean;
  overallScore: number;  // 0-1（schema 中只能 type:'number'，不能写数值边界）

  errors: ErrorAnalysis[];

  // 可提交到 MemOS 的验证事实
  verifiedFacts: VerifiedFact[];

  // 可提交到 MemOS 的教训
  lessons: Lesson[];

  // 改进建议（Skill / 流程 / 规划模板）
  improvements: Improvement[];
}

interface VerifiedFact {
  fact: string;
  verificationMethod: string;
  evidence: string;
  confidence: number;  // 0-1
  category: 'technical' | 'process' | 'preference' | 'domain-knowledge';
  tags: string[];
}

interface Lesson {
  scenario: string;
  mistake: string;
  correctApproach: string;
  evidence: string;
  confidence: number;
  applicableScenarios: string[];
  failureCount: number;
  severity: 'high' | 'medium' | 'low';
}

interface Improvement {
  whatToChange: string;
  howToChange: string;
  howToVerify: string;
  target: 'skill' | 'process' | 'plan_template';
}
```

反思质量控制（三审）

- 一审（格式）：由 `outputSchema` 在子代理侧强制保证，不通过则子代理直接报错
- 二审（证据）：每条结论必须有 evidence 字段，且长度 ≥ 20 字符，无证据 → 不采纳
- 三审（置信度）：fact 低于 0.8、lesson 低于 0.7 → 不提交 MemOS

3.5 修正层（Refiner Module）

职责

MemOS 写入的唯一入口。将反思结果转化为实际动作：异步提交 → 轮询验证 → 确认入库。

写入流程（两步）

```
反思产出 verifiedFacts / lessons
        ↓
一审：格式校验（outputSchema 已保证）
        ↓
二审：证据校验（有证据、证据充分）
        ↓
三审：置信度校验（fact ≥ 0.8, lesson ≥ 0.7）
        ↓
构造 add/message 请求（user 消息 + tags + info 字符串值）
        ↓
POST /add/message（async_mode: true，异步提交）
        ↓
轮询验证：POST /search/memory（指数退避，3s→5.4s→9.7s→…，最多 5 次）
        ↓
topResult.relativity >= 0.6 → 入库成功 → 记入审计日志
全部轮询未命中 → 入库失败 → 记入失败日志
```

关键说明：

- `async_mode: true` 是官方默认，服务端异步处理消息
- 用 `search/memory` 的轮询结果当"完成信号"
- 验证标准：搜索命中且第一条的 `relativity >= 0.6`
- info 字段的值必须是非空字符串，数字要转 `String()`
- `source` 字段对齐官方平台标识（见 client.ts 中的 memosSource()）

MemOS API 封装（基于真实端点 + 真实响应结构）

```typescript
// src/memos/client.ts

/** source 字段与官方 memos-cloud core 保持一致（平台标识） */
function memosSource(platform = process.platform) {
  if (platform === 'win32') return 'deepseek_harness_win';
  if (platform === 'darwin') return 'deepseek_harness_mac';
  return 'deepseek_harness_linux';
}

export class MemOSWriter {
  private baseUrl: string;
  private apiKey: string;
  private userId: string;  // 必须复用 memos-cloud 配置中的 userId

  constructor(config: {
    baseUrl: string;
    apiKey: string;
    userId: string;
  }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.userId = config.userId;
  }

  /**
   * 提交验证事实到 MemOS（异步）
   * 返回 taskId，后续用 search 验证入库
   */
  async submitVerifiedFact(fact: VerifiedFact): Promise<{ taskId?: string; success: boolean }> {
    const content = this.buildFactMessage(fact);

    const res = await fetch(`${this.baseUrl}/add/message`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        user_id: this.userId,
        conversation_id: 'dsh:reflection',  // 固定，保持上下文连续（≤100 字符）
        messages: [
          { role: 'user', content }
        ],
        source: memosSource(),
        async_mode: true,  // 异步，search 验证当完成信号
        allow_public: false,
        tags: [
          'verified_fact',
          `category:${fact.category}`,
          'deepseek-harness',
          ...fact.tags,
        ],
        info: {
          // info 值必须是非空字符串！数字一律 String()
          verification_method: fact.verificationMethod,
          confidence: String(fact.confidence),
          source: 'dsh-reflection-memos',
          version: '1.0',
          category: fact.category,
        }
      })
    });

    const data = await res.json();
    // 响应信封：{ code, message, data }，data 内含 task_id/status/success
    if (data.code !== 0 && data.code !== 200) {
      throw new Error(`MemOS add/message failed: ${data.message || JSON.stringify(data)}`);
    }

    return {
      success: true,
      taskId: data.data?.task_id || data.task_id,
    };
  }

  /**
   * 验证记忆是否真的入库了
   * 轮询 search/memory，命中且 top relativity >= 阈值视为入库
   */
  async verifyIngestion(
    factContent: string,
    options?: {
      maxRetries?: number;
      initialDelayMs?: number;
      backoffFactor?: number;
      minRelativity?: number;
    }
  ): Promise<boolean> {
    const maxRetries = options?.maxRetries ?? 5;
    const initialDelayMs = options?.initialDelayMs ?? 3000;
    const backoffFactor = options?.backoffFactor ?? 1.8;
    const minRelativity = options?.minRelativity ?? 0.6;

    let delay = initialDelayMs;

    for (let i = 0; i < maxRetries; i++) {
      await this.sleep(delay);
      delay = Math.floor(delay * backoffFactor);

      const memories = await this.searchMemory(factContent, {
        limit: 3,
        relativity: 0.4,  // 低阈值搜，回来再判断
      });

      if (memories.length === 0) continue;

      // 真实响应条目带 relativity 字段
      const top = memories[0];
      if (top.relativity != null && top.relativity >= minRelativity) {
        return true;
      }
    }

    return false;
  }

  /**
   * 提交教训记忆
   */
  async submitLesson(lesson: Lesson): Promise<{ taskId?: string; success: boolean }> {
    const content = this.buildLessonMessage(lesson);

    const res = await fetch(`${this.baseUrl}/add/message`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        user_id: this.userId,
        conversation_id: 'dsh:reflection',
        messages: [{ role: 'user', content }],
        source: memosSource(),
        async_mode: true,
        allow_public: false,
        tags: [
          'lesson_learned',
          'deepseek-harness',
          ...lesson.applicableScenarios.map(s => `scenario:${s}`),
        ],
        info: {
          // info 值必须是非空字符串
          failure_count: String(lesson.failureCount),
          severity: lesson.severity,
          confidence: String(lesson.confidence),
          source: 'dsh-reflection-memos',
        }
      })
    });

    const data = await res.json();
    if (data.code !== 0 && data.code !== 200) {
      throw new Error(`MemOS add/message failed: ${data.message}`);
    }

    return {
      success: true,
      taskId: data.data?.task_id || data.task_id,
    };
  }

  /**
   * 搜索记忆（用于查重、验证）
   * 真实响应结构：data.memory_detail_list[]
   * 条目字段：memory_key / memory_value / relativity 等
   */
  async searchMemory(query: string, options?: {
    limit?: number;
    relativity?: number;
    filter?: Record<string, any>;  // 嵌套对象：{ user: { tags: { contains: 'xxx' } } }
  }): Promise<Array<{
    memory_key: string;
    memory_value: string;
    relativity?: number;
    [key: string]: any;
  }>> {
    const res = await fetch(`${this.baseUrl}/search/memory`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        user_id: this.userId,
        query,
        memory_limit_number: options?.limit ?? 5,
        relativity: options?.relativity ?? 0.5,
        filter: options?.filter,
      })
    });

    const data = await res.json();
    // 真实字段：data.memory_detail_list（不是 data.memories）
    const list = data.data?.memory_detail_list ?? [];
    return list;
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Token ${this.apiKey}`,
    };
  }

  private buildFactMessage(fact: VerifiedFact): string {
    return `我确认一个事实：${fact.fact}。` +
      `验证方法：${fact.verificationMethod}。` +
      `证据：${fact.evidence}。` +
      `置信度：${(fact.confidence * 100).toFixed(0)}%。` +
      `分类：${fact.category}。` +
      `标签：verified_fact, category:${fact.category}, ${fact.tags.join(', ')}。`;
  }

  private buildLessonMessage(lesson: Lesson): string {
    return `我学到了一个教训：在${lesson.scenario}场景下，` +
      `不要${lesson.mistake}，` +
      `正确做法是${lesson.correctApproach}。` +
      `证据：${lesson.evidence}。` +
      `这是第${lesson.failureCount}次遇到同类问题。` +
      `严重程度：${lesson.severity}。` +
      `标签：lesson_learned, ${lesson.applicableScenarios.map(s => `scenario:${s}`).join(', ')}。`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

教训去重与递增逻辑

```typescript
// 写入教训前先查重
async function processLesson(
  lesson: Lesson,
  writer: MemOSWriter,
  minFailures: number
): Promise<{ submitted: boolean; reason?: string }> {
  // 1. 搜索是否已有同类教训（嵌套 filter 语法）
  const existing = await writer.searchMemory(lesson.scenario, {
    limit: 5,
    relativity: 0.5,
    filter: {
      user: {
        tags: {
          contains: 'lesson_learned'
        }
      }
    }
  });

  // 2. 匹配已有教训（从 memory_value 中解析 failureCount）
  const matched = findMatchingLesson(existing, lesson);

  if (matched) {
    // 已有，递增 failureCount
    lesson.failureCount = matched.failureCount + 1;
  } else if (lesson.failureCount < minFailures) {
    // 没有，且失败次数未达阈值，不写入
    return { submitted: false, reason: `Failure count ${lesson.failureCount} below threshold ${minFailures}` };
  }

  // 3. 提交新版本（MemOS 没有 update 接口，只能新增）
  const result = await writer.submitLesson(lesson);
  return { submitted: result.success };
}
```

关于版本管理的妥协：MemOS 公开 API 没有 update/delete 端点，"版本递增"只能通过新增一条内容来实现。旧版本仍然会被召回，缓解方式：

1. 新版本内容中明确写"此为 v2 版本，替代 v1"
2. 系统提示词中加规则：同主题下优先选择更新的记忆
3. 定期通过 MemOS Dashboard 手动清理旧版本

Skill 更新机制

Skill 不写 MemOS，写本地文件系统：

```typescript
// src/skill/manager.ts
import * as fs from 'fs';
import * as path from 'path';

export class SkillManager {
  private skillsDir: string;  // ~/.dsh/skills/

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  /**
   * 创建新 Skill
   * 写入 ~/.dsh/skills/<name>/SKILL.md
   * dsh-skill-filesystem 的 watcher 会自动发现
   */
  createSkill(name: string, description: string, body: string): void {
    const skillDir = path.join(this.skillsDir, name);
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    // description 必须单行化，防止 YAML frontmatter 解析挂掉
    const safeDescription = description.replace(/\n/g, ' ').replace(/:/g, '：');

    const skillContent = `---
name: ${name}
description: ${safeDescription}
---

${body}
`;

    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent, 'utf-8');

    // 注意：依赖文件系统 watcher 自动发现，有延迟（通常几秒）
    // 如果 dsh-skill-filesystem 暴露了缓存失效 API，可主动调用
  }

  /**
   * 更新已有 Skill（覆盖 SKILL.md，watcher 同样能发现变更）
   */
  updateSkill(name: string, newBody: string): void {
    const skillPath = path.join(this.skillsDir, name, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      fs.writeFileSync(skillPath, newBody, 'utf-8');
    }
  }
}
```

四、MemOS 记忆体系设计（从零构建）

4.1 记忆标签体系（通过 add/message 的 tags 字段传入）

| 标签                 | 含义        | 说明                                           |
| ------------------ | --------- | -------------------------------------------- |
| `verified_fact`    | 经过验证的事实记忆 | 反思闭环写入                                       |
| `lesson_learned`   | 经验教训记忆    | 反思闭环写入                                       |
| `deepseek-harness` | 来源：DSH    | 官方默认标签，便于按来源过滤统计                             |
| `category:xxx`     | 知识分类      | category:automotive / category:programming 等 |
| `scenario:xxx`     | 适用场景（教训类） | scenario:bluetooth-test 等                    |

4.2 记忆质量等级

| 等级       | 置信度范围      | 标签              | 说明        |
| -------- | ---------- | --------------- | --------- |
| A 级（确定）  | ≥ 0.9      | `verified_fact` | 有明确工具验证结果 |
| B 级（高可信） | 0.8 - 0.89 | `verified_fact` | 有证据但非直接验证 |
| C 级（待验证） | < 0.8      | 不写 MemOS        | 只在插件本地保留  |

4.3 召回配置（在 memos-cloud 的 settings.yaml 中配置）

召回由 memos-cloud 插件负责，本插件不接管。以下是建议配置：

```yaml
memos-cloud:
  # 召回开启
  recallEnabled: true

  # 写入关闭（由反思闭环接管写入）
  addEnabled: false

  # 召回数量（默认 6，可调到 8，上限 25）
  memoryLimitNumber: 8

  # 偏好记忆数量
  preferenceLimitNumber: 3

  # 工具记忆（关闭 addEnabled 后工具记忆也不写入，但召回仍保留已有）
  includeToolMemory: true
  toolMemoryLimitNumber: 3

  # 相关性阈值（官方默认 0.45，可根据实测调整）
  relativity: 0.5

  # API 配置
  apiKeyEnv: MEMOS_API_KEY
  userId: yk  # 必须与反思插件一致

  # 超时与重试（对齐官方默认）
  timeoutMs: 5000
  searchRetries: 1
  addRetries: 0
```

关于"verified_fact 优先"的限制：`/search/memory` 不支持按标签排序，召回排序由 MemOS 内部的相关性算法决定。只能通过以下方式间接提升：

1. 提高高质量记忆的内容质量，让相关性算法自然排在前面
2. 在系统提示词中加规则：召回的记忆中，优先使用带 `verified_fact` 标签的
3. 使用 `filter: { user: { tags: { contains: 'verified_fact' } } }` 做包含过滤（但会减少召回量）

五、插件结构与开发规范

5.1 目录结构

```
dsh-reflection-memos/
├── src/
│   ├── index.ts              # 插件入口：inject + apply + 配置热更新
│   ├── config.ts             # 配置 Schema + settings 注册（current() 热更新模式）
│   ├── modules/
│   │   ├── planner.ts        # 规划层
│   │   ├── executor.ts       # 执行层钩子
│   │   ├── observer.ts       # 观察层：事件采集
│   │   ├── reflector.ts      # 反思层：子代理审查
│   │   └── refiner.ts        # 修正层：MemOS 写入 + Skill 管理
│   ├── memos/
│   │   └── client.ts         # MemOS API 封装（add/message + search）
│   ├── skill/
│   │   └── manager.ts        # Skill 文件写入管理
│   ├── prompts/
│   │   ├── reviewer-persona.md
│   │   └── reflection-schema.ts  # 反思输出 JSON Schema（z.object，注意 outputSchema 约束）
│   ├── types/
│   │   ├── reflection.ts     # 反思相关类型
│   │   └── memory.ts         # 记忆相关类型
│   ├── commands/
│   │   └── index.ts          # 斜杠命令注册
│   └── audit/
│       └── logger.ts         # 审计日志（本地文件）
├── cordis.patch.yml
├── package.json
├── tsconfig.json
└── README.md
```

5.2 插件入口（标准 Cordis 写法 + 配置热更新 + 事件总线）

```typescript
// src/index.ts
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config';
import { installSettings, getConfig } from './config';
import { PlannerModule } from './modules/planner';
import { ExecutorModule } from './modules/executor';
import { ObserverModule } from './modules/observer';
import { ReflectorModule } from './modules/reflector';
import { RefinerModule } from './modules/refiner';
import { registerCommands } from './commands';

export const name = 'dsh-reflection-memos';

// 依赖声明
export const inject = [
  'agents',
  'sessions',
  'commands',
  'subagents',
  'skills',
  'goals',
  'systemPrompt',
];

// 模块实例（供热更新引用）
let planner: PlannerModule | null = null;
let executor: ExecutorModule | null = null;
let observer: ObserverModule | null = null;
let reflector: ReflectorModule | null = null;
let refiner: RefinerModule | null = null;

export function apply(ctx: Context, initialConfig: Config) {
  // 注册设置面板；配置热更新通过 getConfig() 动态读取（见 5.3）
  installSettings(ctx, initialConfig);

  // 动态读取配置的函数（模块内用 () => getConfig()，而非固定值）
  const config = () => getConfig();

  // 注入记忆使用规则到系统提示词（第二参数是 (context) => string 函数）
  ctx.systemPrompt.variable('memoRules', () => `
【记忆使用规则】
你在回答问题时会收到系统注入的记忆（来自 MemOS 长期记忆），请按以下规则使用：

1. 记忆分级：
   - 带「verified_fact」标签的记忆：经过验证的事实，置信度高，可直接引用
   - 带「lesson_learned」标签的记忆：经验教训，务必遵守，避免重复踩坑
   - 不带上述标签的记忆：普通记忆，引用时注意验证

2. 优先级：
   - 同主题下，优先使用带 verified_fact 标签的记忆
   - 同主题下有多条记忆时，优先使用时间更新的
   - 教训记忆优先级高于普通事实记忆

3. 验证义务：
   - 涉及关键参数、配置、命令时，即使有 verified_fact 记忆，也建议通过工具二次确认
   - 如果发现记忆与实际结果不符，立即触发反思流程
`);

  // 初始化各模块（传入 config 读取函数，支持热更新）
  planner = new PlannerModule(ctx, config);
  executor = new ExecutorModule(ctx, config);
  observer = new ObserverModule(ctx, config);
  reflector = new ReflectorModule(ctx, config);
  refiner = new RefinerModule(ctx, config);

  // 模块间事件：统一走 Cordis 事件总线（模块内部用 ctx.emit 发出，
  // 与 6.1 事件表一致；不要各自实现 EventEmitter）
  ctx.on('reflection/task-complete', (obs) => {
    if (config().reflection.enableTaskReflection) {
      reflector!.reflect(obs, 'task').then(result => {
        refiner!.processReflectionResult(result);
      });
    }
  });

  ctx.on('reflection/subtask-failed', (obs) => {
    if (config().reflection.enableImmediateReflection) {
      reflector!.reflect(obs, 'immediate').then(result => {
        refiner!.processReflectionResult(result);
      });
    }
  });

  ctx.on('reflection/user-correction', (msg) => {
    if (config().reflection.enableImmediateReflection) {
      reflector!.reflectOnUserCorrection(msg).then(result => {
        refiner!.processReflectionResult(result);
      });
    }
  });

  // 注册命令
  registerCommands(ctx, () => reflector!, () => refiner!, () => observer!);

  // 周期反思（默认关闭，使用 ctx.setInterval）
  if (config().reflection.enablePeriodicReflection) {
    ctx.setInterval(
      () => {
        observer!.collectRecentHistory().then(history => {
          reflector!.reflect(history, 'periodic').then(result => {
            refiner!.processReflectionResult(result);
          });
        });
      },
      config().reflection.periodicIntervalHours * 60 * 60 * 1000
    );
  }

  // 暴露服务（用带前缀的名字，避免与其他插件撞名）
  ctx.provide('reflectionMemos', {
    reflect: (obs: any, level: string) => reflector!.reflect(obs, level),
    getAuditLog: () => refiner!.getAuditLog(),
    getStats: () => observer!.getStats(),
  });

  ctx.logger.info('dsh-reflection-memos loaded');
}
```

5.3 配置注册（@deepseek-ai/schemastery + installSettingsSection，current() 热更新模式）

```typescript
// src/config.ts
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';  // ⚠️ 只有默认导出，没有命名导出 z
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';

export const ConfigSchema = z.object({
  memos: z.object({
    baseUrl: z.string().description('MemOS API 地址'),
    apiKeyEnv: z.string().description('API Key 环境变量名'),
    userId: z.string().description('用户 ID（必须与 memos-cloud 一致）'),
  }),
  reflection: z.object({
    enableImmediateReflection: z.boolean().description('启用即时反思'),
    enableTaskReflection: z.boolean().description('启用任务结束反思'),
    enablePeriodicReflection: z.boolean().description('启用周期反思'),
    periodicIntervalHours: z.number().description('周期反思间隔（小时）'),
    minConfidenceForFact: z.number().description('事实记忆最低置信度'),
    minConfidenceForLesson: z.number().description('教训记忆最低置信度'),
    requireEvidence: z.boolean().description('必须有证据'),
    maxReflectionRetries: z.number().description('反思最大重试次数'),
  }),
  refiner: z.object({
    writeVerifiedFacts: z.boolean().description('写入验证事实'),
    writeLessons: z.boolean().description('写入教训'),
    autoUpdateSkills: z.boolean().description('自动更新 Skill'),
    minFailuresForLesson: z.number().description('写入教训的最少失败次数'),
    verifyIngestion: z.boolean().description('验证记忆是否入库'),
    maxVerifyRetries: z.number().description('入库验证最大重试次数'),
    maxMemoriesPerDay: z.number().description('每日最大写入数'),
  }),
  performance: z.object({
    asyncReflection: z.boolean().description('异步反思（不阻塞对话）'),
    reflectionTimeoutMs: z.number().description('反思超时（毫秒）'),
    addTimeoutMs: z.number().description('add/message 超时（毫秒）'),
    searchTimeoutMs: z.number().description('search/memory 超时（毫秒）'),
  }),
});

export type Config = typeof ConfigSchema.T;

// 配置源 thunk：由 installSettingsSection 的 setSource 注入，
// 之后所有读取走 current()，实现配置热更新
let current: () => Config = () => ({} as Config);

export function installSettings(ctx: Context, defaultConfig: Config) {
  // ⚠️ installSettingsSection 返回 void（scope 在内部闭包中，外部拿不到）！
  // 正确姿势：保存 setSource 传入的 thunk，之后用 getConfig() / current() 读取。
  installSettingsSection(
    ctx,
    settingsNamespace('dsh-reflection-memos'),
    ConfigSchema,
    defaultConfig,
    {
      // setSource 是"设置系统把指向已解析配置的 thunk 交给我们保存"，不是我们提供 getter
      setSource: (source) => { current = source; },
      onChange: () => {
        ctx.logger.info('Reflection config updated');
      },
      // validate 通过 throw 拒绝；返回值被忽略
      validate: (value: Config) => {
        if (!value.memos.userId || value.memos.userId.trim() === '') {
          throw new Error('userId 不能为空，必须与 memos-cloud 配置一致');
        }
      },
    }
  );
}

/** 动态读取当前（含用户设置覆盖）的配置 */
export function getConfig(): Config {
  return current();
}
```

5.4 命令注册

```typescript
// src/commands/index.ts
import type { Context } from '@deepseek-ai/cordis';
import type { ReflectorModule } from '../modules/reflector';
import type { RefinerModule } from '../modules/refiner';
import type { ObserverModule } from '../modules/observer';

export function registerCommands(
  ctx: Context,
  getReflector: () => ReflectorModule,
  getRefiner: () => RefinerModule,
  getObserver: () => ObserverModule,
) {
  // /reflect：手动触发反思
  ctx.commands.register({
    name: 'reflect',
    description: '手动触发对当前任务的反思，提炼经验写入 MemOS',
    input: { hint: '可选：指定反思范围' },
    handler: async (invocation) => {
      const observer = getObserver();
      const reflector = getReflector();
      const refiner = getRefiner();

      const observation = observer.collectCurrentObservation();
      // 反思子代理可传入 invocation.signal，便于命令取消/超时终止
      const result = await reflector.reflect(observation, 'manual', invocation.signal);
      const summary = await refiner.processReflectionResult(result);

      return {
        kind: 'success' as const,
        text: `反思完成。\n` +
          `- 发现问题：${result.errors.length} 个\n` +
          `- 验证事实：${result.verifiedFacts.length} 条\n` +
          `- 经验教训：${result.lessons.length} 条\n` +
          `- 成功入库：${summary.ingestedCount} 条\n` +
          `- 入库失败：${summary.failedCount} 条`,
      };
    },
  });

  // /plan-and-execute：先规划再执行
  ctx.commands.register({
    name: 'plan-and-execute',
    description: '先规划任务再执行，完成后自动反思沉淀',
    input: { hint: '任务描述' },
    handler: async (invocation) => {
      // 调用 planner 生成计划，通过 goals 驱动执行
      return {
        kind: 'success' as const,
        text: '任务已启动，执行完成后将自动反思。',
      };
    },
  });

  // /memos-stat：记忆统计
  ctx.commands.register({
    name: 'memos-stat',
    description: '查看反思闭环的记忆统计',
    handler: async () => {
      const stats = getRefiner().getStats();
      return {
        kind: 'success' as const,
        text:
          `反思闭环记忆统计：\n` +
          `- 总提交数：${stats.totalSubmitted}\n` +
          `- 成功入库：${stats.totalIngested}\n` +
          `- 入库失败：${stats.totalFailed}\n` +
          `- 今日写入：${stats.todayWritten}\n` +
          `- 事实记忆：${stats.factCount} 条\n` +
          `- 教训记忆：${stats.lessonCount} 条`,
      };
    },
  });
}
```

六、事件流设计

6.1 自定义事件（由本插件 emit，走 Cordis 事件总线 ctx.emit / ctx.on）

| 事件名                          | 触发时机       | 携带数据                   | 说明                            |
| ---------------------------- | ---------- | ---------------------- | ----------------------------- |
| `reflection/task-complete`   | 任务完成时      | `ExecutionObservation` | observer 模块 emit，reflector 监听 |
| `reflection/subtask-failed`  | 子任务失败时     | `SubTaskResult`        | observer 模块 emit，reflector 监听 |
| `reflection/user-correction` | 用户纠错时      | `{ message: string }`  | observer 模块 emit，reflector 监听 |
| `reflection/done`            | 反思完成时      | `ReflectionResult`     | reflector 模块 emit，refiner 监听  |
| `refiner/memory-written`     | 记忆写入完成     | `MemoryWriteResult`    | refiner 模块 emit               |
| `refiner/skill-updated`      | Skill 更新完成 | `SkillUpdateResult`    | refiner 模块 emit               |

6.2 真实来源事件（DSH 原生）

| 事件源     | 事件名              | 用途                                                                             |
| ------- | ---------------- | ------------------------------------------------------------------------------ |
| agent   | `agent/pre-step` | 缓存 agent 引用 + 注入检查点提示                                                          |
| agent   | `agent/error`    | Agent 出错捕获                                                                     |
| agent   | `agent/status`   | Agent 状态变化                                                                     |
| session | `session/event`  | 明细事件流：turn/start、turn/end、user/message、assistant/message、tool/call、tool/result |

七、系统提示词规则注入

记忆使用规则通过 `ctx.systemPrompt.variable()` 注入，不走 `agent/pre-step`（pre-step 只能改 messages，改不了 system prompt）。

注入位置：见 5.2 节插件入口中的 `ctx.systemPrompt.variable('memoRules', ...)`。

这样做的好处：

- 规则在系统提示词层面，每轮都会生效
- 不干扰 agent/pre-step 的消息修改逻辑
- 与 dsh-agent-loop 注入其他变量的方式一致（`variable(name, (context) => string)`）

八、落地路径（分四期）

前置准备（第 0 天）

- [ ] 通过 MemOS Dashboard（memos-dashboard.openmem.net）清空所有记忆
- [ ] 确认 memos-cloud 配置：`addEnabled: false`，`recallEnabled: true`，`userId: yk`
- [ ] 确认 MEMOS_API_KEY 环境变量已配置
- [ ] 手动提交 1-2 条测试记忆，验证 add/message → search 链路正常
- [ ] 验证 search 返回结构：`data.memory_detail_list` + `relativity` 字段

第一期：MVP（1-2 天）

目标：跑通"手动触发反思 → 三审 → add/message → 轮询 search 验证"主链路

- [ ] 搭建插件开发环境（TypeScript + DSH 插件模板）
- [ ] 实现观察层：监听 session/event，采集当前任务轨迹
- [ ] 实现反思层：subagents.spawn + run.result 取结果 + outputSchema 强制 JSON
- [ ] 实现修正层：MemOSWriter（异步 add + 轮询 search 验证 + info 字符串化）
- [ ] 实现 `/reflect` 手动触发命令
- [ ] 实现本地审计日志 + 统计（插件本地记账）
- [ ] 验证：跑 3 个任务，检查写入 MemOS 的记忆质量和入库率

第二期：自动闭环（3-5 天）

目标：从手动触发升级为自动触发

- [ ] 即时反思：工具失败 / 用户纠错自动触发（session/event 监听）
- [ ] 任务反思：任务完成自动触发（turn/end + reason.kind === 'completed'）
- [ ] 教训去重与递增：嵌套 filter 搜索查重 → 命中则 failureCount+1
- [ ] 写入速率限制：每日最大写入数（本地计数）
- [ ] 统计命令：`/memos-stat`

第三期：规划驱动（1 周）

目标：任务先规划再执行，带检查点验证

- [ ] 规划层：任务分解 + 成功标准定义
- [ ] 检查点验证：agent/pre-step 缓存 agent + session/event 中校验
- [ ] 早停机制：子任务失败时 agent.cancel({ kind: 'user', ... }, {})
- [ ] `/plan-and-execute` 命令
- [ ] 通过 goals 服务驱动任务执行

第四期：Skill 自进化（2 周）

目标：从记忆进化升级到能力进化

- [ ] Skill 自动生成：写入 ~/.dsh/skills/ 目录（description 单行化）
- [ ] Skill 自动更新：反思发现缺陷时更新
- [ ] 周期反思：ctx.setInterval 定时触发
- [ ] 基准测试集：Skill 更新后自动跑回归
- [ ] 记忆质量报告：每周自动生成

九、风险与应对

| 风险                    | 影响         | 应对措施                                          |
| --------------------- | ---------- | --------------------------------------------- |
| MemOS 服务端抽取不忠实原文      | 写入的记忆与预期不符 | 两步验证：异步 add → 轮询 search 确认；不通过则调整消息构造方式重试     |
| 反思消耗大量 token          | 成本上升       | 异步执行 + 控制频率 + 轨迹摘要而非全量传入 + outputSchema 限长    |
| 反思质量不稳定               | 写入低质量记忆    | 三审机制 + 置信度阈值 + 证据必选 + 每日写入上限                  |
| 记忆仍有错误（服务端抽取偏差）       | 召回质量下降     | 系统提示词规则 + 教训记忆优先 + 发现错误立即反思修正                 |
| DSH API 变动            | 插件失效       | 锁定 DSH 版本 + 基于稳定接口开发 + 适配层封装                  |
| 反思无限递归                | 系统卡死       | maxDepth: 1 + 超时机制 + 重试上限                     |
| 没有 delete/update API  | 版本管理困难     | 新增版本 + 内容中标注版本号 + 提示词优先新版 + 定期 Dashboard 手动清理 |
| conversation_id 超长/断裂 | 服务端上下文异常   | 固定为 'dsh:reflection'，不使用 Date.now()           |

十、验证标准

量化指标

1. 入库成功率：提交后轮询验证通过的比例 → 目标：> 70%（初期较低，随消息构造优化提升）
2. 教训复发率：同一教训写入后，同类错误再次发生的比例 → 目标：持续下降
3. 每日新增记忆数：控制在合理范围 → 目标：5-20 条/天
4. 反思命中率：反思产出的有效改进数 / 反思总次数 → 目标：> 60%
5. 事实引用证伪率：被引用的 verified_fact 记忆中，事后被证伪的比例 → 目标：< 5%

定性验证

1. 写入验证：完成一个任务后，检查 MemOS 中新增的记忆是否准确、有证据
2. 召回验证：问一个已经写入记忆的问题，看 Agent 是否能正确召回并引用
3. 不重复犯错验证：踩坑 → 生成教训 → 下次遇到类似场景是否避开

文档结束