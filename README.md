# RepoCoach

一个 agent 垂直切片，以及一次多模型协作开发的实验记录。

代码本身是一个源码学习 agent：给它一个 GitHub 仓库，它挑一条真实功能的调用链，先让你预测，再用带行号的源码证据纠正你。**但这个仓库的价值不在产品，在于它把 agent 工程里几个反直觉的问题跑到了有数据的程度**——成本到底花在哪、安全闸怎么才不漏、KV cache 客户端能做什么、状态怎么跨进程活下来、prompt 约束为什么必须配出口闸。

以及：**用 Claude Code 定计划与 review、DeepSeek 做实现、GPT 做外部复审**，这套分工实际跑 22 个 PR 之后的经验。

> **项目状态：已停止开发。** 技术切片跑通了（638 个测试、22 个合并 PR），产品假设没验证也不打算验证——理由见文末「产品结论」。下面的每条结论都有实测数据，多数是被真实运行打脸打出来的。

---

## 一、成本

### 纸面推断错了两次，实测才对

| 推断 | 实测 |
|---|---|
| 成本随轮次线性增长，5 问 ≈ 1.65M token | **超线性**：Zod 第 1 问 0.4M、第 2 问累计 1.26M、收尾 1.80M |
| 减少工具往返次数就能降成本 | Hono 调用数降 28%，token **反升 17%** |

第二条尤其值得记：**往返次数不是成本的因**。

### 主成本是同一轮内的对话重发

浅克隆和 ripgrep 检索**不消耗 token**，单条工具结果硬上限 8 KiB。真正的开销是：一个 turn 里模型调 15–25 次工具，**每次调用都要重发整段对话**，包括本轮之前所有工具结果。

Zod 实测（16 次 provider 调用）：总发出 1,168,610 字节，其中 **1,033,741（88.5%）是同轮内累积、被反复重发的工具结果**。成本随调用次数平方增长，与仓库大小只间接相关。

### 最反直觉的一条：预算在管一个错的量

DeepSeek 的自动上下文缓存对**从第 0 个 token 起完全相同的前缀**生效，命中便宜一个数量级。Hono 实测：

```
input tokens      394,501
cache hit tokens  258,944  (65.6%)   ← 便宜十倍
cache miss tokens 135,557  (34.4%)   ← 真正计费的
```

而预算卡的是**总 prompt token**（320k）。**session 是被一个高估约 3 倍的数字提前掐断的。**

同一个数还被同时当成三样东西，三样都没管好：

- **当成钱** —— 高估约 3 倍
- **当成上下文窗口压力** —— 完全不相关，单次调用平均 13,150 token，只用了窗口约 10%
- **当成工作量** —— 它随调用次数平方增长，与产出价值无关

它真正做到的只有"保证 session 会停下来"。**那叫熔断，不叫预算。** 正确做法是拆开：成本上限按 miss token + output token 计，熔断按调用次数或墙钟时间计，上下文压力目前根本不用管。

### 可复用：度量方式

- `src/agent/loop.ts` —— 两个事件夹住一次调用：`provider_request`（请求前字节量、其中工具结果占多少、其中窗口可压缩的占多少）与 `provider_usage`（响应后的缓存命中/未命中拆分）
- `src/eval/bench.ts` + `fixtures/benchmarks/real-repos.json` —— 钉死 commit SHA **和**功能候选的可重复基准，N 次取中位数与 (min–max)

**钉死候选是关键**：不钉的话模型每次自选不同功能、探索不同代码路径，两次运行的 token 总量根本不可比。我们为此白跑过一轮对比。

---

## 二、安全

### 构造性接地：让幻觉引用不可能，而不是事后检测

`repo_save_evidence` 只接受本轮工具**真实返回过**的 (path, 行号范围)，服务端账本做交集校验。范围合法但内容未被读过的引用一律拒绝。

实现：`src/evidence/ledger.ts`（账本）、`src/evidence/grounding.ts`（校验器）、`src/agent/tools.ts`（证据出口）。

配套纪律比机制本身更容易出错：

- 截断只记**实际显示**的行（模型只看到半行就不能引用整行）
- 跨轮携带的内容只认**真正带进上下文**的范围，降级为"只列 path"的不可引用
- 批量提交仍需**逐条**校验，不允许整批放行

### 双闸，以及"同一道闸覆盖所有出口"

每条文件访问路径必须同时过 fs-guard（realpath 收敛在仓库根内，`src/reader/fs-guard.ts`）与 filters（扩展名白名单、路径黑名单、密钥文件名、文件名控制字符，`src/reader/filters.ts`）。四个出口——read-file / search / tree / package-info——无一例外。

历史缺陷全是同一形态：**闸本身正确，但漏了某个出口**。search 绕过 filters、package-info 裸读 `package.json`、字节上限只在 read_file 生效。

### 最重要的实证：这类缺陷靠 checklist 拦不住

17 个 PR 累计 35 轮复审、约 50 条意见，**近四分之一是同一形态**（字节上限那道闸被追了 5 轮）。写了六条自查清单之后仍然反复漏。

原因很具体：**清单能提醒"检查覆盖面"，但替不了"类别边界在哪"这一步判断，而出错的正是后一步。**

有效的是把覆盖面写成测试：

| 方法 | 位置 | 作用 |
|---|---|---|
| 枚举式覆盖 | `test/coverage/` | 出口列表来自导出的常量/类型（`REPO_TOOL_DEFINITIONS`、`featureCandidateSchema.shape`），新增出口自动纳入或自动失败 |
| 属性测试 | `test/property/` | `∀ 输入, byteLength(最终输出) ≤ 上限`，自动发现转义膨胀、边界差一位 |
| 架构适应度 | `test/architecture/fitness.test.ts` | "哪些模块允许 import `node:fs` / `node:child_process` / 构造 data-guard 标记"写成**带书面理由的显式白名单**，遍历 `src/**` 断言无违例 |
| 对抗性 fixture | `fixtures/fixture-adversarial/` | 一份同时攻击每道闸的语料，推过全部八条出口 |

**对抗性 fixture 上线当天就找出一个 35 轮复审都没发现的缺陷**：tree 列表是"每行一个文件"，一个名字里带换行的文件会在模型看到的区块里伪造出多余条目——与伪造标记同一形态。修在路径闸，一处覆盖全部出口。

### 其他闸

- **仓库内容永远是数据**（`src/agent/data-guard.ts`）：包裹在 `REPO_DATA` 标记内，内容里的伪造标记被转义，**永不进 system prompt**
- **终端输出中和**（`src/cli/markdown.ts`）：ESC/CSI/OSC、C0、C1、伪造的 markdown 标题
- **子进程 argv**：固定数组、从不开 shell，用户输入经白名单校验或 `--` 隔离

---

## 三、KV cache

**客户端实现不了 KV cache。** 它是推理时驻留在 GPU 显存里的张量，活在模型服务器内部。作为 API 客户端，唯一的抓手是**把请求前缀构造得稳定**（DeepSeek 自动缓存），或使用 provider 的显式缓存断点接口（Anthropic 的 `cache_control`，DeepSeek 没有）。

### 一条可推广的 agent loop 设计规则

**稳定内容在前，易变内容在后；per-turn 状态绝不能写进 system prompt。**

我们违反了它：`src/agent/system-prompt.ts` 把 `Current phase: ${phase}` 和阶段专属指令写进第 0 条消息，而 phase 每轮都变——**每次阶段转换，整轮缓存从头作废**。

同轮内命中率还有 66%，是因为工具循环只追加、前缀稳定；跨轮几乎全丢，因为每轮重建消息数组。

### 一条反直觉推论

跨轮把历史压成摘要以省 token（本项目 issue #25 做的），**在缓存存在时这笔账可能是反的**：原始历史是稳定前缀（1/10 价），新生成的摘要是全价新 token。

**省 token 的优化，可能是涨成本的优化。** 这个假设我们没来得及验证，但值得任何做 agent loop 的人先想一遍。

### 顺带暴露的设计缺口

`ChatProvider` 接口没有缓存断点的概念（`{messages, tools}` 进、`{message, usage, cache}` 出）。所以"provider 可替换"这个目标在缓存这一维上并不成立——DeepSeek 的自动缓存把它盖住了，换到需要显式标记的 provider 才会暴露。

### 换 key 会怎样

DeepSeek 缓存**按账号隔离**，换成另一个账号的 key 即冷启动；不再使用的缓存"几小时到几天"内清除。所以隔夜再跑同一基准，前几次调用是冷的——**做前后对比时这是个真实的干扰源**。

---

## 四、数据 / 状态

反复出现的同一类缺陷：**只活在内存或局部作用域的状态，resume 时就没了。** 中过四次——commit SHA、workspace 选择、累计 token usage、轮数与预算覆盖。

正确的自查问法**不是**"本次有没有新增状态字段"（我曾因此漏判 workspace——字段早就存在，只是 session 层没保存），而是：

> **首次运行时影响行为的每个变量，resume 时拿得到吗？**

只活在内存里的决策值就是缺陷。

相关：`src/store/json-store.ts`（会话持久化）、`src/domain/index.ts`（schema，新增字段一律 optional 以兼容旧文件）。

另一条：**测试普遍注入依赖，导致"没注入时用什么"的默认装配分支从未被执行**。fixture-monorepo 曾因此拿到 fixture-repo 的候选，而测试全绿。凡新增默认路由，必须有**不注入**该依赖的装配级测试。

---

## 五、Prompt

### prompt 里的约束必须配一道出口闸

"功能候选只能是仓库里已存在的调用链，不能是新增功能或重构建议"——写进 prompt 后模型照样违反。最终稳住靠的是出口的三道校验：祈使动词检测（Add / Implement / Refactor 开头即拒）、符号接地（描述里点名的符号必须能在给定文件中找到）、文件存在性过滤。

**通用规律：prompt 表达意图，出口闸保证性质。** 只写 prompt 等于没约束。

### 状态归应用层，模型碰不到

`AgentDecision` 用 `.strict()` 拒绝任何未知字段，包括 `phase`——模型输出的 `nextAction` 只是**建议**，转不转由 Orchestrator 裁决（`src/orchestrator/orchestrator.ts`）。

### 模型输出必然不合规，要有降级路径

`src/agent/json-repair.ts` 处理宽松 JSON 与双层 `{"arguments": {...}}` 包装；schema 校验失败把纠错信息作为工具结果喂回去重试；重试耗尽后，若 session 已有值得复盘的内容就合成一份最小复盘，而不是把用户的进度扔掉。

---

## 六、协作流程：CC 驱动 DS、GPT review

这块没什么现成资料，实测经验如下。

### 可用配置

```bash
# 在目标 worktree 内
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
ANTHROPIC_AUTH_TOKEN=<key> \
ANTHROPIC_MODEL=deepseek-v4-pro \
claude -p --verbose --output-format stream-json \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(pnpm:*),Bash(git commit:*),..." \
  < prompt.txt
```

- **prompt 必须走 stdin**：headless 后台管道下位置参数不生效
- **工具白名单不给 `git push`**：实现方只能 commit，push / 开 PR 由 review 方在验收后执行
- **每个任务独立 git worktree**，失败可安全重跑
- **不要并发**：两个 headless 进程同时跑曾双双死于 socket 错误
- **成本**：一次实现类委托约 ¥3

### 必须知道的坑：退出码会骗人

进程**退出码 0**、输出里写着 `"subtype": "success"`，同一条记录里却是：

```json
{"is_error": true, "api_error_status": 402, "result": "API Error: 402 Insufficient Balance"}
```

一个工具调用都没跑，worktree 空空如也。**必须查 payload，不能只看退出码。**

### 委托产出的质量形态（最值钱的一条）

DeepSeek 的代码结构基本正确，但反复交付**看起来完成、其实是假的**东西：

- 基准配置里的 commit SHA 是**全零占位符**——通过了 40-hex 正则，却不指向任何 commit
- 入口文件路径 404，而 harness **照样能跑**（首轮摘要为空、模型从零探索），于是"钉死候选"的基准悄悄退化成它本要取代的那种不可重复运行
- 测试**手工复刻**被测渲染逻辑而不调用它——将来有人加第五个字段绕过闸门，测试照样绿
- fixture 里生成了四个攻击面，却没有任何断言读它们，而文件头注释声称"driven through 全部出口"

**"编译过、测试绿"与"基准指向一个不存在的 commit"完全兼容。** 委托产出需要核对**事实**，不只是看测试状态。我用 GitHub API 核路径、核 SHA，才发现这些。

对应的防御：给配置加"全零 SHA 即拒绝"的校验、在花掉第一次模型调用**之前**断言入口文件可读、让测试走真实入口而不是复刻逻辑。

### review 方自己的失误也要记

- **三次写"实测"探针时绕过真实入口**，自己拼输入或复刻输出逻辑，得出错误结论并写进 PR。一次报了"预算正确"，实际超标 3 倍。**自己拼的"实测"比不测更危险**——它让所有人以为这个面已覆盖
- **误诊过一次根因**：assessment 一致率 28.6%，判成"模型评判太严"并提了 rubric 修改，实际是活会话里按回答文本配对导致对照无效。改成隔离 judge 模式后 100%
- **PR 承诺的测量没做就合并了**：写明"合并前补上真实仓库数据"，PR 先行合并、issue 被关

### 三方分工的实际效果

Claude 定计划 / 拆 issue / review / 验收 / push，DeepSeek 实现，GPT 外部复审。**外部复审确实抓到了 Claude 漏掉的东西**（如 resume 时已超预算仍会先调一次模型），说明同一个模型既写又审存在盲区。

---

## 产品结论

**不成立。** 目标用户（准备面试、想给开源提 PR 的开发者）大概率已经装了 Claude Code 这类通用编码 agent。用它开一个 session 配几个 markdown 文件，能覆盖 RepoCoach 的全部功能，而且能读完 200 个文件的仓库——我们还跑不完一个 session（Hono 实测完成 1 问，Zod 0–1 问）。

设想的三条优势逐条检查后都站不住：

| 设想优势 | 实际 |
|---|---|
| 结构性防剧透 | `CLAUDE.md` 写一条规则就够了 |
| 学习记录可累积 | markdown 更好：可 grep、可版本控制、可带走。而且我们只存了数据，没有功能在用 |
| 引用架构上不可伪造 | 用户本来就在读代码，自己能核对 |

还有一个更根本的缺失：**eval 从来没有对照组**。Evidence precision、Path accuracy 这一整套指标全是 RepoCoach 和自己比，而假设里的"**比**代码总结更有效"需要与通用 agent 的对照实验。即使成本问题解决，现有度量也回答不了"值不值得做"。

**过程教训：产品价值的压力测试做得太晚。** 项目从"技术可行性评估"直接进入实现，做完 39 个 issue 才认真问"为什么用户要用它"。可行性评估本应包含这一问。

---

## 值得抄走的三块

1. **构造性接地** —— `src/evidence/`。任何需要"模型引用必须可信"的 agent 都用得上
2. **agent loop 的成本度量** —— `provider_request` / `provider_usage` 两个事件 + `eval:bench` 的钉死基准。上面成本与 cache 的全部结论来自它们
3. **闸门覆盖的测试方法** —— `test/coverage/`、`test/property/`、`test/architecture/fitness.test.ts`、`fixtures/fixture-adversarial/`

---

## 本地运行

```bash
pnpm install
pnpm test        # 638 个测试，全部 mock，不发网络请求
pnpm build
```

跑真实模型需要仓库根目录有 `.env.local`（一行 `Deepseek_key=<key>`）。

```bash
pnpm start -- start ./fixtures/fixture-repo   # 开始一次 Session（也支持 GitHub URL）
pnpm start -- resume <sessionId>              # 中断后恢复
pnpm start -- list                            # 历史 Session
pnpm start -- show <sessionId>                # 查看已保存的问答与证据
```

- 问答中直接回车 = 跳过本题；`/quit` 提前结束
- Session 按轮持久化在 `~/.repocoach`（`--data-dir` 可覆盖），Ctrl-C 不丢进度
- `--max-turns` / `--max-input-tokens` / `--max-output-tokens` 覆盖默认限制

### 评估

```bash
pnpm build
pnpm eval:mock    # 确定性 mock provider（CI 跑这个，无需 API key）
pnpm eval:real    # 真实 provider 跑 fixture
pnpm eval:bench   # 真实仓库成本对比，钉死 SHA + 候选，N 次取中位数
```

`eval:bench` **不进 CI**：每次运行都是真实模型调用、花真钱。用法是"改动前跑一次、改动后跑一次"，再 diff 两份 `bench-report.json`。

---

## 文档

- [架构设计](./docs/architecture.md) —— 轮子长什么样：模块边界、状态机、安全边界的完整表述
- [MVP 规格](./docs/mvp-spec.md) —— 原始产品规格与用户流程

## 开源协议

MIT（许可证文件待补）。
