# Self-Improving Agent 范式借鉴:对 v4.0 设计的评审与优化(v4.1)

> 版本：v4.1(评审结论,作为 design-v4.0 的优化补丁)
> 日期：2026-09-08
> 问题：Self-Improving Agent(SIA)范式对已有 v4.0「沉淀→应用→演化」设计有帮助吗?能优化哪些点?
> 结论：**有,而且能补上 v4.0 最关键的 4 块短板**(记忆编辑权、会话级沉淀、自我评估触发、检索权重);同时 SIA 里"无监督自主改记忆/自我改内核"的激进部分**不应采纳**,我们坚持"受监督的自我进化"。

---

## 一、结论摘要

| 维度 | 评价 |
|---|---|
| v4.0 已覆盖 SIA 的比例 | ≈ 60%(反思闭环 ✅ / 教训应用 ✅ / 周期演化 ✅ / Skill 晋升 ✅) |
| SIA 能补上的关键机制 | 4 个(见二) |
| 需要警惕 / 不采纳的 SIA 激进面 | 3 个(见四) |
| 优化后版本 | 本章作为 v4.1 = v4.0 + 7 项优化(O1–O7) |

---

## 二、借鉴来源与量化对照

| SIA 项目/范式 | 核心思想 | v4.0 现状 | 借鉴价值 |
|---|---|---|---|
| [Letta(原 MemGPT)](https://github.com/letta-ai/letta) | 有状态 agent 的记忆操作系统:核心记忆(常驻)与归档记忆(按需检索)、**记忆编辑工具**、**sleep-time 会话整合**、上下文压力压缩 | 只有"事后反思→写教训",agent 无权自己改记忆;不沉淀会话级经验 | **高** → O1、O2 |
| [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) | 面向编码/长任务的自改进 agent,任务开始注入 lesson、任务结束复盘 | pre-step 注入+遵守验证已设计(4.1-4.3 节) | 中(验证已有设计方向) → O3 补强 |
| [HyperAgents](https://github.com/facebookresearch/HyperAgents) | 自我指涉:agent 持续优化自身的提示词/技能(元层改进) | 只有"记忆→Skill 单向晋升",没有"改进自己的改进" | 中 → O7 |
| [self-learning-skills](https://github.com/Kulaxyz/self-learning-skills) | 会话中识别"来之不易的黄金路径",**当场**收割为可复用 Skill | 晋升靠周期扫描(周),错过即时价值 | **高** → O5 |
| [metabot](https://github.com/xvirobotics/metabot) | 受监督的自我进化组织:共享记忆 + meta-skill + 定时任务 | 定位一致(受监督) | 定位确认(不追求全自主) |
| Reflexion(文献) | 语言强化学习:**agent 自我评估** episode 成败 → 反思文本 → 注入下次尝试 | overallScore 有字段但未作触发信号 | **高** → O3 |
| Generative Agents(文献) | 记忆流:检索权重 = 相关性 × **重要性** × 时效性;反思树从低层记忆归纳高层洞察 | 检索只看 relativity,记忆平权 | **高** → O4 |

---

## 三、优化项(v4.1 增量设计)

### O1 记忆编辑工具(MemoryEditTool)——把"事后演化"变成"事中自我修正"

- **动机**:v4.0 里记忆只有两个入口(反思闭环、演化作业)。SIA(Letta)的关键差异是 **agent 本人在执行中发现记忆过时/矛盾/未被遵守时,有权主动发起修正**。
- **设计**:注册 2 个只读+1 个受限工具给主 agent:
  - `memos_lookup(query, scenario?)` — 查账本当前 active 版本(替代裸 search,自动过滤 superseded);
  - `memos_lesson_ack(scenario)` — 本轮任务开始,声明"将遵守教训 X"(O6 配套);
  - `memos_correct(memoryKey, reason)` — **受限写**:不直接写 MemOS,而是投递一条 `correction-request` 事件 → 反射层子代理按三审标准重审(证据是否充分、是否真矛盾)→ 通过才走 refiner 写入 v+1,账本标记 superseded。
- **护栏**:`memos_correct` 每天限 N 次(默认 5);只接受"更正已有条目"不接受"新增任意记忆"(新增仍归反思闭环)— 防止 agent 顺手乱写。

### O2 会话整合(Episodic Summarizer)——沉淀"过程经验"而不只是"结论"

- **动机**:v3.2/v4.0 沉淀的是反思产出的"语义记忆"(事实/教训),**整段会话的"过程经验"(情景记忆)被丢弃**。SIA(Letta sleep-time)把闲时对话压缩成情景记忆。
- **设计**:演化作业增加 `session-synthesis` 子作业(可与合并作业同周期):
  - 输入:过去 24h 内、`observer` 缓存的关键轨迹(turn/end 已收集,天然可用);
  - 输出:Episodic 条目——`{ scenario, steps, pitfall, outcome, tags }`(150 字内);
  - 去向:写入账本 `kind: 'episodic'`(**不写 MemOS**,避免污染语义记忆库),命中规则仍是"将来同类任务先查 episodic 再看 facts/lessons"——作为**检索的冷启动线索**。
- **价值**:我方的典型场景(FTP 部署、DSH 重启、onetab 构建)的"上次怎么绕过来的"这类过程知识,才有了落点。

### O3 自我评估触发(Reflexion-style Self-Eval)——不依赖用户反馈也能复盘

- **动机**:目前只有"任务失败/用户纠错"触发深度反思;任务"看似完成但质量差"时无信号。Reflexion 的做法是 **agent 对照成功标准自评**。
- **设计**:
  - turn/end 且 completed 时,若任务有明确成功标准(plan-and-execute 必带),异步拉起轻量自评子代理:`{ selfScore, weakPoints[], followUpReflection: boolean }`;
  - `selfScore < 0.5` → 与 task 反思同权触发,并把自评作为 `userFeedback` 补充给 Reviewer;
  - 复用现有 `overallScore` 字段(反思结果已有,只是没用于触发),改动极小。

### O4 检索排序:相关性 × 重要性 × 时效性(记忆不平权)

- **动机**:Generative Agents 的核心——记忆检索不是纯相关性,还要"重要+最近"。
- **设计**:
  - 账本 `EvolutionEntry` 增加 `importance: number`(0-1,写入时由 Reviewer 顺带给,规则:影响面大/反复出现的场景高);
  - Applier 注入排序分 = `relativity × (0.6 + 0.4×importance) × recencyBoost`;
  - 新增 `hitCount`/`lastSeen` 已在 v4.0 账本模型里,直接补 `importance` 即可;
  - 衰减作业(decay)改为**先按 importance 降权而不是直接归档**:importance ≥ 0.8 的记忆衰减期 ×3。

### O5 黄金路径即时晋升(Golden-path Harvesting)

- **动机**:self-learning-skills 的洞察——"这次费了大力气才走通的路,下次不该再试错一遍"。周扫描晋升太慢。
- **设计**:在 `reflection/task-complete`(completed)分支加一步 `harvest`:
  - 条件:本次任务用了 ≥3 次工具调用 且 最后成功;轨迹里存在"试错→修正→成功"模式(由轻量子代理判定,`goldenPath: true/false`);
  - 命中 → 即时生成 Skill 草案写入 `~/.dsh/skills/`(若 `autoUpdateSkills` 开启),或生成"待确认 Skill"提示用户 `/evolve --promote`;
  - 与 O2 的关系:黄金路径技能 = 情景记忆的"可执行化"产物。

### O6 双区记忆注入 + 教训引用确认(Lesson Acknowledgment)

- **动机**:Letta 的核心记忆/归档记忆分离;prime-agent 强调 lesson 必须"被计划引用"才有效。
- **设计**:
  - 注入分两区:**核心区**(≤3 条,每轮常驻:高频用户偏好/高 importance 教训)与**情境区**(按任务 query ≤3 条);总注入 ≤5 条、≤600 字符;
  - pre-step 注入末尾附"请在本轮开头说明将如何应用这些经验(一句话即可)";
  - compliance 检查由此获得更强信号:agent 是否**显式 ack**(ack 后仍违反 → violation 权重 ×2,记入账本)。

### O7 自我指涉的元优化(报告驱动插件自身调参)

- **动机**:HyperAgents 自我指涉;落地简化版——让系统"改进自己的改进参数"。
- **设计**:每周 `memory-report` 除质量指标外,输出**参数建议**:
  - 某场景教训 violation 率 > 50% → 建议提高该场景注入条数 / severity 升级;
  - 某类教训注入后 ack 率 < 30% → 建议降权或合并进 Skill;
  - 合并作业产出 < 阈值 → 建议调高 relativity 候选阈值;
  - 建议以"diff 形式"输出,人工确认后写配置(仍受监督,不自动改配置)。

---

## 四、明确不采纳的 SIA 激进面

| 激进面 | 为什么拒绝 |
|---|---|
| agent 无监督自主改记忆(直接 memory_edit 写库) | 违背 v3.2「写收紧、三审、证据必选」立身之本;错误记忆自我强化风险高;O1 已用"受限写+三审放行"替代 |
| 自我修改内核/系统提示词(全自主 recursive self-improvement) | DSH 插件零侵入内核原则;HyperAgents 类全自主在工程场景不可控 |
| 完全开放的 agent 池/自我复制(进化种群) | 超出"记忆进化"边界,维护成本与失控风险不成比例 |

---

## 五、落地优先级(与 v4.0 分期合并)

| 阶段 | v4.0 原内容 | + v4.1 SIA 优化 |
|---|---|---|
| P1 应用闭环(2-3 天) | 教训注入 + 遵守验证 | **+ O3 自我评估触发**;O6 双区注入+ack 直接并入 4.2/4.3 节设计 |
| P2 演化作业(3-5 天) | 合并/更正/强化衰减 | **+ O1 memos_correct 编辑工具**;**O5 黄金路径即时晋升**(先于周扫描) |
| P3 会话与能力(1 周) | Promotion + 质量报告 | **+ O2 会话整合(episodic)**;O4 importance 检索排序;O7 元优化报告 |
| 贯穿 | 熔断/配额/幂等 | 不变(编辑工具与演化写入共享配额与验证通道) |

---

## 六、引用来源

- [letta-ai/letta — Platform for stateful agents: AI with advanced memory that can learn and self-improve over time](https://github.com/letta-ai/letta)
- [PrimeIntellect-ai/prime-agent — A self-improving RLM agent for coding workflows and long-running autonomous tasks](https://github.com/PrimeIntellect-ai/prime-agent)
- [facebookresearch/HyperAgents — Self-referential self-improving agents](https://github.com/facebookresearch/HyperAgents)
- [Kulaxyz/self-learning-skills — Harvest a hard-won golden path into a reusable skill](https://github.com/Kulaxyz/self-learning-skills)
- [xvirobotics/metabot — 受监督的、自我进化的 Agent 组织基础设施](https://github.com/xvirobotics/metabot)

*文档结束。评审结论:帮助明确,采纳 O1–O7,拒绝"无监督自主改记忆/自我改内核";整体保持在"受监督的自我进化"边界内。*