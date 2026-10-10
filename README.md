# dsh-reflection-memos

DSH × MemOS **Self-Improving Agent(自我进化)插件** — 让 AI 记住教训、不再重复犯错,让 MemOS 记忆持续进化。每次 Agent 执行的结论、教训、配置结论都经过验证后才写入 MemOS 长期记忆,并自动被后续对话召回、应用、演化。

> 基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) + [MemOS Cloud](https://memos.memtensor.cn) 构建  
> 文档版本：v5.0(结构优先重构,对应提交 `88fa089` → `77527e6`)  
> 设计文档：[v4.0 进化设计](docs/design-v4.0-self-improving-agent.md) · [v4.1 SIA 评审](docs/design-v4.1-sia-optimizations.md) · [v5.0 重设计](docs/design-v5.0-redesign.md) · [SIA 源码研究](docs/study-self-improving-agent.md)

---

## 核心原理

```
┌──────────────────────── 沉淀(Sediment) ────────────────────────┐
DSH Session ──▶ Observer ──▶ Reflector(三审) ──▶ refiner          │
(执行轨迹)                    (Reviewer 子代理)       │           │
                                                  ▼           │
┌──────────────── MissOS 写入:唯一 WriteGate ──────────────────┤
│  零审脱敏 → 一审证据 → 二审置信度 → 三审 patternKey 查重        │
│  → 配额 → add/message → 轮询 search 验证 → 账本 + 审计        │
└───────────────────────────────────────────────────────────────┘
         ▲                                          │
         └──── memos-cloud 自动召回 ◀── MemOS(历史库) ──┘
┌──────────────────────── 应用/演化(Apply/Evolve) ───────────────┐
│ Applier:pre-step 教训注入 + 遵守验证 · Evolver:合并/更正/晋升    │
└───────────────────────────────────────────────────────────────┘
```

- **读放开**:memos-cloud 插件的自动召回完全保留,不影响生产力
- **写收紧**:所有写入(反思/演化/编辑工具)都经单一 WriteGate 四审后才提交 MemOS,v3.2 起"三审"升级为"四审 + 脱敏 + patternKey"
- **不假设写入正确**:`add/message` 由服务端抽取,必须用 `search/memory` 轮询验证入库
- **记忆进化**:本地演化账本(`~/.dsh/reflection/evolution.db`)维护版本链/状态/importance/复发统计;MemOS 只做历史库

---

## 功能状态

### ✅ 已实现并通过真实环境验证(2026-09-09)

| 功能 | 说明 |
|---|---|
| M0 结构重构 | `core/` + `backends/` 抽取,MemoryStore 门面;现有命令行为零变化 |
| M1 单一写入闸门 | WriteGate 四审(脱敏/证据/置信度/patternKey 查重)+ 配额 + search 验证 + 审计,一次性实现 |
| M2 教训注入预审(O6) | 统一检索管线 `RetrievalPipeline`:账本覆盖 → 双区(核心区常驻/情境区按意图)→ ack 提示;`agent/pre-step` 注入(实测会话 lesson-injection 事件) |
| M3 演化引擎(O2/O4/O5) | `loop/evolver.ts`:衰减/回活/归档、同 key 合并、晋升 Skill(~/.dsh/skills/)、会话整合 episodic |
| O1 记忆编辑工具 | `tools/memory-tools.ts`:`memos_lookup`(只读)、`memos_lesson_ack`(声明遵守)、`memos_correct`(受限写,每日上限+reason 护栏);raw register 的 `parameters` 为 object-rooted JSON Schema(`type:"object"`+properties+required,上游 Console Go 校验) |
| O3 遵守验证/自评 | `loop/compliance.ts`:turn/end 对照轨迹判定 violated/complied → 账本计数;低质量完成自评触发深度反思 |
| O5 黄金路径止损 | `evolver.harvestGoldenPath`:任务成功+≥3 工具调用+试错信号 → 即时生成 Skill |
| O2 轨迹级会话整合 | `evolver.synthesizeTrajectory`:场景/步骤/坑/结果 → episodic 本地条目 |
| #1 pending 自动确认 | `evolver.autoAcknowledge`:importance≥0.8 且 failureCount≥3 的教训自动转 acknowledged(缓解 GAP-3 积压) |
| #2 批量确认 | `/lesson-confirm --high / --min-failures N`:批量筛选确认,清 pending 积压 |
| #3 误报收紧 | compliance 判别"纠错成功信号"(exit 0/成功/修复)不判违规,降低带病误报 |
| #5 周期演化 | 每日自动 `decay + autoAcknowledge`(无人工干预的持续记忆治理) |
| #7 correct 闭环 | `lesson/correct-request` → 账本 v+1 修正,旧版 superseded(agent 受限写) |
| O1 工具可用 | 已对齐 dsh-tools output 契约(schema/render/execute)+ parameters object-rooted JSON Schema(2026-09-15 修);实战 memos_lookup 真实调用成功 |
| 写入脱敏(GAP-1) | 提交 MemOS 前对 api_key/token/secret/Bearer/JWT/长blob 替换 `[REDACTED]` |
| patternKey 去重(GAP-2) | `area.symptom` 稳定键查重,语义相同措辞不同的错误不再重复入库,复发折叠计数 |
| pending 分流(GAP-3) | 自动链路产物默认 `triage=pending`,确认后才被召回注入 |
| 一键安装 | `pnpm siainstall` 构建→打包→`dsh plugin add`→patch 注入(幂等),可装到任何已装 DSH 的电脑 |
| 真实 MemOS 验证 | 真实写入→真实 search 验证→召回引用闭环 7/7 全绿;反思自动触发(详见开发日志 09-09) |
| `/reflect` 手动反思 | Reviewer 子代理三审后经 WriteGate 写入 |
| 自动反思 | `turn/end` / 工具失败 / 用户纠错 触发,含"值得反思"过滤 + 冷却 + 熔断 |
| 写入→召回闭环 | 写入的记忆被 memos-cloud 自动召回引用(实测:用户问 DSH 部署经验,助手引用记忆回答) |
| `/plan-and-execute` | Planner 子代理计划 + `runMaintenance` 子任务自动推进(已解决) |
| `/memos-stat` | 审计日志聚合统计 |
| DSH 0.2.x / v4 会话兼容 | 0.1.5 起:peerDeps 同时接受 `0.1.x`/`0.2.x`;教训注入使用产出方自有 kind `plugin:dsh-reflection-memos`(v4 拒绝退役的 `kind:'plugin'`);实测 v4 会话注入落盘无 `SessionFormatError` |
| 一键安装 v5.1 | `scripts/install.mjs`:JSONC 容错、双条目形态识别、幂等注入、环境变量校验与提示(0.1.6 打包) |
| 每日演化可观测(0.1.7) | 每次 `decay+autoAcknowledge` 落 `{kind:'evolution-daily'}` 审计;`/memos-stat` 显示上次执行/下次计划 |
| peer 预发布兼容(0.1.7) | peerDependencies 显式枚举 `0.1.1-rc.2 / 0.1.5-rc.1 / 0.2.0-rc.2 / 0.2.1-alpha.1`(semver 预发布语义下"通配"不成立) |
| 会话内容体检(0.1.7) | `scripts/session-content-audit.ts`:v3/v4 双形态体检,`--fix` 自动备份+原地重写,`contentHasImage` 同构探针前后对照 |

### 🔜 设计中(见 v4.1 评审 O1–O7)

| 功能 | 说明 |
|---|---|
| `/evolve` | 手动演化作业(合并/更正/衰减/晋升/会话整合) |
| `memos_correct` 编辑工具(O1) | agent 执行中主动发起记忆修正(仍经三审) |
| 遵守验证/自评(O3,O6) | 教训注入后验证是否遵守、任务自评触发深度反思 |
| `/lesson-check` `/memory-report` | 教训注入/遵守一览;记忆质量报告 + 元优化建议 |

---

## 安装

### 🔧 一键安装(v5.0,推荐 —— 便于在任何已装 DSH 的电脑上安装)

```bash
# 在插件源码目录下,一条命令完成:构建 → 打包 tgz → dsh plugin add → 注入 profile patch
pnpm siainstall --profile web
# 然后重启 DSH Web
```

`pnpm siainstall` 是幂等的:重复执行不会重复注入 patch。脚本会打印最后需要配置的
两个环境变量(`MEMOS_API_KEY` / `MEMOS_USER_ID`)。

**在其他电脑安装(只需 3 步):**
1. 把本项目源码目录(或打包好的 `dsh-reflection-memos-0.1.7.tgz`)拷贝到新电脑;
2. 新电脑确保已装 DSH 与 pnpm(插件零额外 npm 依赖,运行时依赖全部走宿主 DSH 的 peerDependencies);
3. 在新电脑执行 `pnpm siainstall --profile web` → 配置环境变量 → 重启。

> **兼容性(0.1.7 起)**:peerDependencies **显式枚举**已适配的 DSH 预发布元组
> `^0.1.1-rc.2 || ^0.1.5-rc.1 || ^0.2.0-rc.2 || ^0.2.1-alpha.1`(semver 语义下
> `^0.1.1-rc.2` 这类范围**不接受**其他元组的预发布,故不能靠"通配"覆盖)。
> **DSH 发布新的预发布元组时,需把该元组加进 `package.json` 的 peer 范围**,否则
> profile 会跳过本插件(现象:插件"装了但没生效")。
> DSH ≥ 0.2.0 使用 v4 会话格式,注入消息必须带**产出方自有 kind**
> (`plugin:dsh-reflection-memos`),0.1.5 起已适配。

> 需要打包产物给别的电脑时:`pnpm build && pnpm pack` → 得到 `.tgz`,在目标机器使用
> [`scripts/install.mjs`](scripts/install.mjs)(见脚本 `--tgz` 用法)。

### 手动安装

```bash
dsh plugin --profile web add /path/to/dsh-reflection-memos-0.1.7.tgz
# 插件自身 bundle.patch 会自动合并 insert,无需手动改 cordis.patch.yml
# (DSH 0.1.2+ 支持插件 dsh.bundle.patch 自动注入;DSH 0.2.x 见上方兼容性说明)
```

### 配套插件

```bash
# memos-cloud:负责召回(读放开)。写收紧(addEnabled: false)由本插件接管。
npx @deepseek-ai/dsh plugin --profile web add @memtensor/memos-cloud-dsh-plugin@latest
```

### 本机一键启动(桌面快捷方式)

本仓库提供 npx 版启动脚本(读取 `~/.dsh/profiles/web` 带双插件):

```bash
/home/huangwei/launch-web-npx.sh        # 启动(自动切走 dev 实例)
/home/huangwei/launch-stop-npx.sh       # 停止
# 桌面快捷方式:DeepSeek Harness (npx)(deepseek-harness-npx.desktop)
```

---

## 配置

在 `~/.dsh/settings.yaml` 中配置(顶层 namespace = 插件名):

```yaml
# memos-cloud:关闭官方写入,只保留召回(读放开)
memos-cloud:
  recallEnabled: true
  addEnabled: false       # 写入由反思闭环接管
  userId: yk
  memoryLimitNumber: 8
  relativity: 0.5
  includeToolMemory: true
  toolMemoryLimitNumber: 3

# dsh-reflection-memos:反思/闸门配置
dsh-reflection-memos:
  memos:
    userId: yk            # 与 memos-cloud 的 userId 一致
  reflection:
    enableImmediateReflection: true
    enableTaskReflection: true
    enablePeriodicReflection: false
    autoReflectOnTaskComplete: true
    autoReflectCooldownMs: 1800000        # 30 分钟冷却
    minTrajectoryEventsForAutoReflect: 8  # "值得反思"最小事件数
    minConfidenceForFact: 0.8
    minConfidenceForLesson: 0.7
    evidenceMinChars: 20
  refiner:
    writeVerifiedFacts: true
    writeLessons: true
    minFailuresForLesson: 2   # 教训写入最低失败次数
    verifyIngestion: true
    maxVerifyRetries: 5
    maxMemoriesPerDay: 50     # 每日写入配额(反思/演化/工具共享)
  performance:
    reflectTimeoutMs: 120000
    verifyInitialDelayMs: 3000
    verifyBackoffFactor: 1.8
    minVerifyRelativity: 0.6
```

API Key 与 User ID 放 `~/.dsh/.env`(或 `.credentials.yaml` 的 refs):

```dotenv
MEMOS_API_KEY=mpg-xxx
MEMOS_USER_ID=yk
```

---

## 命令

| 命令 | 说明 |
|---|---|
| `/reflect` | 手动触发反思:分析当前会话轨迹 → Reviewer 子代理审查 → 四审 → 经 WriteGate 写入 MemOS |
| `/plan-and-execute <任务>` | 生成多步计划并开始执行(runMaintenance 自动推进,完成后自动反思) |
| `/memos-stat` | 查看记忆统计:提交数 / 入库数 / 失败数 / 事实数 / 教训数 |
| `/evolve [--promote|--auto-ack|--synthesize]` | 手动演化作业:衰减/合并/晋升(--promote)/会话整合(--synthesize)/自动确认教训(--auto-ack) |
| `/lesson-confirm [前缀|--high|--min-failures N|--all]` | 确认待分流教训为 acknowledged(支持批量筛选) |
| `/lesson-check` | 教训注入/遵守/违反一览(O3 可观测性) |
| `/memory-report` | 记忆质量报告 + 元优化建议(O7) |

---

## 技术架构

### 插件结构(v5.0)

```
src/
├── index.ts                # 插件入口:wiring + 事件接线 + 熔断 + MemoryStore 装配
├── config.ts               # 配置 Schema + ctx.settings.register(hot reload)+ gateConfigFrom
├── core/                   # v5.0 核心抽象
│   ├── memory-store.ts     # MemoryStore 门面(读/写/账本/统计;唯一写入口)
│   ├── write-gate.ts       # 单一写入闸门(脱敏+三审+patternKey+配额+验证+审计)
│   ├── retrieval.ts        # 【M2】检索/注入管线:账本覆盖→排序→双区→ack
│   ├── ledger.ts           # 演化账本状态机(fingerprint/版本链/折叠/防循环/importance)
│   └── redact.ts           # 写入脱敏(REDACTION_RULES,移植自 SIA 研究)
├── backends/
│   ├── memos-backend.ts    # MemOS API 封装(add/message + search/memory,含验证/退避)
│   ├── ledger-backend.ts   # 账本 JSONL 原子写(fsync)
│   └── api-key.ts          # API Key 解析(credentials 服务优先,环境变量回退)
├── modules/
│   ├── observer.ts         # 观察层:session/event 采集 + "值得反思"过滤 + 冷却
│   ├── reflector.ts        # 反思层:Reviewer 子代理(spawn)+ 三审(只产出候选)
│   ├── refiner.ts          # 修正层:反思结果 → WriteGate 提交(唯一写入口门面)
│   ├── planner.ts          # 规划层:Planner 子代理生成结构化任务计划
│   └── executor.ts         # 执行层:runMaintenance 子任务自动推进
├── loop/
│   └── applier.ts          # 【M2】应用层:pre-step 教训注入 + ack + 审计
├── memos/client.ts         # 兼容重导出(迁移期双轨)
├── commands/index.ts       # /reflect /plan-and-execute /memos-stat
├── types/{reflection,memory,evolution}.ts
├── audit/logger.ts         # 审计日志(~/.dsh/reflection/audit-*.jsonl)
└── scripts/
    ├── install.mjs         # 一键安装(构建+打包+add+patch 注入,幂等)
    └── smoke-entry.ts      # 核心逻辑冒烟测试(38 项)
```

### DSH API 使用

| API | 用途 |
|---|---|
| `ctx.inject(['settings'])` + `ctx.settings.register` | 配置注册(DSH 0.1.2+,替代已移除的 `installSettingsSection`);`scope.get()` 热更新 |
| `ctx.subagents.start('spawn', ...)` | 拉起 Reviewer/Planner 子代理(`run.result` 取结果 + dispose) |
| `ctx.commands.register` | 注册斜杠命令 |
| `ctx.on('session/event')` | 事件流采集(turn/end、tool/result、user/message) |
| `ctx.on('agent/pre-step')` | 缓存 agent 引用 + 检查点注入 |
| `ctx.systemPrompt.variable` | 注入记忆使用规则 |
| `agent.runMaintenance` | 命令返回后保持 agent 上下文存活,子任务自动推进 |
| `ctx.provide('memoryStore' / 'reflectionMemos')` | 对外暴露服务 |

### MemOS API

| 端点 | 方法 | 用途 |
|---|---|---|
| `/add/message` | POST | 异步提交记忆(服务端抽取) |
| `/search/memory` | POST | 搜索验证入库(轮询) |

---

## 已知问题与已踩坑记录

1. **subagent 偶发未就绪**:真实运行中出现 `no subagent provider registered for "spawn"`(1 次)——重试后恢复;若频繁出现需在 reflector 前置等待 subagents 服务。
2. **Reviewer 输出不稳**:opencode-go 结构性输出偶发空输出/非 JSON(已用 persona 强约束 + 重试兜底,后续 reflect-done 均成功)。
3. **opencode-go/deepseek catalog 冲突**:`deepseek-v4-flash` 同时存在于两个 catalog,显式 agentOptions 会导致路由歧义,当前用 `agentOptions: {}` 继承 parent 回避。
4. **`installSettingsSection` 已从 DSH 移除**(0.1.2-rc.1):配置注册必须用 `ctx.settings.register`(本插件已适配,见提交 `77527e6`)。
5. **会话格式随 DSH 升级而变(v0 → v2 → v4),且多个 DSH 版本共用一个 `~/.dsh`**:2026-09-30 起线上为 **v4**;不同 DSH 版本读写的格式可能不同,混用同一 `~/.dsh` 需谨慎(升级前建议备份 `~/.dsh/sessions`)。v4 的 `tool/result` 把内容块直接挂在 `data.message.content`(不再包 `tool-result` 包装块),且**拒绝退役的 `kind:'plugin'`**(见第 7 条)。排查/修复会话请用 `scripts/session-content-audit.ts`,不要沿用按 v0/v3 形状写的脚本。
6. **`output.render` 必须返回 `ContentBlock[]`(2026-09-28 线上事故)**:返回裸字符串会被原样持久化为 tool-result 内容,下一轮请求组装时 `dsh-llm` 的 `contentHasImage()` 递归 `content.some(...)` 抛 `TypeError: content.some is not a function`;污染已落盘 → **该会话每轮必崩**。`memos_*` 三工具已于 `d1de009` 修复,并有 `scripts/repro-render-contract.ts` 回归;宿主侧不校验 render 返回类型,新增工具务必自查。
7. **DSH 0.2.0-rc.2 的 v4 原生写路径拒绝 `kind:'plugin'`**:教训注入必须用产出方自有 kind `plugin:dsh-reflection-memos`(否则 `SessionFormatError`,线上实证 2026-09-30 02:47~02:51 UTC reflector dispose 失败),已由 0.1.5 修复。
8. **opencode-go 订阅会失效**:2026-10-10 起该 provider 返回 `403 An active OpenCode Go subscription is required to use Go models`,导致依赖默认模型的 reviewer 子会话出现成串 `llm/retry`。当前默认模型已切到 `commandcode`(见 `~/.dsh/settings.yaml` 的 `agent-default-model`);排障时先确认 provider 额度,再怀疑插件。
9. **peerDependencies 的预发布陷阱**:`^0.1.1-rc.2` 这类范围在 semver 语义下**不接受其他元组的预发布**(如 `0.1.5-rc.1`/`0.2.1-alpha.1`)→ profile 会跳过插件。0.1.7 起改为**显式枚举**已知预发布元组;DSH 每发布一个新的预发布元组(如 `0.3.0-beta.1`),需在 `package.json` 的 peer 范围里加白,否则重演"插件被跳过"。

---

## 开发日志

### 2026-10-10(审计整改:peer 预发布陷阱 / 每日演化可观测 / 会话体检脚本;版本 0.1.7)

- **peerDependencies 预发布陷阱(高)**:实测 `satisfies('0.2.1-alpha.1', '^0.1.1-rc.2 || ^0.2.0-rc.2') = false` —— 旧声明**连当前运行版本都不在范围内**(预发布只在同元组比较器下被接受),异地按 README 装机若跑 `0.1.5-rc.1`/`0.2.1-alpha.1` 会重演"profile 跳过插件"。改为**显式枚举**元组:`^0.1.1-rc.2 || ^0.1.5-rc.1 || ^0.2.0-rc.2 || ^0.2.1-alpha.1`(实测 0.1.1-rc.2/0.1.5-rc.1/0.1.6/0.2.0-rc.2/0.2.0/0.2.1-alpha.1/0.2.1 全 ✓,0.3.0 ✗)
- **每日演化作业从"已接线"升级为"可观测"**:此前 `setInterval(24h)` 的 decay+autoAcknowledge 无任何落盘痕迹(审计里查不到,无法证明跑过)。现在每次运行写 `{kind:'evolution-daily',decayed,revived,archived,autoAcknowledged,errors,at}`,`/memos-stat` 增加一行**上次执行/下次计划**(未跑过时显示首次计划时间);该记录不带 `submitted`,不污染 `statsToday()`
- **注册失败不再静默**:`tryRegister` 的失败此前只写 `audit.debug`(实测该日志未落盘)→ 升为宿主 `logger.warn`,让"工具没注册"在 hub.log/UI 可见
- **会话内容体检脚本入库**:新增 `scripts/session-content-audit.ts`(v3/v4 双形态、`--fix` 自动备份 + zstd 原地重写、`contentHasImage` 同构探针给前后对照证据);真实全量 dry-run **481 文件 / 25,395 内容 / 0 违规**,合成污染样本可检出并修复(抛错 2 → 0)
- **小修**:`limit` 的 1..5 边界进 wire schema(`minimum/maximum`);`repro-render-contract` 从只验 ack 扩到**三工具** schema/返回形状 + 成功路径 `ok=true`;smoke 去掉硬编码绝对路径(`scripts/smoke-entry.ts` 改用 cwd 相对解析,异地可跑)
- **验证**:smoke **104 → 109 全绿**;render 回归全绿(3 工具);会话体检 dry-run 0 违规;v4 wire schema 3/3 object-rooted;`lib/` 重建与安装副本 md5 一致
- **已知未做**(留在"已知问题"):`memos_lookup` 的 `current` 字段仍恒为空数组(需要 applier 暴露"当前已注入教训"才能填),`docs/plan-opencode-memos.md` 与本仓库演进已分叉

### 2026-09-30(适配 DSH 0.2.0-rc.2 / v4 会话产出方 kind;版本 0.1.5 → 0.1.6)

- **背景**:DSH 升级到 0.2.0-rc.2 后,profile 直接**跳过本插件**并报 peerDependencies 不兼容 —— 0.1.3 声明的 `^0.1.1-rc.2` 在 0.x 语义下排除 0.2.x
- **兼容声明**:peerDependencies 改为 `^0.1.1-rc.2 || ^0.2.0-rc.2`,dev 依赖锁定 0.2.0-rc.2(同一份产物同时兼容 0.1.x / 0.2.x 运行时)
- **第二个破坏性变更(v4 产出方 kind)**:解除门禁后暴露 —— DSH 0.2.0-rc.2 的 **v4 原生写路径拒绝退役的 v3 包装 `kind:'plugin'`**(`SessionFormatError: format v4 message requires a producer-owned source kind`;线上实证 2026-09-30 02:47~02:51 UTC reflector dispose 失败)
  - 修复:`src/loop/applier.ts` 教训注入消息改用产出方自有 kind `plugin:dsh-reflection-memos`(即官方 `producerKind()` 对第三方插件的等价产出),不再带 `plugin` 字段
  - 验证:smoke 新增 v4 合规断言(注入 `source.kind` 非 `'plugin'` 且无 `plugin` 字段),**103 → 104 全绿**;真实 v4 会话日志确认注入以 `{"kind":"plugin:dsh-reflection-memos","form":"lesson-injection"}` 落盘
- **一键安装脚本 v5.1**(`scripts/install.mjs`):修四处可用性问题(JSONC 容错 / 双条目形态识别 / 幂等 / 环境变量校验与提示)
- `pnpm-workspace.yaml` 追加 0.2.0-rc.2 系列到 `minimumReleaseAgeExclude`(pnpm 11 供应链时限白名单,异地复现安装需要)
- **发布**:0.1.5 → 0.1.6(install.mjs 修复后重新打包);`lib/` 重建后与已装载产物 md5 一致(`4e0019de…`)

### 2026-09-28(opencode 移植计划对照审计 → DSH 同补两个真缺陷)

- 上游更新:12 个提交仅新增 `docs/plan-opencode-memos.md`(opencode × MemOS 移植实施计划,P0-P9 全完成 + 缺陷审计轮),文档点名「**DSH 同补**」两个缺陷
- **D1 `foldRecurrence` 未过滤 active**:correct 闭环后旧版置 superseded,复发折叠仍会命中死版本 —— 实测复现:旧版 `8c890881`(superseded)failureCount 1→2,active 新版 `52abfbed` 计数不增;且 correct 只写 `note corrected-v{n+1}` 而未真正递增 `version`(新旧并列 v1,排序失去依据)
  - 修复:`core/ledger.ts` 折叠候选加 `.filter(e => e.status === 'active')`;`src/index.ts` correct 闭环补 `version: old.version + 1`
  - 验证:修复前复现脚本 ❌ → 修复后 ✅;新增断言覆盖"correct 后折叠 active 新版""superseded 旧版计数不虚增""高版本 superseded 也必须跳过(status 过滤而非排序)"
- **D-flag `/evolve` flag 解析从未生效**:原 `/\b--promote\b/` 中 `\b` 两侧均为非单词字符(空格/`-`)→ 对 `--promote`、` --promote`、`evolve --promote` 恒不匹配(仅 `x--promote` 畸形输入命中)
  - 修复:`commands/index.ts` 新增并导出 `hasFlag()`(按空白切词全等比较),四处 flag 全部替换
  - 验证:命令级回归 —— 用 stub 注册表捕获 `/evolve` handler,断言 `--promote --auto-ack` → `{promote:true, autoAcknowledge:true}`、无参全 false、相似 token(`--promote-x`)不误开
- smoke 92 → **103 断言全绿**;`lib/` 重新构建;版本 0.1.2 重新安装进 web profile 并重启生效

### 2026-09-15(memos_* 工具 wire schema 修复)

- 用户诊断:`memos_correct` 请求被上游拒绝 — `invalid_request_error: 函数 'memos_correct' 的模式无效:模式必须是 'type: "object"' 的 JSON Schema,但收到了 'type: null'`
- 根因:09-09 的简化 spec(`{字段:{type,required,description}}`)只对 `defineTool` 有效;raw `ctx.tools.register()` 的 `schemaOf()` 把 `parameters` **原样透传**上游,不编译为 JSON Schema,缺顶层 `type` → 上游收到 `type: null`
- 修复:`memory-tools.ts` 三个工具 `parameters` 改为 object-rooted JSON Schema(`{type:'object',properties,required}`,新增 `parameterSchema()` 编译助手);代码注释同步更正契约说明
- 验证:smoke 新增 12 条 wire-schema 回归断言(顶层 type/properties/required 引用),92 项全绿;真实上游直连实测(deepseek-v4-flash/mimo-v2.5/qwen3.8-flash/minimax-m3/mimo-v2.5-pro/qwen3.8-max/glm-5.2 全部 200,无 schema 拒绝)
- 提交:b5c8a02 之后的二次修复(详见 src/tools/memory-tools.ts 头部注释)
- 补充:`inject` 补 `timer`(周期反思/周期演化 #5 的 `setInterval` 依赖显式声明,此前仅在运行时防御式可用);新增 `scripts/repro-opencode-schema.ts` 上游端到端回归(自包含:本地断言 + 3 个真实上游目标,退出码语义化)

### 2026-09-09(优化 #1-#7)

- #1/#2 pending 治理:autoAcknowledge 自动确认 + /lesson-confirm 批量筛选(--high/--min-failures/--all)
- #3 compliance 误报收紧:纠错成功信号(exit 0/成功/修复)不判违规
- #4 extractKeywords 中文去噪:扩展弱词表,保留语义词
- #5 周期演化:每日自动 decay+autoAcknowledge
- #6 Reviewer persona 强化:仅一个 JSON、首字符 {、禁 Markdown/前言
- #7 memos_correct 闭环:correct-request → 账本 v+1 修正,旧版 superseded
- 复发率显形实证:带病完成(教训词+404+无成功信号)→ violation 0→1、复发率 0%→1.9%;演示后回滚保持生产干净
- 方法论沉淀:2 条教训经 WriteGate 写入 MemOS(search top relativity 0.65/0.76)+ 本地账本同步
- smoke 扩展至 83 项全绿;提交 fa0f8ce + 后续沉淀

### 2026-09-09(真实环境验证 + 修复)

- 真实 MemOS 端到端验证 7/7 全绿:真实 fact/lesson 经 WriteGate 四审+脱敏+验证写入,`search` 召回引用,账本/审计正确
- 修复 `config.ts` 适配 DSH 当前 `ctx.settings.register`(installSettingsSection 已被移除)
- 修复 WriteGate 审计 patternKey 追溯;提交 `77527e6` 已推送 GitHub
- 安装 `@memtensor/memos-cloud-dsh-plugin@0.1.1`;memos-cloud 召回 + 反思闭环双插件真实运行
- 真实反思自动触发:`facts=9 lessons=3 ingested=11` 等;教训未达阈值被拒(`failureCount 1 < 2`)符合预期
- **M2 教训注入预审完成(O6)**:`core/retrieval.ts` 双区管线 + `loop/applier.ts` pre-step 注入;smoke 扩展至 38 项全绿
- 桌面 npx 快捷方式 + launch-web-npx.sh / launch-stop-npx.sh

### 2026-09-08(v5.0 重设计)

- 产出 v5.0 重设计文档(结构优先:一个记忆抽象 / 一条写入通道 / 一条检索管线 / 一个闭环)
- SIA 源码研究:补 3 缺口——写入脱敏、patternKey 稳定去重键、pending 人工分流
- M0 结构重构 + 一键安装机制(`88fa089`)
- M1 单一写入闸门迁移(`c576d7a`)

### 2026-09-01

- `/plan-and-execute` 首次成功生成 4 步计划;自动反思连续成功
- 修复子代理 provider 路由(catalog 冲突 → agentOptions: {} 继承)
- 确认需 goals/runMaintenance 服务驱动子任务自动推进

### 2026-08-31

- 实现 MVP:`/reflect` 手动反思 + 三审 + add/message + search 验证
- 实现自动闭环:turn/end 自动反思 + 熔断 + 冷却 + 人格约束
- MemOS 链路验证:relativity 0.6989;修复启动崩溃(memoRules → memo_rules 等)

---

## License

MIT