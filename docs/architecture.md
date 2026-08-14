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

模型不能凭空写出证据引用。`repo_save_evidence` 只接受本轮 `repo_read_file` / `repo_search` 实际返回过的 (path, 行号范围)，由服务端持有工具返回记录做交集校验。幻觉引用在架构上被拒绝，而不是靠事后评估测量。

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

Monorepo（如 pi-mono）需要先定位 workspace：导入阶段解析根 `package.json` 的 workspaces 字段，功能候选推荐时限定在单个 package 内。

### Learning Orchestrator

负责：

- 状态转换（`phase` 由应用层持有并作为入参传给 Agent，模型不决定阶段）；
- 当前功能和学习目标；
- 最大轮数（默认 5）和 Token 预算（默认值：单 Session 上限 250k input / 40k output tokens，真模型实测后设定，见 issue #23）；
- 调用 Agent；
- 保存每一轮结果。

### Agent Loop

负责：

- 自实现的 tool loop：组装 prompt → 调模型 → 执行工具调用 → 回填结果，直到模型产出结构化决策；
- 注册只读仓库工具；
- 传递结构化上下文（当前 phase、功能目标、历史轮次摘要）；
- 流式输出，让工具调用和推理过程对用户可见（单轮预期 20–60s，等待必须可视化）；
- 记录本轮所有工具返回的 (path, 行号范围)，供证据接地校验；
- 将模型输出解析为 `AgentDecision` 并做 Schema 校验。

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
2. **filters 闸**：对请求路径**和** realpath 真实目标路径都执行同一套 `isReadablePath` 判定（扩展名白名单、路径黑名单、密钥文件名）；**大小上限不在 `isReadablePath` 内**——它依赖 stat / rg 的 `--max-filesize`，必须由每个访问路径显式执行（read-file 用 `isWithinSizeLimit`，search 用 `--max-filesize` 参数）。新增访问路径时这是最容易漏的一项，负向测试必须包含超大文件。

配套要求：

- 过滤判定只能使用 `filters.ts` 导出的统一谓词，禁止各访问路径自行实现子集（search 曾因此漏掉大小与扩展名过滤）；
- 一切进入子进程 argv 的用户输入（ref、pattern、路径）必须经过白名单校验或 `--` 分隔符隔离，禁止以裸值传入；
- 新增访问路径的 PR 必须附带符号链接别名与越界路径的负向测试。

### 同一道闸覆盖所有出口

双闸规则的推论，单独成条是因为已经两次踩中同一模式（search 绕过 filters、submit_decision 绕过证据接地）：**校验的单位是"数据离开信任边界的语义"，不是某一个函数调用点**。凡是同一类数据有多条离开路径，每条路径必须过同一道闸：

- 证据引用有两个出口——`repo_save_evidence` 工具与 `submit_decision.evidence` 字段——两者都必须过 `EvidenceValidator`，且 **grounding validator 在生产组装入口是强制注入项**：`acceptAllEvidence` 仅供单测使用，CLI/API 组装时不注入接地校验即为缺陷；
- 文件内容有四个出口——read-file、search、tree、**package-info**——四者都必须过 fs-guard 与统一的 filters 谓词（package-info 曾以 `readFileSync` 裸读 `package.json`，符号链接可越界，正是本条规则要抓的形态）；
- 新增任何"模型输出进入产品状态"的路径（未来的 recap 生成、UI 展示等）时，先问：这类数据已有的闸在哪，新路径过了吗。

Review checklist：改动引入新的输出/保存路径时，diff 里必须能指出它复用的闸；指不出即打回。

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

