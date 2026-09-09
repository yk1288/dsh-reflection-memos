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
| M2 教训注入预审(O6) | 统一检索管线 `RetrievalPipeline`:账本覆盖 → 双区(核心区常驻/情境区按意图)→ ack 提示;`agent/pre-step` 注入 |
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
1. 把本项目源码目录(或打包好的 `dsh-reflection-memos-0.1.0.tgz`)拷贝到新电脑;
2. 新电脑确保已装 DSH 与 pnpm(插件零额外 npm 依赖,运行时依赖全部走宿主 DSH 的 peerDependencies);
3. 在新电脑执行 `pnpm siainstall --profile web` → 配置环境变量 → 重启。

> 需要打包产物给别的电脑时:`pnpm build && pnpm pack` → 得到 `.tgz`,在目标机器使用
> [`scripts/install.mjs`](scripts/install.mjs)(见脚本 `--tgz` 用法)。

### 手动安装

```bash
dsh plugin --profile web add /path/to/dsh-reflection-memos-0.1.0.tgz
# 插件自身 bundle.patch 会自动合并 insert,无需手动改 cordis.patch.yml
# (DSH 0.1.2+ 支持插件 dsh.bundle.patch 自动注入)
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
| `/evolve`(设计) | 手动演化作业(合并/更正/衰减/晋升) |
| `/lesson-check`(设计) | 教训注入/遵守/违反一览 |
| 遵守验证/自评(O3,O6) | 教训注入后验证是否遵守、任务自评触发深度反思(enableCompliance 预留) |

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
5. **npx 发布版 vs checkout dev 版共用一个 `~/.dsh`**:dev(0.1.3-alpha.2)用 v2 会话格式、发布版(0.1.2-rc.1)读 v0 格式;启动哪一个,会话目录用哪个格式,混用需谨慎(见设计文档)。

---

## 开发日志

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