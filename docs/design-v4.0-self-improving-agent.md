# DSH × MemOS Self-Improving Agent(自我进化)架构设计 v4.0

> ⚠️ 本设计已做 SIA 范式评审,增量优化见 [design-v4.1-sia-optimizations.md](./design-v4.1-sia-optimizations.md)(O1 记忆编辑工具 / O2 会话整合 / O3 自我评估触发 / O4 记忆不平权检索 / O5 黄金路径即时晋升 / O6 双区注入+引用确认 / O7 元优化报告)
> 版本：v4.0(设计稿)
> 日期：2026-09-08
> 定位：在 v3.2 反思闭环(写入可信化)之上,补上**记忆进化的另一半**——让 AI 记住教训、不再重复犯错,让 MemOS 记忆持续进化
> 目标栈：DeepSeek Harness (DSH) + MemOS Cloud + dsh-reflection-memos v0.1.0
> 核心哲学：**沉淀(Sediment)→ 应用(Apply)→ 演化(Evolve)** 三段闭环,对应 Self-Improving Agent 的"失败→反思→写入→下次应用→验证→强化/衰减"范式

---

## 一、为什么需要 v4.0(现状缺口)

v3.2 已解决:"写入受控" —— 所有记忆经三审后才进 MemOS,并轮询 search 验证入库,召回由 memos-cloud 负责。

但当前闭环是**单向的、只长不进化**的:

| 缺口 | 现状 | 后果 |
|---|---|---|
| 教训被动等召回 | 教训只是"可能被召回",不保证在相关任务前被主动注入 | 犯错后第二次仍可能踩同一个坑 |
| 教训无遵守验证 | 无法知道注入的教训有没有被执行 | 无法度量"是否不再重复犯错" |
| 记忆只增不改 | MemOS 无 update/delete 接口,每次修正只能新增 | 旧错误版本仍会被召回,知识越堆越乱 |
| 无合并/去重 | 同类教训多次写入,只靠 failureCount 递增 | 记忆冗余、互相矛盾 |
| 无强化/衰减 | 高频命中的记忆与长期无用的记忆地位相同 | 无法区分"黄金记忆"与"垃圾记忆" |
| 无能力晋升 | 反复验证有效的教训停在小事上 | 无法沉淀为可复用的 Skill(能力进化) |

**Self-Improving Agent 的目标**：让闭环从"写入正确"进化到"**应用正确、复用正确、持续变强**"。

---

## 二、总体架构:v4.0 三段闭环

```
                      ┌────────────────────────────────────────────────┐
                      │           Self-Improving Agent 闭环             │
                      └────────────────────────────────────────────────┘
                                                                      
   ① 沉淀(Sediment) ←──────── 已有 v3.2(不变) ─────────┐             
   执行轨迹 → Observer → Reflector 三审 → Refiner 写入 MemOS      │ 新增
                                                                   ▼
   ② 应用(Apply)【新增】                                 ③ 演化(Evolve)【新增】
   ┌──────────────────────────┐                 ┌──────────────────────────┐
   │ Applier 模块              │                 │ Evolver 模块              │
   │ · pre-step 教训主动注入     │                 │ · 合并 Consolidation       │
   │ · turn/end 遵守验证        │◀── 账本 ───────▶│ · 更正 Correction          │
   │ · 违反 → failureCount++    │   (Ledger)      │ · 强化 Reinforcement       │
   │ · 遵守 → reinforcement++   │                 │ · 衰减 Decay / 归档        │
   └─────────────┬────────────┘                 │ · 晋升 Promotion → Skill   │
                 │                              └─────────────┬────────────┘
                 ▼                                             ▼
        MemOS(历史库,只增)  ──────────────►  本地账本(工作态:版本链/状态/统计)
        + memos-cloud 召回                         ~/.dsh/reflection/evolution.db
```

**三层职责**

| 层 | 模块 | 回答的问题 | 复用现状 |
|---|---|---|---|
| 沉淀层 | observer / reflector / refiner | 什么值得写? | ✅ v3.2 原样保留 |
| 应用层 | **applier(新增)** | 写了的怎么用? | 复用 executor 的 pre-step / observer 的 session/event |
| 演化层 | **evolver(新增)** | 记忆怎么变强? | 复用 refiner 写入通道(MemOSWriter)+ reflector 子代理模式 |

**关键设计决策：MemOS 是"历史的记录者",本地账本是"进化的决策者"。**

由于 MemOS 公开 API 只有 `add/message`(追加)与 `search/memory`(检索),没有 update/delete:
- MemOS 保留**完整版本历史**(演化也走 add 追加,内容自标注版本链);
- 插件本地维护**演化账本(Evolution Ledger)**,记录每条记忆的版本链、状态、命中/强化/违反统计;
- 每次召回后,插件用账本做**召回覆盖层(Recall Overlay)**:标记 active / superseded,并过滤已归档条目,避免旧版本误导 agent。

---

## 三、演化账本(Evolution Ledger)

### 3.1 存储

```text
~/.dsh/reflection/
├── evolution.db          # 账本(JSON Lines,与 audit 同风格;小规模无需 SQLite)
├── audit-YYYY-MM-DD.jsonl
└── debug-YYYY-MM-DD.log
```

### 3.2 账本条目结构

```typescript
// src/types/evolution.ts
export type MemoryStatus =
  | 'active'      // 有效,正常召回
  | 'superseded'  // 已被新版本替代
  | 'merged'      // 已被合并进规范条目
  | 'decayed'     // 长期未命中,降级不主动召回
  | 'archived';   // 归档(不召回,保留历史)

export type MemoryKind = 'fact' | 'lesson' | 'normal';

export interface EvolutionEntry {
  memoryKey: string;          // 主键 = 内容指纹 sha256(content 前 80 字符)
  kind: MemoryKind;
  status: MemoryStatus;
  version: number;            // 版本号,每写一次新版本 +1
  supersedes: string[];       // 本版本替代了哪些 memoryKey
  supersededBy?: string;      // 本版本被哪个 memoryKey 替代
  confidence: number;         // 置信度(0-1)
  failureCount: number;       // 教训:累计失败次数
  reinforcementCount: number; // 教训:被遵守且成功的次数
  hitCount: number;           // 被召回/命中次数
  violationCount: number;     // 教训:注入后仍违反的次数
  firstSeen: string;          // ISO 时间
  lastSeen: string;           // 最近一次命中/写入
  category?: string;
  scenarios: string[];        // 教训适用场景
  contentHash: string;
  note?: string;              // 演化备注(如"合并自 A,B")
}
```

### 3.3 状态机

```
                  写入时查重(processLesson 已有)
   new ──────────────────────────────► active
                                       │ ▲
        违反教训(应用层)◄───────────────┤ │ 遵守 + 成功(应用层)
        failureCount++ / 版本 v+1       │ │ reinforcementCount++
                                       ▼ │
              演化层合并/更正 ──► superseded / merged
                                       │
               长期未命中(衰减扫描) ────► decayed ──► archived
```

规则:

1. **归档防震荡**:账本记录 `supersedes` 有向图,禁止 A→B→A 循环(合并回滚会触发版本链震荡);
2. **版本链上限**:同一 `scenario+kind` 的版本链 ≥ 5 代时,演化层必须合并为规范条目(Canonical),不再放任无限追加;
3. **覆盖层原则**:召回展示时,同 memoryKey 只展示最新 active 版本;superseded/merged/archived 不出现在注入内容中。

---

## 四、应用层(Applier)——记住教训,不再重复犯错

### 4.1 职责

| 时机 | 动作 |
|---|---|
| `agent/pre-step`(执行前) | 从最近 user 消息提取任务意图 → search 相关教训(lesson_learned)→ 注入「本次任务需遵守的教训」提示块 |
| `tool/result` / `turn/end`(执行后) | 对照「注入的教训」与「执行轨迹」判定 complied / violated / not-applicable,回写账本 |
| 违反时 | failureCount++、severity 视情况升级、写入 v+1 版本(经 refiner 验证通道),并计入审计 |
| 遵守且成功时 | reinforcementCount++,计入审计;满足晋升条件时通知演化层 |

### 4.2 教训注入(pre-step)

- 复用 executor 已挂的 `agent/pre-step` 钩子(`payload.agent` 缓存已存在);
- **只注入"任务相关"的教训**:用最新 user/message 文本做 query,`filter: { user: { tags: { contains: 'lesson_learned' } } }`,取 top K(K 默认 3,按 severity + 账本最新命中排序);
- 注入形态:追加一条紧凑的 user 风格提醒块(不改 systemPrompt,遵循 v3.2 结论——pre-step 只能改 messages):

```text
【经验提醒(来自 MemOS 教训库)】
- 场景「部署 DSH Web」:不要直接 pkill 全部 dsh 进程,正确做法是用 launch-stop.sh 优雅停止。(已失败 3 次,违规将升级教训)
- 场景「FTP 覆盖文件」:先备份再覆盖,使用 sync_test_files.py 流程。
(仅跟随正确做法;如场景不符可忽略)
```

- 限额:单次注入 ≤ 3 条、每条 ≤ 200 字符,防止污染上下文与浪费 token;
- 注入动作记入审计(`kind: 'lesson-injected'`),供统计遵守率。

### 4.3 遵守验证(compliance check)——闭环的关键一环

**为什么必须做**:没有验证,"不重复犯错"就是一句空话。这也是 SIA 范式与普通记忆插件的本质区别。

- 触发:turn/end(复用 observer 的 reason.kind 判定)+ 本轮存在注入教训;
- 实现:异步拉起轻量子代理(复用 reflector 的 spawn 模式,`maxDepth: 1`、`toolFilter: { allow: [] }`、persona 约束 + JSON 输出),输入=注入教训列表 + 轨迹摘要,输出:

```json
{ "checks": [ { "memoryKey": "...", "verdict": "complied|violated|not-applicable", "evidence": "..." } ] }
```

- 成本控制:仅对 severity=high/medium 且账本 active 的教训做验证;异步执行,不阻塞对话;每日验证量设上限(默认 20 条);
- 结果回写账本:violation → `violationCount++`/`failureCount++`,并触发 refiner 写 v+1 新教训;**只有 violation 才消耗写入配额**,compliance 只记账本,不写 MemOS。

---

## 五、演化层(Evolver)——让 MemOS 记忆进化

### 5.1 四类演化作业

| 作业 | 触发 | 输入 | 动作 | 输出 |
|---|---|---|---|---|
| **合并 Consolidation** | 周期(默认每日)+ `/evolve` | 账本中同 category/scenario 候选 | 子代理生成规范条目(合并重复教训/事实),标注 `supersedes:[keys]` | 写 1 条规范版本;账本把旧条目置 `merged` |
| **更正 Correction** | 周期 + 用户纠错反思命中冲突 | 同场景、结论互相矛盾的 active 记忆 | 子代理裁决并生成更正版 | 写 v+1;旧版本置 `superseded` |
| **强化/衰减 Reinforcement/Decay** | 周期(默认每周) | 账本统计 | 高频命中+高强化 → 提升权重标注;长期未命中(默认 30 天)→ `decayed` | 只改账本;decay 满 N 天(默认 60)→ `archived` |
| **晋升 Promotion** | 周期(默认每周) | 满足条件的教训 | 生成 Skill 草案写入 `~/.dsh/skills/<name>/SKILL.md` | Skill 文件(watcher 自动发现) |

### 5.2 合并(Consolidation)细节

- 候选筛选:账本中同 `scenario` 或同 `category` 且互为高 relativity(`searchMemory` 两两命中 ≥ 0.7)的 active 条目;
- 子代理输入:候选条目的 memory_value + 账本统计(failureCount/version);
- 输出 schema(遵守 subagents 的 outputSchema 约束,无 pattern/format/numeric bounds):

```json
{
  "canonicalContent": "合并后的规范表述(含版本链说明「本规范 v3 合并自 v1/v2」)",
  "supersedeKeys": ["<key1>", "<key2>"],
  "kind": "fact|lesson",
  "confidence": 0.9
}
```

- 写入仍走 refiner 通道:`add/message`(tags 带 `consolidated`,`evl:merged`)+ search 验证 + 审计;
- **净信息增益门槛**:合并后的规范条目必须比"合并前所有条目信息总和"更精简且不丢失关键差异,否则放弃合并(防「合并震荡」)。

### 5.3 更正(Correction)细节

- 冲突检测:定期对同 scenario 的 active 教训/事实做两两 search,relativity ≥ 0.8 且结论方向相反 → 冲突候选;
- 裁决子代理输入:两条结论 + 各自证据 + 账本命中统计(证据更充分、命中更多的一方权重更高);
- 输出:`{ winnerKey, correctedContent?, reason }`;
- 处理:能直接判断 → 对败方写"更正说明"并置 `superseded`;无法判断 → 都置 `active` 但账本标记 `conflict`,下次用户纠错优先走此场景。

### 5.4 晋升(Promotion)→ Skill 能力进化

- 候选条件:**reinforcementCount ≥ 3 且 violationCount/(reinforcementCount+violationCount) < 20%**(即"反复验证有效、极少再犯");
- 产出:复用 v3.2 的 SkillManager 模式写入 `~/.dsh/skills/<name>/SKILL.md`(description 单行化防 YAML 解析挂掉);
- `refiner.autoUpdateSkills` 开关控制是否自动写入(默认 false,手动 `/evolve --promote` 确认);
- Skill 与记忆的关系:Skill 是"执行时的方法论",记忆是"情境化的历史";晋升后原教训保持 active,但注入优先级让位于 Skill 名匹配。

### 5.5 演化控制与防呆

- **写仍然收紧**:演化层所有 MemOS 写入与 v3.2 同标准——三审 + search 验证 + 审计 + 每日配额(共享 `maxMemoriesPerDay`);
- **子代理护栏**:演化子代理 `maxDepth: 1`、无工具、persona 强约束;失败不影响主流程;
- **熔断**:演化作业连续失败 3 次 → 暂停至 30 分钟后(复用自动反思熔断模式);
- **幂等**:同一次演化作业的结果按 `contentHash` 去重,重复触发不会重复写;
- **可回滚**:账本保留 `supersedes` 图,若新规范版本被证伪,可追溯恢复上一 active 版本。

---

## 六、召回覆盖层(Recall Overlay)

memos-cloud 的自动召回是"原始版"(可能包含 superseded/merged 旧记忆),v4.0 增加**只读覆盖层**:

- 不接管 memos-cloud 召回(读放开原则不变);
- 插件在 `agent/pre-step` 时,对召回结果按账本做一次本地重排/过滤:
  - 剔除 `archived` / `superseded / merged`(被替代者)条目的重复内容;
  - 同主题多版本只保留最新 active 版本;
  - 对 high-severity 教训追加"强制提醒"标记(见 4.2 注入块);
- 系统提示词规则(`memo_rules`)同步升级,明确"账本标注 superseded 的记忆视为过期,优先使用标注 active 且版本号更高的记忆"。

---

## 七、新增模块与代码结构

```
src/
├── ledger/
│   ├── store.ts              # 演化账本:读/写/状态机(JSONL,原子写)
│   └── index.ts              # 对外查询:按 scenario/category 取 active 条目、版本链
├── modules/
│   ├── applier.ts            # 【新增】应用层:pre-step 教训注入 + turn/end 遵守验证
│   ├── evolver.ts            # 【新增】演化层:合并/更正/强化衰减/晋升(周期作业 + /evolve)
│   ├── ...(observer/reflector/refiner/planner/executor 不变)
├── types/
│   └── evolution.ts          # 【新增】账本条目/状态/演化作业结果类型
├── prompts/
│   ├── compliance-schema.ts  # 【新增】遵守验证输出 JSON Schema
│   └── consolidation-schema.ts # 【新增】合并/更正裁决输出 JSON Schema
└── commands/index.ts         # 新增 /evolve /lesson-check /memory-report
```

### 7.1 配置新增(延续 current() 热更新模式)

```yaml
dsh-reflection-memos:
  applier:
    enableLessonInjection: true     # 执行前主动性教训注入
    maxLessonsPerInjection: 3       # 单次注入教训条数上限
    lessonInjectionMaxChars: 200    # 单条教训注入长度上限
    enableComplianceCheck: true     # 执行后遵守验证
    maxComplianceChecksPerDay: 20   # 每日遵守验证上限
  evolver:
    enablePeriodicEvolution: true
    consolidationIntervalHours: 24  # 合并作业周期
    promotionIntervalHours: 168     # 晋升作业周期(每周)
    minReinforcementForPromotion: 3 # 晋升最低强化次数
    maxViolationRateForPromotion: 0.2 # 晋升最高违反率
    decayAfterDays: 30              # 未命中多少天 → decayed
    archiveAfterDays: 60            # decayed 多久 → archived
    maxVersionChain: 5              # 版本链上限,超过强制合并
```

### 7.2 新增事件(走 Cordis 事件总线)

| 事件 | 触发 | 数据 |
|---|---|---|
| `lesson/injected` | 教训注入后 | `{ memoryKey, scenario, agentId }` |
| `lesson/complied` | 遵守验证通过 | `{ memoryKey, evidence }` |
| `lesson/violated` | 违反教训 | `{ memoryKey, evidence, newFailureCount }` |
| `evolution/consolidated` | 合并完成 | `{ canonicalKey, supersedeKeys }` |
| `evolution/corrected` | 更正完成 | `{ winnerKey, loserKey }` |
| `evolution/promoted` | 晋升 Skill | `{ skillName, memoryKey }` |

### 7.3 新增命令

| 命令 | 说明 |
|---|---|
| `/evolve [--promote]` | 手动触发一次演化作业(合并/更正/衰减;`--promote` 追加晋升扫描) |
| `/lesson-check` | 查看最近教训注入与遵守/违反情况 |
| `/memory-report` | 生成记忆质量报告(版本链、active 占比、复发率、合并数) |

---

## 八、指标与验证标准(如何证明"真的在进化")

### 量化指标

| 指标 | 定义 | 目标 |
|---|---|---|
| 教训复发率 | `violationCount / (reinforcementCount + violationCount)` | 持续下降,4 周后 < 25% |
| 教训遵守率 | `complied / (complied + violated)` | > 60% 并爬升 |
| 记忆有效性 | active 条目占比 = active / 全部账本条目 | > 70%(冗余被合并/归档) |
| 版本链收敛 | 平均版本链长度 | ≤ 2(合并生效) |
| 事实证伪率 | 被引用 verified_fact 事后被证伪比例 | < 5% |
| 合并效率 | 每周合并条数 / 每周新增条数 | 10%-25% |
| Skill 复用率 | 晋升 Skill 被后续任务引用次数 | 上升 |

### 定性验证(演示脚本)

1. **不重复犯错**:故意重复执行一个已沉淀教训的失败场景(如直接 pkill dsh),验证第二轮 pre-step 注入提醒、agent 改用 launch-stop.sh;
2. **记忆进化**:人为提交 3 条同场景冗余教训 → `/evolve` 后账本显示 1 条 canonical + 2 条 merged,召回不再出现重复;
3. **矛盾更正**:提交两条互相矛盾的事实 → `/evolve` 裁决后旧结论标记 superseded,新结论带更正说明;
4. **Skill 晋升**:制造一个反复成功场景(>3 次强化)→ 晋升作业生成 SKILL.md,后续同类任务 agent 直接采用该 Skill。

---

## 九、落地路径(分四期)

| 期 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **P0 账本与覆盖**(1-2 天) | Evolution Ledger 存储 + 状态机;召回覆盖层过滤 superseded/archived | v3.2 已完成 | `/lesson-check` 可显示版本链与状态 |
| **P1 应用闭环**(2-3 天) | Applier:pre-step 教训注入 + turn/end 遵守验证 + 违反升级写入 | P0 | 定性验证 1 通过 |
| **P2 演化作业**(3-5 天) | Evolver:合并/更正/强化衰减 + `/evolve` + 周期作业 | P1(refiner 复用) | 定性验证 2、3 通过 |
| **P3 能力晋升**(1 周) | Promotion → Skill 写入 + 记忆质量报告 + 回归脚本 | P2 | 定性验证 4 通过;量化指标达标 |

---

## 十、风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 注入教训污染正常对话 | 上下文浪费 / 干扰判断 | 仅工具型任务注入、≤3 条、≤200 字符、可配置关闭 |
| 合并震荡(版本反复互相替代) | 版本链膨胀、混淆 | supersedes 有向图防环 + 版本链上限 5 + 净信息增益门槛 |
| 遵守验证消耗 token | 成本上升 | 仅 high/medium 教训验证、异步、每日上限 20 |
| 错误合并/错误更正 | 优质记忆被覆盖 | 只写新版本不物理删除、账本可回滚、证据必选 + 三审 |
| MemOS 抽取不忠实演化写入 | 规范版本入库走样 | 演化写入同样 search 验证;账本为主、MemOS 为历史 |
| 演化作业死循环/递归 | 进程卡死 | maxDepth 1、无工具、熔断(连续 3 次失败暂停 30 分钟)、幂等 |
| 召回旧版本误导 agent | 用了过期教训 | 召回覆盖层过滤 + memo_rules 明确"优先 active 高版本" |

---

## 十一、与 Self-Improving Agent 范式的关系

SIA 的核心是四步:**失败(Fail)→ 反思(Reflect)→ 改进应用(Apply)→ 验证(Verify)**,循环往复,每次循环留下比上次更可靠的"自身知识"。

| SIA 步骤 | v4.0 实现 | 状态 |
|---|---|---|
| Fail(失败/错误发生) | observer 事件采集(tool 失败、用户纠错、task 未完成) | ✅ 已有 |
| Reflect(反思) | reflector 三审子代理 | ✅ 已有 |
| Improve(改进写入) | refiner 写入 MemOS(v+1 新版本) | ✅ 已有 |
| **Apply(下次应用)** | **applier 教训主动注入 + 遵守验证** | 🆕 本设计 |
| **Verify(验证改进有效)** | **compliance check → reinforcement/violation 统计** | 🆕 本设计 |
| **Evolve(记忆持续进化)** | **合并 / 更正 / 强化衰减 / 晋升 Skill** | 🆕 本设计 |

v3.2 完成了"写",v4.0 完成"用"与"进化"——三者合起来才是完整的 Self-Improving Agent:**让 AI 记住教训、不再重复犯错,并让 MemOS 记忆随使用持续进化**。

---

## 十二、实施备注(代码级提示)

1. **账本查询优先于 MemOS 查询**:应用/演化层所有"当前状态"判定(是否 active、failureCount、版本)一律查账本;MemOS search 只用于"发现候选+验证入库";
2. **遵守验证子代理复用 reflector 的 spawn 模式**:`prompt` 必须传 content block 数组;`signal` 必须可用;`run.result` 取结果后立即 `dispose`;
3. **outputSchema 约束不变**:遵守验证/合并裁决 schema 只允许 type/properties/required/items/enum/const/oneOf,禁止 pattern/format/minimum;
4. **写入配额共享**:violation 升级写入与演化写入与反思写入共用 `maxMemoriesPerDay`,防止演化作业挤占日常沉淀;
5. **compliance 与 observer 的联动**:turn/end 判定成功后,先跑"是否值得遵守验证"(有注入教训且 severity≥medium),再决定是否拉起子代理,避免纯闲聊场景空转;
6. **账本原子写**:JSONL 追加 + 每次写前 `fsync`(小文件,日写量 < 千级,无需 SQLite)。

---

*文档结束。落地时可先跑 P0+P1(2-5 天)验证"不重复犯错"闭环,再推进 P2/P3 的演化与晋升。*