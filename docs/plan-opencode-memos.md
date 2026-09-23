# opencode × MemOS 反思闭环插件 — 实施计划

> 目标：把本仓库（DSH/Cordis 版 `dsh-reflection-memos` v5.0）的反思闭环移植到 **OpenCode V2 插件**：
> 让 Agent 执行的结论/教训/配置结论，**经验证后才写入 MemOS 长期记忆**，并被后续会话召回、应用、演化。
> 生成日期：2026-09-23 ｜ 依据：OpenCode V2 插件文档 + `https://opencode.ai/v2/openapi.json` + 本仓库源码

---

## 1. 目标与范围

**范围内（对齐 DSH v5.0 功能面）**

1. 观察：采集会话轨迹（用户消息/助手输出/工具调用与结果），"值得反思"过滤 + 冷却 + 熔断
2. 反思：Reviewer（无工具、只出 JSON）产出 `verifiedFacts` / `lessons` / `errors` / `improvements`
3. 写入：**单一 WriteGate 四审**（脱敏 → 证据 → 置信度 → patternKey 查重）+ 每日配额 + `add/message` → `search/memory` 轮询验证 → 账本 + 审计
4. 召回（读放开）：把 MemOS 记忆与记忆使用规则注入每次模型调用的 system
5. 应用：pre-step 教训注入（双区检索）+ `memos_lesson_ack` + 遵守验证
6. 演化：衰减/回活/归档、合并、晋升 Skill、每日自动 `decay + autoAcknowledge`、`/memory-report`

**范围外**

- 不重写 MemOS 服务端（仍用 `/add/message` + `/search/memory`）
- 不做 DSH 侧改动（DSH 插件保持可运行；本计划只读取其源码作移植源）
- 第一版不做多用户/团队共享记忆（沿用单 `userId`）

**交付物**：新包 `opencode-memos-reflection`（`Plugin.define` + `exports: {".", "./rpc"}`），一条 `opencode.jsonc` 配置即可加载。

---

## 2. 资产盘点（哪些直接搬、哪些必须重写）

| 资产 | DSH 实现 | 移植策略 |
|---|---|---|
| `core/write-gate.ts` 四审+配额+验证 | 纯 TS，无 Cordis 依赖 | **原样移植** |
| `core/ledger.ts` 版本链/折叠/importance | 纯 TS + JSONL | 移植；存储层换成 `ctx.storage`（见决策 D4） |
| `core/redact.ts` 脱敏规则 | 纯 TS | **原样移植** |
| `core/retrieval.ts` 双区检索 | 纯 TS | **原样移植** |
| `core/memory-store.ts` 门面 | 纯 TS | **原样移植** |
| `backends/memos-backend.ts` add/search/verify | 纯 fetch | **原样移植**（改 `source`/`conversation_id` 前缀为 `opencode:`） |
| `backends/api-key.ts` | DSH credentials | 重写：`process.env.MEMOS_API_KEY`（回退 `MEMOS_USER_ID`） |
| `modules/observer.ts` | `ctx.on('session/event')` | **重写**：`ctx.event.subscribe()` + `ctx.tool.hook('execute.*')` |
| `modules/reflector.ts` | `ctx.subagents.start('spawn')` | **重写**：`ctx.generate.text()`（见决策 D2） |
| `modules/refiner.ts` | 经 MemoryStore 提交 | 基本不动（仅换日志接口） |
| `loop/applier.ts` `agent/pre-step` 注入 | DSH 事件 | 重写为 `ctx.session.hook('context')` |
| `loop/compliance.ts` | `session/event` 流 | 重写：`ctx.tool.hook('execute.after')` 判定成功/失败信号 |
| `loop/evolver.ts` `reporter.ts` | 纯 TS + `/evolve` | 移植；晋升 Skill 目标从 `~/.dsh/skills/` 改为 `ctx.skill.transform` |
| `tools/memory-tools.ts` | `ctx.tools.register` | 适配 `ctx.tool.transform`；**保留 object-rooted JSON Schema 教训** |
| `commands/index.ts` | `ctx.commands.register` | 适配 `ctx.command.transform` |
| `audit/logger.ts` | `~/.dsh/reflection/*.jsonl` | 改落盘到 `~/.local/share/opencode/memos-reflection/`（或 `ctx.storage`，见 D4） |
| `prompts/reflection-schema.ts` + Reviewer persona | — | **原样移植**（含"仅一个 JSON、首字符 `{`"约束） |
| 脚本 `smoke`（92 断言）、`e2e-memos-verify.ts` | — | **原样移植**（宿主无关部分） |
| `cordis.patch.yml` / `install.mjs` | DSH 专用 | 丢弃；换成 opencode.jsonc 幂等安装脚本 |

---

## 3. 关键对接点映射（DSH/Cordis → OpenCode V2）

| DSH（Cordis） | OpenCode V2 插件 | 备注 |
|---|---|---|
| `ctx.inject([...])` | 无需（`setup(ctx)` 即全部能力） | ctx = 服务端 client + 插件扩展 |
| `ctx.on('session/event')` | `ctx.event.subscribe({signal})` | 事件名 P0 实测确认（候选 `session.idle` / `message.updated` / `message.part.updated`，日志中已出现 `session.idle`、`message.updated`） |
| `turn/end` 自动反思触发 | 会话空闲类事件（`session.idle`） | 触发后**异步**反思，不阻塞下一条 prompt |
| `tool/call`+`tool/result` 采集 | `ctx.tool.hook('execute.before' / 'execute.after')` | 不依赖事件名，最稳 |
| `ctx.subagents.start('spawn', …)` Reviewer | `ctx.generate.text({model, prompt})` | 无会话、无工具 → **天然不会递归触发反思** |
| `agent/pre-step` 教训注入 | `ctx.session.hook('context', e => e.system.push(...))` | 每次模型调用都跑，必须缓存召回结果 |
| `ctx.systemPrompt.variable` | 同上（`e.system.push` 注入 MEMO_RULES） | |
| `ctx.commands.register` | `ctx.command.transform(e => e.add({name, description, execute}))` | `execute({sessionID, prompt, delivery})` |
| `ctx.tools.register` | `ctx.tool.transform(e => e.add({name, description, input, execute}))` | `input` 必须 `{type:'object', properties, required}` |
| `ctx.settings.register`（settings.yaml） | `ctx.options`（`opencode.jsonc` 的 `plugins[].options`） | 见 D5 |
| `ctx.provide('memoryStore'…)` | 可选导出 `./rpc`（RPC guide） | 第一版可不做 |
| `ctx.setInterval` 每日演化 | `setup` 内 `setInterval` + 返回 cleanup 清理 | |
| `memos-cloud` 召回插件（读放开） | 同插件 `context` hook 内调 `/search/memory` | 见 D3：读写同插件，避免双插件配置 |
| `dsh plugin add` + `cordis.patch.yml` | `opencode.jsonc` → `"plugins": ["opencode-memos-reflection"]` 或本地路径 | |
| DSH credentials | `process.env.MEMOS_API_KEY` / `MEMOS_USER_ID` | 密钥不进配置文件 |

---

## 4. 目标结构

```
opencode-memos-reflection/
├── package.json            # name, exports: {".": "./src/index.ts", "./rpc": "./src/rpc.ts"}
├── opencode.jsonc          # 开发自测：{ "$schema": …, "plugins": ["./src/index.ts"] }
├── tsconfig.json / tsup.config.ts
├── src/
│   ├── index.ts            # Plugin.define({ id, async setup(ctx) }) 装配 + hooks + cleanup
│   ├── config.ts           # ctx.options 解析、默认值、env 密钥、热读
│   ├── core/               # ← 从 DSH 移植（零宿主依赖）
│   │   ├── write-gate.ts  ledger.ts  redact.ts  retrieval.ts  memory-store.ts
│   ├── backends/           # memos-backend.ts（移植）+ api-key.ts（改写）
│   ├── modules/            # observer.ts（重写）reflector.ts（重写）refiner.ts（微调）
│   ├── loop/               # applier.ts compliance.ts evolver.ts reporter.ts
│   ├── recall.ts           # 【新】context hook：MEMO_RULES + 记忆召回（带缓存）
│   ├── tools/memory-tools.ts   # memos_lookup / memos_lesson_ack / memos_correct
│   ├── commands/index.ts       # /reflect /memos-stat /evolve /lesson-confirm /lesson-check /memory-report
│   ├── audit/logger.ts  types/  prompts/
│   └── rpc.ts              # 可选：给其他插件用的查询接口
├── scripts/  install.mjs（幂等写 opencode.jsonc）  e2e-memos-verify.ts
└── tests/    smoke.ts（移植 92 断言）
```

---

## 5. 分阶段里程碑

> **P0 实测结果（2026-09-23，OpenCode v2.0.14）**：事件清单与三条硬约束已落库
> → 新仓库 `docs/event-probe.md`。要点：① 回合结束信号是 `session.execution.succeeded`（非 `turn/end`）；
> ② 事件流是**全局**的，必须按 `event.location.directory` 过滤；③ 本地目录插件按 `<包根>/index.ts` 解析、
> 不读 `package.json#exports`（缺根 index.ts 会静默不加载）。P2/P4 的触发点与过滤逻辑据此细化。

> **P2/P3 实测结果（2026-09-23，OpenCode v2.0.14）**：观察层+反思层+自动闭环全链路打通，
> 证据落库 `docs/event-probe.md` §8–§12（新仓库）。要点：
> ① **D2 修正**：`ctx.generate.text` 不可用（free-tier 与 opencode-go 均因"缺会话上下文"被上游拒绝），
> 唯一可用通道是**专用 Reviewer 会话的 `session.generate` 瞬态生成**（不改会话历史、不发事件 → 递归机制上不可能）；
> ② `session.generate` 三条调用纪律：setup 期间必死锁、钩子同步上下文内挂起（须 `setTimeout` 出栈）、
> 超时给 `reflectionTimeoutMs`(120s)；
> ③ Reviewer 模型**不指定=继承全局默认**（实测 opencode-go 需订阅，本机不可用）；
> ④ 一次性 `opencode run` 在响应后 ~400ms shutdown，会截断 turn-end 反思——可靠自动反思依赖 TUI/serve，
> 回合内触发（tool-failed/correction）不受影响；
> ⑤ 端到端实测：`reflect-done facts=4 lessons=3 ingested=4 failed=3`（lessons 因
> `failureCount<2` 被 gate 正确拒收），WriteGate→MemOS add+search 验证→evolution.db+audit jsonl 全部落盘。

### P0 对接探针（0.5 天）
- 建包骨架，`opencode.jsonc` 本地路径加载，确认插件 `setup`/`cleanup` 生命周期
- **实测并记录**：`ctx.event.subscribe()` 的事件名与字段（写入 `docs/event-probe.md`）；确认"会话回合结束"事件
- 实测 `ctx.generate.text()` 出 JSON 的稳定性（选定 reviewer 模型，记录 3 个候选）
- **验收**：插件加载日志 + 事件清单 + 1 条合法 JSON 样例

### P1 核心域移植（1 天）
- 搬运 `core/ + backends/ + types/ + prompts/ + audit/`，替换宿主依赖（credentials、路径）
- 移植 `tests/smoke.ts` 至全绿；`e2e-memos-verify.ts` 直连真实 MemOS 写→验→召回
- **验收**：92 断言全绿 + 真实 MemOS 写入/验证通过（尚未接入会话）

### P2 观察层 Observer（1 天）✅ **完成（2026-09-23）**
- `ctx.event.subscribe` 环形缓冲（每会话 ≤2000 条，超限截断）+ `ctx.tool.hook('execute.*')` 补充工具成败
- "值得反思"过滤、冷却（30min）、熔断（连败 3 次暂停 30min）、**排除自反思/子会话**（按 `parentID` 或本插件标记）
- **验收**：跑一个真实会话，审计日志能看到轨迹摘要与触发判定（含"不值得反思"被过滤的用例）
- **实测**：三类触发器（tool-failed/task-complete[成功→task·失败→deep]/user-correction）+ 单飞锁 +
  location 过滤（`filteredLocations:2`）+ 跨 plugin reload 存活，全部实况验证通过

### P3 反思层 Reflector（1 天）✅ **完成（2026-09-23，通道按实测改道）**
- ~~`ctx.generate.text({ model, prompt })`~~ → **专用 Reviewer 会话 `ctx.session.generate({sessionID, prompt})`**
  （`modules/reviewer-session.ts`：按 location 持久化 sessionID 复用、不指定模型继承全局默认、
  创建即从观察层排除；生成通道的坑与调用纪律见新仓库 `docs/event-probe.md` §8）
- REVIEWER_PERSONA + `extractJsonObject` + 可重试（非 JSON/空输出按 `maxReflectionRetries` 重试）
- 三审预过滤（证据 ≥20 字符、置信度阈值）
- **验收**：给定一段轨迹能稳定产出合法 ReflectionResult（连续 5 次）
- **实测**：selfTest 合成轨迹 + 真实失败轨迹均产出合法 JSON（热 11s / 冷 34.5s），三审正常过滤

### P4 写入闭环 MVP（1 天）⭐ 可交付最小版本 ✅ **完成（2026-09-23，全链实测）**
- `MemoryStore + WriteGate` 接线（writer 惰性解析，密钥缺失时降级只读并告警）
- 自动链路：会话空闲 → 冷却/熔断判定 → **后台异步**反思 → WriteGate → `search` 验证 → 账本/审计
  - **实测**：`reflect-done facts=4 lessons=3 ingested=4 failed=3`（lessons 因 `failureCount<2`
    被 gate 正确拒收），evolution.db + audit jsonl 落盘；密钥缺失降级与跨进程熔断也已实测
- 命令：`/reflect`（手动）、`/memos-stat`（统计）、`/lesson-confirm`（pending 分流）✅
  - **实测**：注册 `ctx.command.transform`；入口为 `session.command` API（`opencode run` 不路由
    斜杠命令）；输出用 `session.synthetic(resume:false, description)` 回显（description 是 TUI
    可见性开关）；`/reflect` 走"出栈 hop → generate → refiner"全链 3s 完成
  - 详细结论见新仓库 `docs/event-probe.md` §13；smoke 106 断言
- **验收**：真实环境 7 项全绿（写入、验证、账本、审计、统计、手动触发、自动触发）

### P5 召回（读放开）+ 教训注入（1.5 天）✅ **完成（2026-09-23，模型自证）**
- 同插件 `context` hook 自动召回 + 记忆使用规则（D3 落地）
- **注入面实测**：`SessionContext.system` 可变数组直接 `push({type:'text'})`（比 DSH
  "首条 user 消息前插入"干净）；每 step 触发 → TTL 缓存压网络（step2 实测缓存命中）
- **实测**：模型自证"注入区块：有…共 5 条…"并原文引用第一条记忆；Reviewer 会话
  双保险排除（id 集合 + isExcluded + 空意图短路）；密钥缺失降级本地教训
- 新增 `recall{enabled,minRelativity,limit,cacheTtlMs,minIntentChars}`；smoke 116 断言；
  详见新仓库 `docs/event-probe.md` §14
- `ctx.session.hook('context')`：注入 MEMO_RULES + 最近用户意图的 `/search/memory` 结果（按 session+意图缓存 60s，限条数与字符预算）
- `loop/applier` 双区检索（核心区常驻教训 / 情境区按意图）+ `memos_lesson_ack` 提示
- **验收**：新会话提问能引用先前写入的记忆；审计中出现 lesson-injection 记录；召回延迟可测（目标 < 100ms 缓存命中）

### P6 记忆工具 + 遵守验证（1 天）✅ **完成（2026-09-23，模型真实调用）**
- **实测**：`ctx.tool.transform` 注册三工具（object-rooted schema 被上游接受）；模型真实调用
  `memos_lookup` 并**自发** `memos_lesson_ack` 声明遵守；回复开头"本轮经验应用：…"证明教训被应用
- **接线改造**（cordis → OpenCode）：注入登记在 `context` hook（`recall.lessons → recordApplied`）；
  回合切片由 Observer `turnMark` 完成；判定 `compliance.evaluate()` 先于反思 defer 执行；
  `onSignal` 回调替代 `ctx.emit`；self-eval 信号与任务反思合并（单飞）
- **实测判定链**：`turn/end applied=1 → violated → 信号 lesson/violated → evolution.db violationCount=1`
- 已知启发式乐观偏差（预期性命中关键词也计违反）为 DSH 同款，`violatesOnCompleted` 可关；
  `scripts/seed-lesson.ts` 播种已确认教训；smoke 124 断言；详见新仓库 `docs/event-probe.md` §15
- `ctx.tool.transform` 注册 3 个工具（**input 必须 object-rooted JSON Schema**）：`memos_lookup`（只读）、`memos_lesson_ack`、`memos_correct`（每日限额 + reason 护栏）
- `loop/compliance`：`execute.after` 结果 + 成功/失败信号 → 账本 violation/complied 计数（误报收紧规则一并移植）
- **验收**：3 个工具真实调用成功；注入教训后能统计遵守/违反

### P7 演化与报告（1 天）✅ **完成（2026-09-23）**
- **实测**：每日作业（`evolution{dailyJob,dailyJobHour}` 默认 04:00；30min tick + 启动即查
  可跨重启补跑）启动即触发 `每日作业完成 decay=0 errors=0`；`/evolve --promote --auto-ack`
  flag 解析正确并回显；`/memory-report` 真实报告（账本 5 条/active 100%/教训效果命中）
- **移植修复**：DSH `/--promote/` flag 解析 bug（`-` 与空格间无 `` → flag 从未生效）
  改为 token 精确匹配；skillsDir 迁至 `<数据目录>/skills`
- 新增配置 `evolution{dailyJob,dailyJobHour}`；smoke 128 断言；详见新仓库 `docs/event-probe.md` §16
- `/evolve`（衰减/合并/晋升/会话整合/auto-ack）、`/memory-report`、`/lesson-check`
- 每日 `setInterval`（decay + autoAcknowledge），cleanup 清理定时器
- 晋升 Skill：`ctx.skill.transform(add)` 写入 OpenCode skill（替代 `~/.dsh/skills/`）
- **验收**：老化条目状态迁移可观察；报告输出含元优化建议；Skill 出现在 `ctx.skill.list()`

### P8 打包、安装与文档（1 天）
- `tsup` 构建、`exports {".", "./rpc"}`、npm 发布（或本地 path 引用）
- `scripts/install.mjs`：幂等向 `opencode.jsonc` 写入 plugins 条目 + 校验 env + 打印提示
- README：配置样例、命令表、与 MemOS 端点的对应关系、已知坑
- **验收**：干净目录 3 步安装 → 插件加载 → P4 闭环 7/7 复跑通过

**工作量合计 ≈ 8–9 人日；MVP（P0–P4）≈ 4.5 人日。**

---

## 6. 关键设计决策（推荐项已标 ✅，其余待你确认）

| # | 决策 | 推荐 ✅ | 备选 |
|---|---|---|---|
| D1 | 代码复用策略 | ✅ **先复制跑通（P1–P4），闭环绿后再抽共享包** `memos-reflection-core`，两个插件共用（避免一开始就动 DSH 生产代码） | 立即抽 monorepo 共享包 |
| D2 | Reviewer 实现 | ✅ **专用 Reviewer 会话 + `session.generate` 瞬态生成**（2026-09-23 实测修正：`ctx.generate.text` 因缺会话上下文被上游拒绝；瞬态生成不改会话历史、不发会话事件 → 递归机制上不可能，比原方案更硬） | ~~`ctx.generate.text()`~~（实测不可用）；`session.create/prompt` 全量回合（会写历史、带工具，次选） |
| D3 | 召回（读放开） | ✅ **同插件 `context` hook 自动召回**，读写一体、零额外插件 | 仅提供 `memos_search` 工具，让 Agent 自己决定何时查 |
| D4 | 账本/审计存储 | ✅ **XDG 数据目录文件后端**（`~/.local/share/opencode/memos-reflection/`，`evolution.db` JSONL+fsync 原子写；2026-09-23 落地时**偏离原推荐 `ctx.storage`**：文件后端同步读写、原子性自控，且与审计 JSONL/探针/Reviewer 会话表同目录，多进程共享靠 ledger fingerprint 去重） | `ctx.storage`（`ledger/<key>` 前缀 scan，API 面更"官方"但异步且不便多文件协同） |
| D5 | 配置来源 | ✅ **`opencode.jsonc` → `plugins[].options`（读 `ctx.options`）+ env 密钥** | 保持 settings.yaml 风格（OpenCode 无对应机制） |
| D6 | 与其它 MemOS 插件并存 | ✅ 默认**接管全部写入**，`recall.enabled` 可关（避免重复注入/重复写） | 依赖对方插件做召回 |
| D7 | 反思执行时机 | ✅ 会话空闲事件后**异步队列 + 单飞锁**，绝不阻塞用户输入；`search` 验证轮询放同一后台队列 | 在 `context` hook 内同步反思（会拖慢每次模型调用，否决） |

---

## 7. 风险与对策

1. **事件名/字段不稳定**（V2 事件 schema 在 openapi 中是不透明 JSON 字符串）→ P0 先做探针，把实测事件清单写进文档；工具层观测不依赖事件名（走 `tool.hook`）。
2. **Reviewer JSON 不稳**（DSH 已踩过：空输出/非 JSON/夹带工具调用）→ persona 强约束 + `extractJsonObject` 容错 + 1 次重试 + 三审兜底。
3. **自反思递归** → `generate.text` 天然免疫；若 D2 选子会话方案，必须按 `parentID` 过滤本插件产生的会话。
4. **`context` hook 每次模型调用都执行** → 召回必须带缓存、条数与字符预算，未命中意图时只注入规则不调 API。
5. **WriteGate `search` 轮询（3s×5）慢** → 全部放后台队列，命令只回执"已提交"，结果写审计。
6. **密钥缺失/额度耗尽** → writer 惰性解析，失败降级为只读模式并在 `/memos-stat` 里显形；熔断（连败 3 次暂停 30min）保留。
7. **工具 schema 被上游拒绝** → 沿用 DSH 09-15 教训：`parameters/input` 一律 `{type:'object', properties, required}`。
8. **双插件重复召回/重复写** → D6 配置开关 + `conversation_id` 用 `opencode:reflection` 独立命名空间。

---

## 8. 验证计划

- **单元**：移植 DSH `smoke`（92 断言）— WriteGate 四审、patternKey 折叠、脱敏、配额、检索双区、wire-schema。
- **服务端 e2e**：`scripts/e2e-memos-verify.ts` 真实 MemOS 写入 → `search` 验证 → 召回引用。
- **宿主 e2e 手工清单**（P4/P5/P6/P8 各跑一遍）：
  1. `/reflect` 手动反思落库并验证
  2. 跑一个多工具会话 → 会话空闲自动反思（冷却生效）
  3. 新会话提问 → 召回引用先前记忆
  4. `memos_lookup` / `memos_lesson_ack` / `memos_correct` 真实调用
  5. `/lesson-confirm`、`/memos-stat`、`/memory-report` 输出正确
  6. 熔断：人为制造 3 次反思失败 → 自动反思暂停且有审计
  7. 重启 OpenCode 服务 → 账本/配额/定时任务恢复

---

## License

MIT
