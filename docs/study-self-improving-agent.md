# Self-Improving Agent 源码研究备忘(pskoett/self-improving-agent)

> 研究日期:2026-09-08
> 研究对象:[pskoett/self-improving-agent](https://github.com/pskoett/self-improving-agent)(746⭐)
> - **master 分支(4.0.2,OpenClaw-only 重制版)**:源码下载至 `refs/self-improving-agent-master/`(本次研究主对象)
> - **3.0.15 / 3.0.21(用户本地下载,多 agent 通用版)**:解压至 `refs/v3.0.15/`、`refs/v3.0.21/`(对比用)
> 研究方式:通读 README.md + `hooks/openclaw/handler.js` + `SKILL.md` + assets
> 结论:**印证了 v5.0 的方向(受监督、沉淀→晋升、复发计数),同时补上我们设计里缺失的 3 个真实缺口:写入脱敏、Pattern-Key 稳定去重键、pending 人工分流**

---

## 〇、版本关系(重要,用户本地 3.0.x vs 研究所用 master 4.0.2)

| 维度 | 3.0.15 / 3.0.21(用户本地) | master(4.0.2,本次研究主对象) |
|---|---|---|
| 定位 | 多 agent 通用版(Claude Code / Codex / OpenClaw 等) | OpenClaw-only 重制版(README 明示) |
| hook 能力 | **仅 bootstrap 提醒注入**(handler.js 112 行,**无错误扫描、无脱敏实现**) | bootstrap 提醒 + **session-end 错误 sweep + REDACTION_RULES 脱敏**(handler.js 448 行) |
| Pattern-Key | SKILL.md 已有文字规范(`area.symptom`、复发计数、promotion rule),但无自动打 key 的实现 | SKILL.md 完整 Taxonomy + **自动扫描条目标注 Pattern-Key** |
| 3.0.15 vs 3.0.21 | 仅 `_meta.json`、`examples.md` 不同 | — |

**结论**:三个缺口(GAP-1 脱敏 / GAP-2 Pattern-Key / GAP-3 pending)的**工程实现**都在 4.0.2(master)里;3.0.x 只有文字规范、没有自动实现。用户本地的 3.0.21 不是"最新机制",master 才是;但 3.0.x 的 **Multi-Agent Support / Generic Setup** 章节(跨 agent 激活方式)仍有参考价值,已保留在 `refs/v3.0.21/`。

---

## 一、它的核心机制(源码级)

### 1.1 三文件分类沉淀(SKILL.md 13-21 行)

```
.learnings/
├── LEARNINGS.md         # 纠错 correction / 洞察 insight / 知识缺口 knowledge_gap / 最佳实践 best_practice
├── ERRORS.md            # 命令/集成失败
└── FEATURE_REQUESTS.md  # 用户要的能力
```

- 每条条目带:`Priority(low|medium|high|critical)`、`Status(pending|resolved|in_progress|wont_fix|promoted)`、`Area`、`Pattern-Key`、`Recurrence-Count`、`First-Seen/Last-Seen`;
- **ID 生成**:`TYPE-YYYYMMDD-XXX`,`LRN-20250115-001` / `ERR-20250115-A3F`。

### 1.2 Pattern-Key 稳定去重键(它最聪明的机制,SKILL.md 330-363 行)

> `Pattern-Key` 是三个日志文件的稳定去重与复发计数键:**关键词 grep 会漏掉语义相同但措辞不同的条目,共享的 Pattern-Key 不会**。

- 格式:`area.symptom` 恰好两级、小写、连字符:`deps.module-not-found`、`shell.command-not-found`、`fs.permission-denied`、`net.connection-refused`;
- 模板区:`api / auth / build / config / deps / fs / net / runtime / shell / vcs / simplify / harden`;
- 规则:先复用后铸造(`grep -rh "Pattern-Key:" .learnings/ | sort -u`);每人工条目一个 key;通用 key(`runtime.error`)表示"未分类",人工分流时替换为具体 key;
- **handler.js 58-76 行**:错误扫描时按"具体→通用"顺序匹配,第一个命中模式的 Pattern-Key 打在扫描条目上,这就是"自动检测错误的可去重、可计数"来源。

### 1.3 复发计数与晋升(fold, don't duplicate)

- 查重:先按 `Pattern-Key` grep,再回退关键词;命中 → **折叠已有条目**(bump Recurrence-Count、更新 Last-Seen、加 See Also),而不是新建;
- **晋升规则(SKILL.md 403-415 行)**:**Recurrence-Count ≥ 3 且跨 ≥2 个任务且 30 天窗口内** → 晋升;
- 晋升目标按类型分流:`SOUL.md`(行为准则)/ `TOOLS.md`(工具坑)/ `AGENTS.md`(工作流);
- **晋升写成"短预防规则"(做之前/做的时候该做什么),不是长事故报告**(SKILL.md 414 行)。

### 1.4 会话结束扫描 + 脱敏(handler.js)

- OpenClaw 没有 per-tool-call hook,所以错误在 **session end** 扫描会话 transcript(JSONL)按错误模式正则抓取,截断到 200 字符;
- **写盘前脱敏(REDACTION_RULES,84-92 行)**:api_key/token/secret/password、`Bearer xxx`、GitHub token、slack token、AWS AKIA、JWT、≥40 位长 blob → 全部替换为 `[REDACTED]`;
- **opt-in 门**:只有 `.learnings/` 目录存在才扫(不打扰不用该技能的 workspace);
- **pending 分流**:自动扫描的条目以 `Status: pending` 落盘,等人确认/解决/删除,不自动可信;
- bootstrap 时注入"自我改进提醒"虚拟文件,并把待分流计数提示给 agent。

### 1.5 Skill 提取判定(594 行附近)

学习 → 独立 Skill 需满足任一:**Recurring**(≥2 个 See Also)/ **Verified**(resolved 且修复有效)/ **Non-obvious**(需要实际调试才发现)/ **Broadly applicable**(跨项目)/ **User-flagged**("存成 skill")。

---

## 二、与 v5.0 设计的对照

### 2.1 印证了我们的设计(方向正确)

| 我们的设计 | 它的对应 | 印证点 |
|---|---|---|
| 教训写入三审 + 验证 | 证据/务实、pending 不自动可信 | 「受监督的自我进化」是主流做法 |
| 复发 → failureCount++/版本 v+1 | Recurrence-Count、折叠不重复 | 「不重复犯错」的度量=复发计数,双方一致 |
| 晋升阈值 reinforcement≥3 | Recurrence-Count ≥ 3 且跨 2 任务且 30 天内 | **阈值 3 是业界共识级经验,直接用** |
| Skill 晋升(写预防性规则) | 晋升写"短预防规则",非长文案 | 我们的 SKILL.md 内容策略照此 |
| 周期演化 | Periodic Review(每周) | 一致 |

### 2.2 它补上的 3 个真实缺口(高价值,必采纳)

| # | 缺口 | 来源 | v5.0 修订 |
|---|---|---|---|
| **GAP-1 写入脱敏** | 我们 refiner 直接 `add/message` 提交 content,**没有任何脱敏层**;MemOS 是云端存储,泄密风险 > 它的本地 markdown | handler.js REDACTION_RULES | **WriteGate 增加脱敏层**:写入 MemOS 前对 api_key/token/secret/Bearer/JWT/长 blob 正则替换;审计同样脱敏 |
| **GAP-2 Pattern-Key 去重键** | 我们教训查重用 `scenario` 文本搜索 + 正则解析 failureCount,**语义相同但措辞不同的错误会重复入库** | SKILL.md 330-363 | 账本条目增加 `patternKey: 'area.symptom'`;**写入时先按 patternKey 查重**(ledger 索引),命中即折叠递增,不新建;错误扫描自动打 key |
| **GAP-3 pending 人工分流** | 我们自动写入即视为有效,即使验证通过也只是"入库了" | Status: pending → triage | 自动链路(evolve/lesson 升级/错误扫描)产物默认 `status: pending`;账本区分 `pending/active`;**active 才参与召回注入**,pending 等人工确认(可 `/evolve --confirm` 批量确认) |

### 2.3 它不如我们的地方(不多抄)

| 方面 | 它(文件+grep) | 我们(MemOS+账本) | 说明 |
|---|---|---|---|
| 检索 | grep 关键词/Patter-Key | search/memory 语义检索 + ledger 状态索引 | 我们更强 |
| 触发 | 靠模型自觉检测触发词 | session/event 事件流自动触发 | 我们更强 |
| 记忆持久 | 本地 markdown | MemOS 云端 + 本地账本 | 语义不同,定位不同 |
| 跨会话 | sessions_* 工具手动 | memos-cloud 自动召回 | 已内置 |

---

## 三、对 v5.0 文档的修订(已合入)

1. **WriteGate(3.2 节)**:写入四审中新增「零审:接入脱敏层(GAP-1)」,一审证据/二审置信度/三审查重(patterKey)之后,提交前统一脱敏;
2. **账本条目(EvolutionEntry)**:增加 `patternKey: string` 字段 + `triage: 'pending'|'acknowledged'|'active'` 字段;`status=active` 才可被召回注入;
3. **错误观察(observer)**:错误扫描按 Pattern-Key 聚类(替代纯 consecutiveToolFailures 计数),自动条目落 pending;
4. **演化/晋升**:晋升阈值沿用 `reinforcement ≥ 3 且跨 ≥2 任务且 30 天内`;Skill 内容按"短预防规则"风格生成;提取满足任一判定(Recurring/Verified/Non-obvious/Broadly applicable/User-flagged);
5. **新增命令**:`/evolve --confirm`(批量确认 pending→active)、`/memos-lint`(grep 审计中的脱敏遗漏,可选 P4)。

---

## 四、一句话结论

> 下载深入研究**有价值,且已兑现**:它用 10 分钟级的轻量实现验证了「复发计数 + 阈值3晋升 + 人工分流」的通用性,并让我们发现了**脱敏、稳定去重键、pending 分流**三个必须补进 v5.0 的安全与质量缺口——这些是仅靠理论设计很难提前意识到的。