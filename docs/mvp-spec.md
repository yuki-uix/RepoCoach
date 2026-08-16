# RepoCoach MVP Spec

## 1. 目标

RepoCoach MVP 要验证一个核心假设：

> 基于源码证据的主动提问，能比直接生成代码总结更有效地帮助用户理解陌生开源项目。

MVP 不追求理解整个仓库，只需要稳定完成一条功能链路的学习闭环。

## 2. 目标用户

- 准备技术面试、需要讲清项目实现的开发者；
- 想参与开源项目、但还不了解代码结构的开发者；
- 需要快速接手 TypeScript / JavaScript 项目的工程师。

## 3. 用户故事

### 开始学习

作为用户，我可以输入一个公开 GitHub 仓库，并选择一个学习目标。

### 理解功能

作为用户，我可以选择一个功能路径，例如“理解 Hono 的路由匹配”或“理解 Zod 的 parse 流程”。

### 主动回忆

作为用户，我会先回答 Agent 的问题，而不是直接看到完整答案。

### 源码验证

作为用户，我可以看到 Agent 使用的文件路径、行号和相关代码片段。

### 复盘

作为用户，我可以在 Session 结束后看到调用链、理解错误、关键文件和下一步建议。

## 4. 用户流程

```text
orientation
  → 选择仓库和学习目标

hypothesis
  → 用户先预测调用链或模块职责

trace
  → Agent 检索源码，验证预测并展示证据

questioning
  → Agent 根据回答继续追问设计原因和异常场景

feedback
  → Agent 标记正确理解、部分理解和错误理解

recap
  → 生成复盘和下一步学习建议
```

单个 Session 默认最多 5 轮问题，用户可以提前结束。

## 5. MVP 功能

### 5.1 仓库导入

输入：

- GitHub 仓库 URL
- 可选分支或 commit SHA

输出：

- 仓库名称和基本信息
- 目录树
- 入口文件候选
- `package.json` 摘要
- 可学习功能候选

实现方式：

- GitHub API 只用于获取仓库元数据；
- 源码通过 `git clone --depth 1 --filter=blob:none` 浅克隆到隔离临时目录，支持任意分支或 commit SHA；
- 检索和读取全部在本地文件系统进行（ripgrep + 行号切片）；
- 按 (repo, sha) 缓存克隆结果。

约束：

- 只允许公开仓库；
- 限制文件数量和总大小；
- 忽略 `node_modules`、构建产物、二进制和密钥文件；
- 不执行安装脚本或仓库脚本（克隆只获取文件文本，不运行任何仓库代码）；
- Monorepo 需先解析 workspaces（`package.json` 的 `workspaces` 字段或根 `pnpm-workspace.yaml` 的 `packages:` 列表），功能候选限定在单个 package 内。

### 5.2 Feature Trace

Agent 为用户提供 1～3 个功能候选，每个候选包含：

- 功能名称；
- 起点文件；
- 可能涉及的模块；
- 学习目标；
- 预计难度。

候选的**种类**是「仓库里已经存在的一条功能调用链」：学习目标是读懂这条链路如何工作（从哪个入口、经过哪些步骤、到达什么结果），例如「追踪 parse 如何把输入转换为结果并收集 issues」。候选**不得**是新增功能、重构建议、待办任务或 bug 修复等改动提议（如「添加 base32 校验器」）。上限为 3 条，按学习价值排序：核心运行时流程（解析 / 校验 / 路由 / 请求处理）优先于类型工厂、常量表、纯配置。

功能候选由确定性启发式生成：对每个入口文件，先找顶层导出的函数/类；若入口是 barrel（`export * from "./x"`、`export * as ns from "./x"`、`export { a } from "./x"` 等 re-export），则沿 re-export 穿透到真正定义符号的文件（多层 barrel 同样穿透，`.js` 说明符会映射回 `.ts` 源文件），候选的起点文件指向定义文件而非 barrel。穿透受深度上限（最多 3 跳）与扫描文件数上限约束，并对已访问文件去重防环；只有穿透后仍无所获时才退回「仓库漫游」兜底候选。

真实仓库（非 fixture）默认改由模型生成候选：把目录树摘要、package 摘要与 barrel 穿透后的真实定义文件/符号一并交给模型（仓库数据经 `REPO_DATA` 标记包裹，system prompt 固定不变），提示词约束候选只能是「追踪已存在的调用链」，只允许在给定文件列表内组织链路、不得虚构符号或文件。模型输出仍过同一道出口闸——zod 校验、文件存在性过滤、id 与标题去重，再加一道保守的「改动提议」启发式检测（标题/描述以 Add / Implement / Create / Refactor / Fix 等祈使动词开头，或含 "should be added" 之类表述即拒绝，规则刻意保守以避免误伤合法英文描述）与 3 条上限；非法、空或全被拒的输出重试一次后回落上述确定性启发式。fixture 仓库走预置候选白名单，不调用模型；`list`/`show` 等不生成候选的命令也不会要求 API key。同名标题的候选会附带其定义文件路径以消歧，保证列表内不出现两条完全相同的标题。

用户选择后，Agent 必须先提出预测问题，再使用工具检索源码。

### 5.3 源码证据

每个重要结论都应该尽量关联：

```ts
type Evidence = {
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
};
```

如果无法找到足够证据，Agent 必须明确标记不确定，而不是编造文件或行号。

证据采用**构造性接地**：`repo_save_evidence` 只接受本轮 `repo_read_file` / `repo_search` 实际返回过的 (path, 行号范围)。服务端持有工具返回记录做交集校验——范围合法但内容未被读取过的引用一律拒绝，模型无法凭空构造引用。

### 5.4 学习复盘

复盘至少包含：

- 功能调用链；
- 关键模块及职责；
- 用户答对的部分；
- 用户混淆的概念；
- 重要源码证据；
- 面试官可能继续追问的问题；
- 推荐下一步。

复盘同时记录 Session 总耗时和用户自评（能否复述这条链路），作为"15 分钟内理解并复述"这一目标的测量数据。单轮响应涉及多次工具调用（预期 20–60s），必须流式输出让等待可视化。

## 6. 领域模型

```ts
type Repository = {
  id: string;
  url: string;
  owner: string;
  name: string;
  ref: string;
  language: "typescript" | "javascript";
  workspacePath?: string; // monorepo 时指向选定的 package
};

type FeatureCandidate = {
  id: string;
  title: string;
  description: string;
  entryFiles: string[];
  difficulty: "intro" | "intermediate" | "advanced";
};

type LearningSession = {
  id: string;
  repositoryId: string;
  featureId: string;
  phase: "orientation" | "hypothesis" | "trace" | "questioning" | "feedback" | "recap";
  turnCount: number;
  status: "active" | "completed" | "abandoned";
};

type LearningTurn = {
  sessionId: string;
  question: string;
  userAnswer?: string;
  evidence: Evidence[];
  assessment?: "correct" | "partial" | "incorrect" | "unknown";
  feedback?: string;
};
```

## 7. Agent 工具

第一版只开放只读工具：

- `repo_get_tree`
- `repo_search`（本地 ripgrep，返回准确行号和上下文行）
- `repo_read_file`
- `repo_get_package_info`
- `repo_save_evidence`（只接受本轮工具返回过的引用，见 5.3 构造性接地）

明确禁止：

- shell 执行；
- 包安装；
- 文件写入；
- 网络访问非 GitHub 源码接口；
- 读取宿主环境变量中的秘密。

## 8. 验收标准

MVP 只有在以下条件都满足时才算完成（每条标注判定方式）：

- 用户可以从 URL 开始一次完整 Session（fixture + Zod 上端到端跑通）；
- Agent 推荐的功能路径在 fixture repo 上命中预置的候选白名单；
- Agent 会让用户先回答：trace 阶段前必须存在一轮用户回答（状态机保证，自动化断言）；
- 重要结论的证据全部通过构造性接地校验（引用必须来自本轮工具返回记录）；
- 错误理解可以被识别：fixture 的标注回答样本集上，assessment 与标注一致率达到阈值（初始 ≥ 80%）；
- Agent 会根据用户回答改变下一轮问题：同一问题分别灌入答对 / 答错样本，下一轮问题可判定地不同；
- Session 能保存并恢复（中断后从 JSON 恢复继续，自动化测试）；
- 不执行目标仓库代码（Reader 无任何 exec 路径，代码审查确认）；
- fixture repo 有自动化回归测试；
- 证据不足时不会伪造结论：fixture 中有意设计的错误路径上，Agent 输出 unknown 而非编造。

## 9. 非目标

以下功能不进入 MVP：

- 语音和视频面试；
- 自动修改仓库；
- 完整架构图；
- 多 Agent 协作；
- 向量数据库优化；
- 公司题库和简历分析；
- 自动运行测试或构建目标仓库。

