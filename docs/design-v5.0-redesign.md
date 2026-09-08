# DSH × MemOS Self-Improving Agent v5.0 重设计(结构优先重构)

> 版本：v5.0(重设计定稿)
> 日期：2026-09-08
> 定位：在 v3.2 实测实现(已跑通)+ v4.0/4.1 设计(已评审)基础上的**结构优先重设计** —— 骨架按 SIA 原生重建,血肉保留已验证资产
> 核心判断：现状不是"方案错了",而是"打补丁长出来的";重设计赢在结构(一个记忆抽象、一条写入通道、一条检索管线、一个闭环),不靠推翻已验证的踩坑知识
> 吸收：v4.1 的 O1–O7 全部并入新骨架;**不采纳**无监督自主改记忆/自我改内核的激进面
> 补充：已对真实 SIA 项目(pskoett/self-improving-agent)做源码级研究,合入 3 项修订——**WriteGate 脱敏层 / Pattern-Key 稳定去重键 / pending 人工分流**(详见 [study-self-improving-agent.md](./study-self-improving-agent.md))
> 文档链：v3.2(实测)→ v4.0(进化设计)→ v4.1(SIA 评审)→ **v5.0(重设计,本文档)**

---

## 一、重设计目标(赢什么)

| # | 目标 | 现状痛点 | v5.0 形态 |
|---|---|---|---|
| G1 | **一个记忆抽象** | 4 个存储各管各(MemOS 远程语义 / 账本 JSONL 工作态 / audit 审计 / skills 目录),靠手工保持同步 | `MemoryStore` 门面 + 3 个后端(backends),读写演化全部走接口 |
| G2 | **一条写入通道** | 反思/演化/编辑工具/教训升级 4 个入口各写各的,闸门逻辑散在 refiner | **单一写入闸门 WriteGate**:三审+验证+配额+审计一次实现 |
| G3 | **一条检索/注入管线** | 教训注入、回忆覆盖、Skill 匹配是 3 套机制 | `RetrievalPipeline`:意图→召回→账本覆盖→排序→双区注入→ack |
| G4 | **SIA 闭环一等公民** | 应用层/演化层是贴在反思闭环上的外挂 | 闭环即骨架:Plan→Execute→Observe→Reflect→Evolve→Measure,新能力=往环上挂节点 |
| G5 | **可测试** | 无测试目录,全靠真机 | MemoryStore/WriteGate/管线可 mock,闭环可单测 |
| G6 | **零资产损失** | 踩坑知识在代码注释里,重写易丢 | 资产清单显式归档(见第六节),迁移期逐条核对 |

---

## 二、总体架构

```
┌────────────────────────────────────────────────────────────────────┐
│                        SIA 闭环(一等公民)                            │
│                                                                     │
│   Plan ──► Execute ──► Observe ──► Reflect ──► Evolve ──► Measure   │
│   (planner) (executor) (observer) (reflector) (evolver) (reporter)  │
│      ▲            │            ▲            │            ▲          │
│      └────────────┴── 事件总线(core/event-bus) ──┴────────────┘     │
└────────────────────────────────────────────────────────────────────┘
                              │ 全部读写
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│                    core/ 核心抽象(本设计的骨架)                       │
│  MemoryStore(门面) ──── WriteGate(单一写入闸门)                       │
│  RetrievalPipeline(检索/注入) ── Ledger(演化账本/工作态)               │
└──────────────┬──────────────────────────────────┬──────────────────┘
               │                                   │
      ┌────────▼────────┐                 ┌────────▼────────┐
      │ backends/       │                 │ loop/ + tools/  │
      │ memos-backend   │                 │ agent 可见工具:  │
      │ ledger-backend  │                 │ memos_lookup    │
      │ skill-backend   │                 │ memos_correct   │
      └─────────────────┘                 └─────────────────┘
```

**分层职责**

| 层 | 内容 | 说明 |
|---|---|---|
| `loop/` | SIA 闭环 6 节点 | 每个节点是单一职责模块(e.g. reflector 只管"产出反思结果",不碰 MemOS) |
| `core/` | 抽象层 | MemoryStore / WriteGate / RetrievalPipeline / Ledger / event-bus —— **本设计的心脏** |
| `backends/` | 物理存储适配 | memos-backend(远程)、ledger-backend(本地)、skill-backend(技能文件) |
| `tools/` | agent 可见工具 | O1 的记忆编辑工具(memos_lookup / memos_correct) |
| `commands/` | 斜杠命令 | 6 个命令 |

---

## 三、核心抽象设计

### 3.1 MemoryStore(门面)——G1

```typescript
// src/core/memory-store.ts
export interface MemoryStore {
  // 读:统一检索(经 RetrievalPipeline 后续可叠加排序/过滤)
  query(input: QueryInput): Promise<QueryResult[]>;
  // 写:唯一入口,内部必走 WriteGate(直接 new 后端是不允许的架构违规)
  submit(candidate: WriteCandidate): Promise<WriteOutcome>;
  // 演化:合并/更正/衰减/晋升,全部经 WriteGate 落地
  evolve(op: EvolveOp): Promise<EvolveOutcome>;
  // 工作态:账本查询(版本链/状态/统计)
  state(filter: StateFilter): EvolutionEntry[];
  // 后端注册(启动时装配,wiring 只发生在 index.ts)
  registerBackend(b: Backend): void;
}
```

**三个后端职责(物理隔离)**

| 后端 | 存储 | 角色 |
|---|---|---|
| `memos-backend` | MemOS(远程,只增) | 语义记忆的**历史库**(所有版本最终落点) |
| `ledger-backend` | `~/.dsh/reflection/evolution.db`(JSONL) | **唯一工作态**:版本链/状态/importance/统计;召回与判定的依据 |
| `skill-backend` | `~/.dsh/skills/` | 晋升产物(watcher 自动发现) |

**一致性规则(解决"4 存储漂移"痛点)**
- **账本是唯一事实源(工作态),MemOS 是历史**:所有"当前是什么状态"的判定只查 ledger,不查 MemOS;
- MemOS 只负责两件事:追加新版本 + 被 search 召回候选;
- 每次写入/演化落地后,ledger 与 MemOS 的映射(`memoryKey ↔ taskId`)必须同步更新,否则视为写入失败。

### 3.2 单一写入闸门 WriteGate——G2

```typescript
// src/core/write-gate.ts
export class WriteGate {
  async submit(candidate: WriteCandidate): Promise<WriteOutcome> {
    // 零审:脱敏(接自 self-improving-agent 的 REDACTION_RULES)
    //       api_key/token/secret/password/Bearer/JWT/GitHub-token/AWS-AKIA/≥40位blob → [REDACTED]
    //       云端存储(MemOS)与本地审计均只落脱敏后文本(研究补强 GAP-1)
    // 一审:证据必选(evidence ≥ 20 字符,缺失即拒)
    // 二审:置信度(fact ≥ 0.8 / lesson ≥ 0.7,episodic 仅本地)
    // 三审:查重与版本(按 patternKey 查重 → 命中折叠递增;同 scenario 已存在 → 递增 or 替代 or 合并)
    // 配额:maxMemoriesPerDay(反思/演化/工具共享)
    // 落地:memos-backend.add() → 轮询 search 验证 → ledger 更新 → audit 记录
    // 分流:自动链路产物先落 triage=pending,确认后才 active(研究补强 GAP-3)
  }
}
```

**所有写入方(去重后只剩一个实现)**

```
反思闭环产物(verifiedFacts/lessons) ─┐
协作演化作业(合并/更正/晋升) ──────────┼──► WriteGate.submit() ──► MemOS + 验证 + ledger + audit
agent 工具 memos_correct(受限修正) ───┤
教训升级(violation → v+1) ───────────┘
```

### 3.3 统一检索/注入管线 RetrievalPipeline——G3

```
任务意图(user/message,pre-step 触发)
   │
   ▼
① 召回:ledger 内快筛(同 category/scenario + 关键词)+ memos-backend.search
   ▼
② 覆盖:ledger 过滤(superseded/merged/archived 剔除;同 key 只取最新 active)
   ▼
③ 排序:score = relativity × (0.6 + 0.4×importance) × recencyBoost
   ▼
④ 双区注入:核心区(≤3,常驻高价值)+ 情境区(≤3,任务相关);总 ≤5 条、≤600 字符
   ▼
⑤ ack 提示:注入块末尾附「请在本轮开头说明将如何应用这些经验」
```

### 3.4 SIA 闭环(loop/)——G4

| 节点 | 触发 | 职责 | 上一版对应 |
|---|---|---|---|
| Plan | `/plan-and-execute` | 子代理分解任务 + 成功标准 | planner.ts(保留) |
| Execute | plan 就绪 | 子任务顺序执行(继承工具) | executor.ts(保留,含 runMaintenance) |
| Observe | session/event | 轨迹采集 + "值得反思"过滤 + 冷却 | observer.ts(保留) |
| Reflect | task/error/correction/self-eval | 三审反思(产出候选)**只产出不落库** | reflector.ts(剥离写职责) |
| Evolve | 周期 + `/evolve` | 合并/更正/强化衰减/晋升/会话整合 | evolver.ts(新增) |
| Measure | 每日 | 指标统计 + 参数建议(周报) | reporter(新增,吸收 O7) |

**关键的职责切割(与 v3.2 的差异)**
- v3.2:`refiner.processReflectionResult()` 里反思结果直接写库;
- v5.0:reflector 只返回候选 → 调用方(loop 编排)把候选交给 `WriteGate` —— **写不写在反射层决定,怎么写写不写在闸门统一决定**,职责单一化。

### 3.5 事件总线(core/event-bus.ts)

统一为带类型的 Cordis 事件(命名收敛),供 Measure 统计与调试:

| 事件 | 载荷 | 用途 |
|---|---|---|
| `sia/lesson-injected` | `{ memoryKey, zone, agentId }` | 注入统计 |
| `sia/lesson-acked` | `{ memoryKey }` | ack 率 |
| `sia/lesson-complied` / `sia/lesson-violated` | `{ memoryKey, evidence }` | 复发率 |
| `sia/reflect-done` | `{ level, candidates }` | 反思产出 |
| `sia/write-done` | `{ outcome }` | 入库统计 |
| `sia/evolve-done` | `{ op, affected }` | 演化统计 |
| `sia/skill-promoted` | `{ skillName }` | 晋升统计 |

---

## 四、吸收 v4.1 优化项的位置映射

| v4.1 优化 | 落点 |
|---|---|
| O1 记忆编辑工具 | `tools/memos_lookup`(读)+ `tools/memos_correct`(受限写,投递 correction-request 事件 → Reflect 重审 → WriteGate) |
| O2 会话整合 | `loop/evolver` 的 `session-synthesis` 子作业 → ledger(kind: episodic,不写 MemOS) |
| O3 自我评估触发 | `loop/observer`(orchestrator)在 completed 且带成功标准时拉起 self-eval 子代理,selfScore<0.5 触发 Reflect |
| O4 记忆不平权 | ledger 增加 `importance` 字段;RetrievalPipeline ③ 排序公式 |
| O5 黄金路径即时晋升 | `loop/evolver` 监听 `sia/reflect-done`(completed 分支),判定 goldenPath → 立即生成 Skill 草案 |
| O6 双区注入 + ack | RetrievalPipeline ④⑤ |
| O7 元优化报告 | `loop/reporter` 周报输出参数建议 diff |

---

## 五、模块结构与目录(最终形态)

```
dsh-reflection-memos/
├── src/
│   ├── index.ts             # 唯一 wiring 点:装配 backends、注册命令/事件/工具、启动周期作业
│   ├── config.ts            # 单一 ConfigSchema(含 applier/evolver/reporter 命名空间,见下)
│   ├── core/
│   │   ├── memory-store.ts  # 门面 + MemoryStore 接口
│   │   ├── write-gate.ts    # 单一写入闸门(三审+验证+配额+审计)
│   │   ├── retrieval.ts     # RetrievalPipeline(召回→覆盖→排序→双区注入)
│   │   ├── ledger.ts        # 账本(状态机 + 查询 + 原子写)【吸收 v4.0 3.x 节】
│   │   └── event-bus.ts     # 事件名常量 + 类型(Cordis 包装)
│   ├── backends/
│   │   ├── memos-backend.ts # 【保留资产】MemOSWriter 客户端原样迁入(含验证/退避逻辑)
│   │   ├── ledger-backend.ts# 【保留资产】AuditLogger 基础上扩展为账本后端
│   │   └── skill-backend.ts # 【保留资产】SkillManager 原样迁入
│   ├── loop/
│   │   ├── planner.ts       # 【保留】planner.ts 原样迁入(含 fallbackPlan)
│   │   ├── executor.ts      # 【保留】executor.ts 原样迁入(含 runMaintenance 用法)
│   │   ├── observer.ts      # 【保留】observer.ts + O3 self-eval 触发
│   │   ├── reflector.ts     # 【保留】reflector.ts,剥离写职责(返回候选)
│   │   ├── evolver.ts       # 【新增】O2/O4/O5 演化作业
│   │   ├── applier.ts       # 【新增】O6 注入编排(调用 RetrievalPipeline)+ 遵守验证子代理
│   │   └── reporter.ts      # 【新增】O7 指标与周报
│   ├── tools/
│   │   └── memory-tools.ts  # 【新增】memos_lookup / memos_correct(O1)
│   ├── commands/index.ts    # /reflect /plan-and-execute /evolve /lesson-check /memory-report /memos-stat
│   ├── audit/logger.ts      # 【保留】AuditLogger(精简,写经 WriteGate 的记录入口)
│   └── types/               # reflection.ts / evolution.ts / pipeline.ts / events.ts
├── tests/                   # 【新增】vitest:MemoryStore/WriteGate/Retrieval/Pipeline 单测 + 状态机测试
├── tsup.config.ts           # 不变(entry 仍为 src/index.ts)
└── cordis.patch.yml         # 不变
```

---

## 六、已验证资产保留清单(重设计红线)

> 原则:**凡真实跑通过、并记录在代码注释里的踩坑结论,以下 12 项全部原样保留,只改所在文件路径,不改逻辑**。迁移完成时逐条勾销。

| # | 资产 | 现状位置 | v5.0 位置 | 保留要点 |
|---|---|---|---|---|
| 1 | MemOS add/message + search 轮询验证 + 指数退避 | memos/client.ts | backends/memos-backend.ts | 原样 |
| 2 | source 平台标识 deepseek_harness_*/info 值字符串化 | 同上 | 同上 | 原样 |
| 3 | run.result 取结果 + 立即 dispose | reflector/executor | loop/* | 原样 |
| 4 | prompt 必须是 content block 数组 | reflector | loop/* | 原样 |
| 5 | signal 必须可用(自动路径缺省 AbortController) | reflector | loop/* | 原样 |
| 6 | 不走 outputSchema → persona 强约束 + extractJsonObject 解析 | reflector | loop/* | 原样 |
| 7 | agentOptions:{} 继承 parent 规避 catalog 冲突 | reflector/planner | loop/* | 原样 |
| 8 | maxDepth: 32 护栏 + reviewer 无工具防递归 | reflector | loop/* | 原样 |
| 9 | runMaintenance 保持上下文存活跑子任务 | commands | loop/executor 编排 | 原样 |
| 10 | 子代理会话忽略(subagent origin 过滤防无限递归) | observer | loop/observer | 原样 |
| 11 | 熔断(连续 3 次失败暂停 30 分钟)+ 冷却 + quotable | index/observer | core/loop 编排 | 原样 |
| 12 | installSettingsSection + current() 热更新模式 | config.ts | config.ts | 原样 |

---

## 七、迁移路径(每阶段可运行,可随时暂停)

| 阶段 | 内容 | 产出 | 验收 |
|---|---|---|---|
| **M0 抽取核心**(2-3 天) | 建 `core/` + `backends/`,MemoryStore 门面套现有实现;行为零变化 | 新目录 + 编译通过 | `/reflect` / `/plan-and-execute` / `/memos-stat` 照常工作 |
| **M1 单一写入闸门**(2-3 天) | 所有写入改走 WriteGate;refiner 拆掉"自己写库",改为"产出候选→交闸门" | WriteGate + 单元测试 | 审计日志中所有写入带 `gate:write-gate` 标记 |
| **M2 统一检索注入**(2-3 天) | RetrievalPipeline 上线;applier(O6)接入 pre-step;去掉零散的教训注入逻辑 | Pipeline 单测 | 注入 ≤5 条/≤600 字符,ack 提示生效 |
| **M3 演化引擎 + 工具**(3-5 天) | evolver(O2/O4/O5)周期作业;memory-tools(O1)注册 | 演化作业 + 工具测试 | `/evolve` 产出合并/晋升;`memos_correct` 经三审落地 |
| **M4 闭环与度量**(1 周) | O3 self-eval 触发 + O7 reporter 周报 + events 全接通 + 补测试 | 完整闭环 + 报告 | 量化指标可产出(复发率/遵守率/active 占比) |

**迁移纪律(防回归)**
1. 每阶段结束 `pnpm build` + 冒烟(`/reflect` 真实跑一次);
2. M0–M2 期间保留旧模块路径到新路径的**导出别名**(types 通用),避免一次性大改;
3. 每阶段只改"结构",不改已验证逻辑(第六条清单逐项勾销);
4. 真机验证一次"不重复犯错"演示(写入教训→下次任务 pre-step 注入→遵守验证)在 M2 完成后执行。

---

## 八、配置(v5 单一 Schema,向后兼容)

```yaml
dsh-reflection-memos:
  memos: { baseUrl, apiKeyEnv, userId }            # 不变
  sia:
    enableLoop: true                                # 总开关
    writeGate: { enableVerify, minRelativity, maxPerDay }   # 由 refiner/performance 合并
    retrieval: { coreZoneMax: 3, ctxZoneMax: 3, maxChars: 600, enableAck: true }
    reflect: { enableSelfEval, selfEvalThreshold: 0.5 }     # O3
    evolve:
      enablePeriodic: true
      consolidationHours: 24
      promotionHours: 168
      sessionSynthesisHours: 24                    # O2
      minReinforceForPromotion: 3                  # O5
      importanceDecayFactor: 3                     # O4
    tools: { memoCorrectMaxPerDay: 5 }             # O1
    reporter: { weeklyReport: true }               # O7
```

> v3.2 的 `reflection.* / refiner.* / performance.*` 配置在 M0 期间仍然读取,由 config.ts 做一层**兼容映射**(旧键 → 新键),迁移完成后废弃旧键。用户设置零改动。

---

## 九、命令与验证标准

**命令(v5)**

| 命令 | 说明 |
|---|---|
| `/reflect` | 手动反思(产出候选 → WriteGate) |
| `/plan-and-execute <任务>` | 规划 + 顺序执行(闭环走全) |
| `/evolve [--promote]` | 手动演化(合并/更正/衰减/晋升/会话整合) |
| `/lesson-check` | 注入/ack/遵守/违反一览 |
| `/memory-report` | 质量报告 + 参数建议(O7) |
| `/memos-stat` | 沿用(统计改读 ledger) |

**验证标准(与 v4.0 第八节一致,追加两项结构性指标)**

| 指标 | 目标 |
|---|---|
| 教训遵守率 | > 60% 爬升 |
| 教训复发率 | 持续下降,4 周 < 25% |
| active 记忆占比 | > 70% |
| **账本-MemOS 映射一致率** | 100%(写入后 ledger 与 MemOS 无漂移) |
| **门面拦截率** | 100% 写入经 WriteGate(审计可证) |

---

## 十、风险与应对

| 风险 | 应对 |
|---|---|
| 迁移回归(已验证链路被重构打断) | 资产清单逐条勾销 + 每阶段冒烟 + 真机"不重复犯错"演示 |
| 一次性大爆炸 | M0–M4 每阶段可运行可暂停,不做绿地重写 |
| 配置不兼容 | 旧键→新键兼容映射,用户零改动 |
| 双轨期间逻辑重复 | M0–M2 导出别名 + 单测锁定行为 |
| 无测试基建 | M1 起补 vitest(WriteGate/Ledger/Retrieval 状态机),真机只做端到端 |
| 演化作业失控 | 沿用熔断 + 配额 + 幂等(M0 即迁移) |

---

## 十一、结论

- v5.0 不是"推翻重来",而是**把 v3.2 的经验、v4.0 的设计、v4.1 的优化装进一套干净的骨架**;
- 真正的增量收益:**G1–G5 五个结构性目标**——一个记忆抽象、一条写入通道、一条检索管线、一个闭环、一套测试;
- 判定标准:**12 项资产清单逐条勾销 + 每阶段可运行 + 端到端演示通过**,即视为重设计成功。

*文档结束。下一步:M0 开工(抽取 core/ + backends/,行为零变化)。*