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

约束：

- 只允许公开仓库；
- 限制文件数量和总大小；
- 忽略 `node_modules`、构建产物、二进制和密钥文件；
- 不执行安装脚本或仓库脚本。

### 5.2 Feature Trace

Agent 为用户提供 1～3 个功能候选，每个候选包含：

- 功能名称；
- 起点文件；
- 可能涉及的模块；
- 学习目标；
- 预计难度。

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

### 5.4 学习复盘

复盘至少包含：

- 功能调用链；
- 关键模块及职责；
- 用户答对的部分；
- 用户混淆的概念；
- 重要源码证据；
- 面试官可能继续追问的问题；
- 推荐下一步。

## 6. 领域模型

```ts
type Repository = {
  id: string;
  url: string;
  owner: string;
  name: string;
  ref: string;
  language: "typescript" | "javascript";
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
- `repo_search`
- `repo_read_file`
- `repo_get_package_info`
- `repo_save_evidence`

明确禁止：

- shell 执行；
- 包安装；
- 文件写入；
- 网络访问非 GitHub 源码接口；
- 读取宿主环境变量中的秘密。

## 8. 验收标准

MVP 只有在以下条件都满足时才算完成：

- 用户可以从 URL 开始一次完整 Session；
- Agent 能推荐至少一个合理的功能路径；
- Agent 会让用户先回答；
- 重要结论包含有效的文件路径和行号；
- 错误理解可以被识别并反馈；
- Agent 会根据用户回答改变下一轮问题；
- Session 能保存并恢复；
- 不执行目标仓库代码；
- fixture repo 有自动化回归测试；
- 证据不足时不会伪造结论。

## 9. 非目标

以下功能不进入 MVP：

- 语音和视频面试；
- 自动修改仓库；
- 完整架构图；
- 多 Agent 协作；
- 向量数据库优化；
- 公司题库和简历分析；
- 自动运行测试或构建目标仓库。

