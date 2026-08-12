# RepoCoach Architecture

## 1. 设计原则

### 源码证据优先

Agent 的回答必须尽量建立在仓库中的真实文件上。模型的常识可以用来解释概念，但不能替代仓库证据。

### 学习状态显式化

学习过程不是一个无限聊天窗口，而是有明确阶段的状态机。每轮对话都应该知道用户处于预测、验证、追问还是复盘阶段。

### 只读和最小权限

目标仓库是外部不可信输入。MVP 只获取源码文本，不执行代码、不安装依赖、不允许 Agent 修改文件。

### Runtime 可替换

Pi SDK 可以作为第一版的 Agent runtime，但仓库分析、证据模型、学习状态机和评估逻辑应该保持独立。

## 2. 逻辑架构

```text
┌──────────────────────┐
│       Web UI         │
│  Import / Session    │
│  Evidence / Recap    │
└──────────┬───────────┘
           │ HTTP / SSE
┌──────────▼───────────┐
│    Application API    │
│  Session orchestration│
│  Validation / limits  │
└──────┬─────────┬──────┘
       │         │
┌──────▼─────┐ ┌─▼────────────────┐
│ Pi Agent   │ │ Repository Reader │
│ Session    │ │ GitHub API        │
│ State loop │ │ Search / Read     │
└──────┬─────┘ └─────────┬─────────┘
       │                 │
       └────────┬────────┘
                ▼
        ┌───────────────┐
        │ PostgreSQL    │
        │ Repo / Session│
        │ Turns / Eval  │
        └───────────────┘
```

## 3. 模块边界

### Web UI

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

### Repository Reader

负责：

- GitHub URL 解析；
- 仓库元数据获取；
- 目录树获取；
- 文件搜索；
- 文件读取和行号切片；
- 文件类型、大小和路径过滤。

### Learning Orchestrator

负责：

- 状态转换；
- 当前功能和学习目标；
- 最大轮数和 Token 预算；
- 调用 Agent；
- 保存每一轮结果。

### Pi Agent Adapter

负责：

- 创建和恢复 Agent Session；
- 注册只读仓库工具；
- 传递结构化上下文；
- 处理流式输出和工具事件；
- 将 Agent 输出转换成产品领域模型。

### Evidence Store

负责：

- 保存文件路径、行号和引用原因；
- 校验引用范围；
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

状态转换应由应用层控制，不能完全交给模型自由决定。

## 5. Agent 输出约束

模型输出必须经过 Schema 校验，至少包含：

- 当前阶段；
- 给用户的问题；
- 需要检索的意图；
- 证据列表；
- 对用户回答的判断；
- 下一步动作。

示例：

```ts
type AgentDecision = {
  phase: "hypothesis" | "trace" | "questioning" | "feedback" | "recap";
  question?: string;
  evidence: Evidence[];
  assessment?: "correct" | "partial" | "incorrect" | "unknown";
  feedback?: string;
  nextAction: "ask" | "show_evidence" | "finish";
};
```

## 6. 安全边界

目标仓库可能包含恶意 Prompt、安装脚本或伪装成说明文档的指令。因此：

- README 和源码只作为数据，不作为 Agent 指令；
- 不执行 `package.json` 中的脚本；
- 不运行 `npm install`、构建或测试；
- 不开放 bash 工具；
- 路径必须限制在仓库虚拟文件系统内；
- 文件内容需要做大小和编码限制；
- 日志中不能保存 Token 或 API Key；
- GitHub Token 只用于服务端 API 请求。

## 7. 评估策略

### Fixture eval

自建一个小型 TypeScript 仓库，预先写好：

- 入口文件；
- 预期调用链；
- 关键证据文件和行号；
- 容易混淆的同名模块；
- 一个有意设计的错误路径。

### 真实仓库 eval

- Zod：小规模、核心概念集中；
- Hono：路由和 middleware 调用链；
- Pi：工具、扩展和 Session 架构。

### 关键指标

- Evidence precision：引用是否真的支持结论；
- Path accuracy：调用链是否走对；
- Question relevance：问题是否与当前功能相关；
- Adaptation：用户答错后是否改变追问；
- Hallucination rate：不存在的文件、函数和行号比例；
- Session completion：用户是否能完成一条链路。

## 8. 实施顺序

1. 初始化 Next.js / TypeScript 工程；
2. 实现 fixture repo 和只读 Repository Reader；
3. 实现仓库导入 API；
4. 实现 Feature Trace 状态机；
5. 接入 Pi AgentSession；
6. 实现证据展示和 Session 持久化；
7. 加入 eval、日志、错误处理和限制；
8. 用 Zod 和 Hono 做真实仓库验证。

