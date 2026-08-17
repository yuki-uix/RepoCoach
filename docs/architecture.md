# RepoCoach Architecture

## 1. 设计原则

### 源码证据优先

Agent 的回答必须尽量建立在仓库中的真实文件上。模型的常识可以用来解释概念，但不能替代仓库证据。

### 学习状态显式化

学习过程不是一个无限聊天窗口，而是有明确阶段的状态机。每轮对话都应该知道用户处于预测、验证、追问还是复盘阶段。

### 只读和最小权限

目标仓库是外部不可信输入。MVP 只获取源码文本，不执行代码、不安装依赖、不允许 Agent 修改文件。

### Runtime 可替换

仓库分析、证据模型、学习状态机和评估逻辑保持独立，不绑定任何 Agent runtime。第一版直接用一个自实现的 tool loop（约 200 行）驱动模型；Pi SDK 作为后续候选，在垂直切片验证核心假设之后再评估是否接入。

### 证据构造性接地

模型不能凭空写出证据引用。`repo_save_evidence` 只接受本轮 `repo_read_file` / `repo_search` 实际返回过的 (path, 行号范围)，由服务端持有工具返回记录做交集校验。幻觉引用在架构上被拒绝，而不是靠事后评估测量。批量不等于放行（issue #29）：`repo_save_evidence` 接受 `items` 数组一次提交本轮全部证据，但每条仍逐条过同一校验——合格的保存、不合格的在返回值中逐条注明原因，绝不整批放行或整批丢弃。

同一原则也约束功能候选（issue #30）：候选生成出口对照模型输入时 barrel 穿透得到的同一份真实符号与文件集合，校验候选的 `entryFiles` 落在入口候选 / 定义文件内、描述中点名的符号能在这些文件中找到，找不到即丢弃该候选（全部丢弃则回落启发式）。符号抽取沿用既有「代码上下文特征」规则（全大写散文词、语言名、产品名不是符号），避免误伤。

跨轮读缓存（issue #25）扩展了这一语义：Agent Loop 会把上一轮已读的文件范围按字节预算择要携带进下一轮上下文，接地闸同步接受"本轮上下文实际携带"的范围——只认真正带进上下文的那些，被降级为"只列 path 不带内容"的范围不可引用（与截断只记实际显示行是同一纪律）。

同轮滑动窗口压缩（issue #36）是这条纪律的又一种形态：默认 320k 预算下 Zod 实测 16 次 provider 调用共发出 1,168,610 字节，其中 1,033,741（88.5%）是同一轮内累积、被反复重发的工具结果；按每轮增量模拟，只保留最近 4 轮（`MAX_LIVE_TOOL_ROUNDS = 4`）可把发出量压到基线的 49%。Agent Loop 在组装发给 provider 的 messages 时，把超出最近 4 轮窗口的仓库读取类工具结果替换为占位行（保留工具名与 path/行号范围、注明需重新读取），并在同一时刻把该轮记录的范围从 `ToolReturnLedger` 撤销——**范围被移出窗口时，同步移出可引用集合**。压缩只针对仓库读取类数据（repo_read_file / repo_search / repo_get_tree / repo_get_package_info），不碰 repo_save_evidence 的校验回执，更不碰 rejectDecision 推入的纠错指令（判据是"仓库数据结果"，不是 `role === tool`）。

首轮入口摘要（issue #29）是又一条"结构信息进上下文"的路径，纪律是相反的：它只给顶层导出符号名与行号、不含实现内容，经 data-guard 包裹并受独立字节上限约束，且**不记入 ledger**——模型看到符号名不等于看到实现，引用前仍需先 `repo_read_file` 那个范围。

## 2. 逻辑架构

```text
┌──────────────────────┐
│  CLI（第一版入口）    │
│  Import / Session    │
│  Evidence / Recap    │
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ Learning Orchestrator │
│  状态机 / 轮数限制    │
│  Schema 校验 / 预算   │
└──────┬─────────┬──────┘
       │         │
┌──────▼─────┐ ┌─▼────────────────┐
│ Agent Loop │ │ Repository Reader │
│ 自实现     │ │ git clone (浅)    │
│ tool loop  │ │ ripgrep 本地检索  │
└──────┬─────┘ └─────────┬─────────┘
       │                 │
       └────────┬────────┘
                ▼
        ┌───────────────┐
        │ Session Store │
        │ JSON 文件     │
        │ Turns / Eval  │
        └───────────────┘
```

第一版是一个 CLI 垂直切片，用于验证核心假设。Web UI（Next.js + SSE）、PostgreSQL + Drizzle、Pi SDK 均为验证通过后的第二阶段，接口按可替换设计（Session Store 抽象为接口，JSON 实现和未来的 Drizzle 实现互换）。

## 3. 模块边界

### CLI / Web UI

负责：

- GitHub URL 输入；
- 功能候选选择；
- 问题和回答展示；
- 证据文件和行号展示；
- Session 复盘。

不负责：

- 直接调用模型；
- 解析仓库；
- 判断用户回答是否正确。

第一版为 CLI；Web UI 属于第二阶段，接口不变。

### Repository Reader

负责：

- GitHub URL 解析；
- 仓库元数据获取（GitHub API 仅用于此处）；
- 浅克隆：`git clone --depth 1 --filter=blob:none`，支持指定分支或 commit SHA，克隆到隔离临时目录；
- 按 (repo, sha) 缓存已克隆的仓库，同一仓库的多个 Session 不重复克隆；
- 目录树获取（本地文件系统遍历）；
- 文件搜索（ripgrep，返回准确行号和上下文行）；
- 文件读取和行号切片；
- 文件类型、大小和路径过滤。

不使用 GitHub Code Search API 做源码检索：它只索引默认分支、无法配合任意 commit SHA、不返回行号、速率限制（10 req/min）撑不起单 Session 的多轮工具调用。克隆只获取文件文本，不执行任何仓库代码，不违反只读边界。

Monorepo（如 pi-mono）需要先定位 workspace：导入阶段解析根 `package.json` 的 workspaces 字段与根 `pnpm-workspace.yaml` 的 `packages:` 列表（pnpm monorepo 在此声明成员，如 Zod），功能候选推荐时限定在单个 package 内。`pnpm-workspace.yaml` 用 `yaml` 包（零依赖）解析且只取 `packages` 字段；解析失败、字段缺失或类型不符时安全降级为空列表并记录一条可见告警（不静默）。

### Learning Orchestrator

负责：

- 状态转换（`phase` 由应用层持有并作为入参传给 Agent，模型不决定阶段）；
- 当前功能和学习目标；
- 最大轮数（默认 3，可用 `--max-turns` 覆盖）和 Token 预算（默认单 Session 上限 320k input / 70k output tokens，可用 `--max-input-tokens` / `--max-output-tokens` 覆盖）。依据两轮真模型实测：121,972 input / 20,997 output 与 199,241 input / 43,817 output（两轮都在 4 问时撞上当时的输出上限、被迫提前收敛），跑满 5 问实测 235,399 input / 53,720 output（见 issue #23）；真实仓库上 5 问从未达成——实测只能完成 1 问就撞上预算，故默认降为 3（见 issue #33）。

  注意轮数与预算是两道独立的闸，真实大仓库通常撞的是后者。把上限抬到 2M 后在 Zod 实测：第 1 问约 0.4M input，到第 2 问累计 1,257,408，收尾复盘时 1,795,158——**单问成本随轮次超线性增长**，因为每次调用都要重发整段对话，包括同一轮内累积的工具结果。按此估算 3 问约需 3M input，是当前默认值的约十倍。因此默认预算保持 320k，定位是**成本上限而非目标**：大仓库会在预算处提前收尾并给出复盘；愿意付全额的用户用 `--max-input-tokens` 抬高。降低单问成本的方向仍在 issue #33 跟踪；
- 调用 Agent；
- 保存每一轮结果。

### Agent Loop

负责：

- 自实现的 tool loop：组装 prompt → 调模型 → 执行工具调用 → 回填结果，直到模型产出结构化决策；
- 注册只读仓库工具；
- 传递结构化上下文（当前 phase、功能目标、历史轮次摘要）；
- 流式输出，让工具调用和推理过程对用户可见（单轮预期 20–60s，等待必须可视化）；
- 记录本轮所有工具返回的 (path, 行号范围)，供证据接地校验；
- 将模型输出解析为 `AgentDecision` 并做 Schema 校验；
- 跨轮读缓存（issue #25）：`SessionReadCache` 记录本 Session 内经 `repo_read_file` 返回的 (path, 行号范围, 内容)，跨轮存活（与账本的 `resetTurn` 无关）。第 2 轮起组装消息时，把缓存内容按 `MAX_CARRIED_CONTEXT_BYTES`（默认 24 KiB）择要携带进上下文，优先保留最近使用与被引用过的范围，其余只列 path 与行号范围并注明"如需内容请重读"。该区块经 data-guard 包裹（仓库数据永不进 system prompt）。缓存不持久化——resume 后第一轮没有已读上下文，模型会重读，此为接受的取舍。
- 同轮滑动窗口压缩（issue #36）：工具结果超出最近 `MAX_LIVE_TOOL_ROUNDS`（默认 4）个 provider 调用轮后，其内容被替换为占位行（保留工具名与 path/行号范围、注明需重新读取），该轮记录的接地范围同步撤销——**压缩即失去可引用性**，与 #25 跨轮缓存降级是同一条纪律。窗口单位是 provider 调用轮而非消息条数，一轮多工具调用整体保留或整体压缩；当前轮永不压缩；压缩只针对仓库读取类数据结果，不碰 repo_save_evidence 回执与 rejectDecision 纠错指令。
- 首轮入口摘要（issue #29）：候选的 `entryFiles` 经 barrel 穿透解析出真实定义符号（复用 PR #30 的 `resolveSymbols`），把顶层导出符号名 + 行号组成结构摘要，仅首轮注入上下文。受 `MAX_ENTRY_OUTLINE_BYTES`（默认 8 KiB）独立上限约束、经 data-guard 包裹；摘要只含符号名与行号、不记入 ledger。
- 批量证据（issue #29）：`repo_save_evidence` 接受 `items` 数组，一次提交本轮全部证据，把 Hono 上 16 次独立调用合并为约 1 次往返；数组里的每条仍逐条过 `EvidenceValidator`，合格的保存、不合格的在返回值中逐条列出原因。

第一版模型使用 DeepSeek `deepseek-v4-flash`。API Key 从仓库根目录的 `.env.local` 读取（已被 `.env.*` 忽略规则覆盖），只在服务端使用，不进日志。模型调用封装在独立 provider 接口后，保持可替换。

### Evidence Store

负责：

- 保存文件路径、行号和引用原因；
- 构造性接地校验：引用必须出现在本轮工具返回记录中，范围合法但内容未被读取过的引用一律拒绝；
- 让复盘页面可以回到原始源码上下文。

## 4. 学习状态机

```text
orientation
  ├─ 无法识别仓库 → error
  └─ 找到候选功能 → hypothesis

hypothesis
  ├─ 用户回答 → trace
  └─ 用户跳过 → trace（标记 skipped）

trace
  ├─ 有充分证据 → questioning
  └─ 证据不足 → ask_clarification / unknown

questioning
  ├─ 未达到轮数上限 → feedback
  └─ 达到轮数上限 → recap

feedback
  ├─ 需要继续深挖 → questioning
  └─ 当前链路完成 → recap
```

状态转换由应用层控制。`phase` 是 Orchestrator 持有的状态，作为输入传给模型；模型输出的 `nextAction` 只是**建议**，是否转换阶段由 Orchestrator 按状态机规则决定。

## 5. Agent 输出约束

模型输出必须经过 Schema 校验，至少包含：

- 给用户的问题；
- 证据列表；
- 对用户回答的判断；
- 下一步动作建议。

示例：

```ts
type AgentDecision = {
  question?: string;
  evidence: Evidence[];
  assessment?: "correct" | "partial" | "incorrect" | "unknown";
  feedback?: string;
  nextAction: "ask" | "show_evidence" | "finish"; // 建议，由 Orchestrator 裁决
};
```

`phase` 不在模型输出中——它是 Orchestrator 传入的上下文，模型无权修改。

## 6. 安全边界

目标仓库可能包含恶意 Prompt、安装脚本或伪装成说明文档的指令。因此：

- README 和源码只作为数据，不作为 Agent 指令：文件内容注入 prompt 时必须包裹在明确的数据分隔标记内，并且永远不进入 system prompt；
- 不执行 `package.json` 中的脚本；
- 不运行 `npm install`、构建或测试；
- 不开放 bash 工具；
- 路径必须限制在仓库虚拟文件系统内；
- 文件内容需要做大小和编码限制；
- 日志中不能保存 Token 或 API Key；
- GitHub Token 只用于服务端 API 请求。

### 文件访问双闸规则

PR #14 的三个安全漏洞（ref 参数注入、search 绕过文件过滤、符号链接绕过密钥过滤）有共同模式：**单个模块各自正确，组合出漏洞**。fs-guard 允许仓库内符号链接没有错，read-file 按请求路径过滤也没有错，两者组合就泄漏了 `.env`。

因此规定：**Reader 中任何新的文件访问路径（读取、搜索、遍历、未来的任何形态）必须同时通过两道闸，缺一不可**：

1. **fs-guard 闸**：路径解析（含 realpath）后必须落在仓库根内；
2. **filters 闸**：对请求路径**和** realpath 真实目标路径都执行同一套 `isReadablePath` 判定（扩展名白名单、路径黑名单、密钥文件名、**文件名中的控制字符**）；文件名本身是仓库可控文本、且不经转义就进入 REPO_DATA 区块，名字里的换行会在"每行一个文件"的 tree 列表和 search 结果里伪造出多余条目——与伪造标记同一形态，因此在路径闸统一拒掉，一次覆盖全部四个出口（由 issue #31 的对抗性 fixture 发现）；**大小上限不在 `isReadablePath` 内**——它依赖 stat / rg 的 `--max-filesize`，必须由每个访问路径显式执行（read-file 用 `isWithinSizeLimit`，search 用 `--max-filesize` 参数）。新增访问路径时这是最容易漏的一项，负向测试必须包含超大文件。

配套要求：

- 过滤判定只能使用 `filters.ts` 导出的统一谓词，禁止各访问路径自行实现子集（search 曾因此漏掉大小与扩展名过滤）；
- 一切进入子进程 argv 的用户输入（ref、pattern、路径）必须经过白名单校验或 `--` 分隔符隔离，禁止以裸值传入；
- 新增访问路径的 PR 必须附带符号链接别名与越界路径的负向测试。

### 同一道闸覆盖所有出口

双闸规则的推论，单独成条是因为已经两次踩中同一模式（search 绕过 filters、submit_decision 绕过证据接地）：**校验的单位是"数据离开信任边界的语义"，不是某一个函数调用点**。凡是同一类数据有多条离开路径，每条路径必须过同一道闸：

- 证据引用有两个出口——`repo_save_evidence` 工具与 `submit_decision.evidence` 字段——两者都必须过 `EvidenceValidator`，且 **grounding validator 在生产组装入口是强制注入项**：`acceptAllEvidence` 仅供单测使用，CLI/API 组装时不注入接地校验即为缺陷；
- 文件内容有四个出口——read-file、search、tree、**package-info**——四者都必须过 fs-guard 与统一的 filters 谓词（package-info 曾以 `readFileSync` 裸读 `package.json`，符号链接可越界，正是本条规则要抓的形态）；
- 跨轮读缓存（issue #25）新增一个"文件内容重新进入上下文"的出口：`SessionReadCache` 的内容在下一轮被携带进 prompt 时，必须经 `wrapUntrustedContext` 包裹（仓库数据永不进 system prompt），且接地闸只认**本轮真正携带了内容**的范围——范围在缓存里但本轮被降级为"只列 path 不带内容"的，一律不可引用。
- 同轮滑动窗口压缩（issue #36）新增一条"文件内容重新离开上下文"的路径：工具结果被窗口压成占位行时，其范围必须同步从 `ToolReturnLedger` 撤销（`revokeRound`），否则模型仍能引用已经看不到的内容——这正是要防的幻觉形态。撤销精确到"这一轮记录的那些范围"，不能把同一 path 的其他轮范围一起撤掉，与 #25 跨轮缓存降级是同一条纪律。
- 首轮入口摘要（issue #29）新增一条"结构信息进上下文"的路径：同样必须经 data-guard 包裹、受独立字节上限约束，且因为只含符号名与行号、不记入 ledger——这条路径可以引用"符号在哪"却不能引用实现。
- 同轮工具结果的窗口压缩（issue #36）是"内容离开上下文"的第三条路径：超出最近 `MAX_LIVE_TOOL_ROUNDS`（4）轮的仓库工具结果被替换为占位行，**其范围同时移出可引用集合**——与 #25 跨轮缓存降级是同一条纪律（看不到内容就不能引用）。唯一例外是**本轮已经过校验并保存的范围**：它在模型还能看见内容时就被检查过，`submit_decision` 里重复引用是对既有结论的复述而非新主张；若一并撤销，循环会拒掉模型自己已被接受的证据，把一次成本优化变成一次失败的轮次。该例外单独成列（不并入 carried），因为 carried 还驱动"内容已在上下文、不必重发"的判断，压缩后那句话不再成立。
- 批量证据（issue #29）是接地入口的批量形态：数组里的每条仍逐条过 `EvidenceValidator`，不允许整批放行或整批丢弃——批量只减少往返，不放松接地。
- 新增任何"模型输出进入产品状态"的路径（未来的 recap 生成、UI 展示等）时，先问：这类数据已有的闸在哪，新路径过了吗。

Review checklist：改动引入新的输出/保存路径时，diff 里必须能指出它复用的闸；指不出即打回。

### 用测试代替人眼判断覆盖面（issue #31）

上面两条规则靠复审执行时反复失效——清单能提醒"检查覆盖面"，但替不了"类别边界在哪"这一步判断，而出错的正是后一步。因此覆盖面本身写成测试：

1. **枚举式覆盖测试**（`test/coverage/`）：出口列表来自导出的常量或类型（`REPO_TOOL_DEFINITIONS`、`featureCandidateSchema.shape`、`INJECTED_MESSAGE_KINDS`），新增出口自动纳入或自动失败。
2. **属性测试**（`test/property/`）：对预算函数与解析器随机输入，断言 `∀ 输入, byteLength(最终输出) ≤ 上限` 一类不变式。
3. **架构适应度测试**（`test/architecture/fitness.test.ts`）：把"哪些模块允许做危险的事"写成**带书面理由的显式白名单**，遍历 `src/**` 断言无白名单外的 `node:fs` / `node:child_process` 导入与 data-guard 标记构造。新增绕闸的文件会直接让测试失败，逼出一次有意识的决定。白名单条目缺理由本身即失败。
4. **对抗性 fixture**（`fixtures/fixture-adversarial/`）：一份同时攻击每道闸的仓库（伪造标记、ANSI/C1、超长行、畸形 UTF-8、二进制伪装、越界说明符、逃逸符号链接、恶意 workspace glob、文件名控制字符、超限体积），由 `test/coverage/adversarial-fixture.test.ts` 推过全部出口。增量价值在于**同一份恶意输入过所有出口**：只覆盖 read-file 而漏掉 search 的闸会在这里失败。

非目标：不追求零复审轮次。语义判断（如"候选生成的是新增功能而非现存链路"）任何自动化都发现不了，那种复审有价值。这四项压掉的是机械可判定的部分。

### Fixture eval

自建一个小型 TypeScript 仓库，预先写好：

- 入口文件；
- 预期调用链；
- 关键证据文件和行号；
- 容易混淆的同名模块；
- 一个有意设计的错误路径；
- 一组标注过的用户回答样本（正确 / 部分正确 / 错误），用于自动化测试 assessment 和追问适应性。

### 真实仓库 eval

- Zod：小规模、核心概念集中；
- Hono：路由和 middleware 调用链；
- Pi：工具、扩展和 Session 架构。

### 关键指标

- Evidence precision：引用是否真的支持结论；
- Path accuracy：调用链是否走对；
- Question relevance：问题是否与当前功能相关；
- Adaptation：fixture 上同一问题分别灌入答对 / 答错样本，下一轮问题必须可判定地不同（不能是同一问题换措辞）；
- Hallucination rate：由构造性接地保证引用层为零，eval 转为测量结论文本中提及的不存在函数 / 模块名；
- Session completion：用户是否能完成一条链路；
- 单 Session 成本与耗时：token 用量和 wall-clock 时间，守住 15 分钟目标。

`src/eval/`（`pnpm eval:mock` / `pnpm eval:real`）把指标自动化，并明确分成两种测量：**活会话 eval**（Evidence precision、Path accuracy、Adaptation、Hallucination rate、单 Session 成本与耗时）与 **judge 模式**（Assessment 一致率）。活会话里模型会自己生成问题，无法按回答文本与标注配对——一致率是**评判函数**的属性，必须在 judge 模式下隔离测量：把每条标注样本的 (question, userAnswer) 原样交给评判函数（复用真实 system prompt 与 rubric、允许只读工具检索证据），只输出 assessment 再与标注比对。mock 模式用确定性脚本化 provider 走真实装配路径（含强制接地），CI 无 API key 也可运行；real 模式用 DeepSeek provider 产出真实数值。Question relevance 与 Session completion 尚未独立成指标——Session completion 由报告中的 `endedPhase` / `degraded` 字段部分覆盖。

## 8. 实施顺序

第一阶段（CLI 垂直切片，验证核心假设）：

1. 初始化 TypeScript 工程（无 Next.js）；
2. 实现 fixture repo 和只读 Repository Reader（浅克隆 + ripgrep）；
3. 实现 Feature Trace 状态机和自实现 Agent loop；
4. 实现证据接地校验和 JSON Session 持久化；
5. 加入 fixture eval、日志、错误处理和限制；
6. 用 Zod 和 Hono 做真实仓库验证，确认"提问优于总结"的假设成立。

第二阶段（假设验证通过后）：

7. Next.js Web UI + SSE 流式展示；
8. PostgreSQL + Drizzle 替换 JSON Session Store；
9. 评估是否接入 Pi SDK 替换自实现 loop。

