# dsh-reflection-memos

DSH × MemOS 反思闭环插件 — 让每次 Agent 执行的结论、教训、配置结论都经过验证后才写入 MemOS 长期记忆,并自动被后续对话召回。

> 基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) + [MemOS Cloud](https://memos.memtensor.cn) 构建  
> 文档版本：v3.2 → v3.1 实现修复  
> 开发日期：2026-08-31 / 09-01

---

## 核心原理

```
DSH Session (原始层) ──┐
                       ├─▶ 插件本地候选(待验证) ──▶ add/message ──▶ search 验证 ──▶ MemOS(正式层)
                       │                                                 ▲
MemOS recall ◀──────────────────────────────────────────────────────────────┘
(每段对话自动召回,只读)
```

**读放开**：memos-cloud 插件的自动召回完全保留，不影响生产力  
**写收紧**：反思闭环是唯一写入入口，三审后才提交 MemOS  
**不假设写入正确**：`add/message` 由服务端抽取，必须用 `search/memory` 验证入库

---

## 功能状态

| 功能 | 状态 | 说明 |
|---|---|---|
| `/reflect` 手动反思 | ✅ 完成 | 拉起 Reviewer 子代理，三审后写入 MemOS |
| 自动反思(任务完成) | ✅ 完成 | `turn/end` 触发，"值得反思"过滤 + 30 分钟冷却 + 熔断 |
| 自动反思(工具失败/用户纠错) | ✅ 完成 | `session/event` 监听 |
| `/memos-stat` 统计 | ✅ 完成 | 本地审计日志聚合 |
| 记忆写入 + search 验证 | ✅ 验证通过 | add/message → 轮询 search，实测 relativity 0.6+ |
| 写入→召回闭环 | ✅ 验证通过 | 写入的记忆次轮即被 memos-cloud 召回引用 |
| `/plan-and-execute` 规划生成 | ✅ 完成 | Planner 子代理生成 3-8 步 JSON 计划 |
| `/plan-and-execute` 子任务自动推进 | ⚠️ 待实现 | DSH 命令返回后 agent 空闲，followup/inject/steer 无法唤醒，需用 goals 服务 |

---

## 安装

### 🔧 一键安装(v5.0,推荐 —— 便于在任何已装 DSH 的电脑上安装)

```bash
# 在插件源码目录下,一条命令完成:构建 → 打包 tgz → dsh plugin add → 注入 profile patch
pnpm siainstall --profile web
# 然后重启 DSH Web(pkill -f "dsh web --no-open"),supervisor 会自动拉起
```

`pnpm siainstall` 是幂等的:重复执行不会重复注入 patch。脚本会打印最后需要配置的
两个环境变量(`MEMOS_API_KEY` / `MEMOS_USER_ID`)。

**在其他电脑安装(只需 3 步):**
1. 把本项目源码目录(或打包好的 `dsh-reflection-memos-0.1.0.tgz`)拷贝到新电脑;
2. 新电脑确保已装 DSH 与 pnpm(插件零额外 npm 依赖,运行时依赖全部走宿主 DSH 的 peerDependencies);
3. 在新电脑执行 `pnpm siainstall --profile web` → 配置上面两个环境变量 → 重启。

> 需要打包产物给别的电脑时:`pnpm build && pnpm pack` → 得到 `.tgz`,在目标机器执行
> [`scripts/install.mjs`](scripts/install.mjs) 的 `--tgz` 模式(见脚本用法)。

### 手动安装(v3.2 保留)

```bash
# 1. 安装到 DSH web profile
dsh plugin --profile web add /path/to/dsh-reflection-memos-0.1.0.tgz

# 2. 添加插件到 profile patch
# ~/.dsh/profiles/web/cordis.patch.yml 末尾加:
# - insert:
#     - id: dsh-reflection-memos
#       name: 'dsh-reflection-memos'

# 3. 重启 DSH Web
pkill -f "dsh web --no-open"
# supervisor 会自动拉起新实例
```

## 配置

在 `~/.dsh/settings.yaml` 中配置：

```yaml
# memos-cloud: 关闭官方写入，只保留召回
memos-cloud:
  recallEnabled: true
  addEnabled: false       # 由反思闭环接管写入
  memoryLimitNumber: 8
  relativity: 0.5
  includeToolMemory: true
  toolMemoryLimitNumber: 3

# 反思闭环插件配置
dsh-reflection-memos:
  memos:
    userId: yk            # 与 memos-cloud 的 userId 一致
  reflection:
    enableImmediateReflection: true
    enableTaskReflection: true
    enablePeriodicReflection: false
  refiner:
    writeVerifiedFacts: true
    writeLessons: true
    minFailuresForLesson: 2
    verifyIngestion: true
  performance:
    asyncReflection: true
    reflectionTimeoutMs: 120000
```

---

## 命令

| 命令 | 说明 |
|---|---|
| `/reflect` | 手动触发反思：分析当前会话轨迹 → Reviewer 子代理审查 → 三审 → 写入 MemOS |
| `/plan-and-execute <任务>` | 生成多步计划并开始执行（子任务自动推进待实现） |
| `/memos-stat` | 查看记忆统计：提交数 / 入库数 / 失败数 / 事实数 / 教训数 |

---

## 技术架构

### 插件结构

```
src/
├── index.ts                # 插件入口：inject + apply + 事件接线 + 熔断
├── config.ts               # 配置 Schema + installSettings + current() 热更新
├── modules/
│   ├── observer.ts          # 观察层：session/event 采集 + "值得反思"过滤 + 冷却
│   ├── executor.ts          # 执行层：agent/pre-step 缓存 + 子任务状态机
│   ├── reflector.ts         # 反思层：Reviewer 子代理(spawn) + 三审
│   ├── refiner.ts           # 修正层：add/message + search 验证 + 教训查重递增
│   └── planner.ts           # 规划层：Planner 子代理生成结构化任务计划
├── memos/client.ts          # MemOS API 封装(add/message + search/memory)
├── commands/index.ts        # /reflect /plan-and-execute /memos-stat
├── prompts/reflection-schema.ts  # 反思输出 JSON Schema(subagents 限制)
├── types/{reflection,memory}.ts  # 类型定义
├── audit/logger.ts          # 审计日志(~/.dsh/reflection/)
└── skill/manager.ts         # Skill 文件写入(~/.dsh/skills/)
```

### DSH API 使用

| API | 用途 |
|---|---|
| `ctx.agents` | Agent 引用缓存(pre-step) |
| `ctx.subagents.start('spawn', ...)` | 拉起 Reviewer/Planner 子代理 |
| `ctx.commands.register` | 注册斜杠命令 |
| `ctx.on('session/event')` | 事件流采集 |
| `ctx.on('agent/pre-step')` | 缓存 agent 引用 + 检查点注入 |
| `ctx.systemPrompt.variable` | 注入记忆使用规则 |
| `ctx.setInterval` | 周期反思 |
| `installSettingsSection` | 配置注册(setSource + current() 热更新) |

### MemOS API

| 端点 | 方法 | 用途 |
|---|---|---|
| `/add/message` | POST | 异步提交记忆(服务端抽取) |
| `/search/memory` | POST | 搜索验证入库(轮询) |

---

## 已知问题

1. **子任务自动推进待实现**：`/plan-and-execute` 计划生成已通，但子任务通过 `steer` 注入后无法唤醒空闲 agent，需改用 DSH goals 服务驱动。
2. **opencode-go/deepseek catalog 冲突**：`deepseek-v4-flash` 同时存在于两个 catalog，显式 agentOptions 会导致 provider 路由歧义，当前用 `agentOptions: {}` 继承 parent 回避。
3. **子代理 maxDepth**：`maxDepth: 32` 足够兜底，reviewer/planner 无工具不会真递归。

---

## 开发日志

### 2026-09-01

- 09:14 `/plan-and-execute` 首次成功生成 4 步计划（inherit agentOptions + opencode-go + deepseek-v4-flash）
- 09:42 自动反思连续成功 4 次，20 条 fact 入库，召回验证通过
- 调试并修复子代理 provider 路由问题（opencode-go/deepseek catalog 冲突 → agentOptions: {} 继承）
- 安装 `@deepseek-ai/dsh-llm-deepseek` 后发现它与 pi-ai deepseek catalog 冲突，已卸载
- 修复子任务注入机制（followup → steer），确认需 goals 服务才能唤醒空闲 agent

### 2026-08-31

- 实现第一期 MVP：/reflect 手动反思 + 三审 + add/message + search 验证
- 实现第二期自动闭环：turn/end 自动反思 + 熔断 + 冷却 + 人格约束
- MemOS 链路验证：add/message 200，search/memory 返回 memory_detail_list + relativity 0.6989
- 修复启动崩溃：memoRules → memo_rules，Config schema 导出，signal 默认值

---

## License

MIT
