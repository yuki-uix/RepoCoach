# RepoCoach

RepoCoach 是一个面向技术面试和开源贡献的源码学习 Agent。

它不会把整个 GitHub 仓库直接总结成一篇 Wiki，而是带用户沿着一个真实功能的调用链阅读源码：先让用户预测，再检索代码证据，接着追问、纠错，最后生成复盘。

## 项目状态

早期 MVP 设计阶段。

当前仓库包含产品范围、MVP 规格和技术架构文档；应用代码将在文档确认后开始搭建。

## 为什么做 RepoCoach

很多开发者可以读懂单个函数，却很难快速建立一个陌生开源项目的整体心智模型。普通代码问答工具通常直接给答案，用户看似理解了，却没有形成能够在面试或贡献任务中复述、验证和迁移的理解。

RepoCoach 的核心假设是：

> 真正的理解应该来自“预测 → 查看证据 → 解释 → 被追问 → 复述”的过程。

## MVP

第一版只解决一个问题：

> 用户能否在 15 分钟内理解并复述一个开源项目中的真实功能链路？

核心流程：

```text
输入公开 GitHub URL
  → 扫描仓库结构和入口文件
  → 推荐可学习的功能路径
  → 用户选择一个功能
  → Agent 提问并让用户先预测
  → Agent 检索源码证据
  → 基于回答动态追问和纠错
  → 输出调用链、薄弱点和下一步学习建议
```

MVP 范围：

- 公开 GitHub 仓库
- TypeScript / JavaScript 项目
- 单次只学习一个功能路径
- 每次 Session 最多 5 个问题
- 文本交互
- 文件路径和行号引用
- Session 可恢复
- 只读分析，不执行目标仓库代码

暂不包含：

- 语音面试
- 多 Agent
- 完整代码 Wiki
- 任意仓库代码执行
- LeetCode 判题
- 简历和职位描述分析

详细规格见 [MVP Spec](./docs/mvp-spec.md)，技术方案见 [Architecture](./docs/architecture.md)。

## Agent 的核心能力

RepoCoach 需要逐步实现：

- 仓库目录和文件分析
- 只读源码搜索与读取
- 基于证据的回答
- 学习状态机
- 苏格拉底式提问
- 用户理解状态记录
- 结构化输出和 Schema 校验
- Agent traces、评估和回归测试

第一版使用 TypeScript + 自实现的 Agent tool loop，学习状态机、证据引用、Session 数据和评估逻辑全部由产品层实现。Pi SDK 作为后续 Agent runtime 的候选，在垂直切片验证核心假设后再评估接入。

## 测试仓库

开发和评估会分成两类仓库：

1. `fixture-repo`：自建的小型 TypeScript 仓库，用于稳定的自动化测试。
2. 真实开源项目：
   - [Zod](https://github.com/colinhacks/zod)：验证小型源码库的证据引用和调用链追踪。
   - [Hono](https://github.com/honojs/hono)：验证真实 Web 框架中的请求和路由链路。
   - [Pi](https://github.com/badlogic/pi-mono)：后续验证 Agent runtime、工具和 Session 等复杂系统。

## 计划中的技术栈

第一阶段（CLI 垂直切片）：

- TypeScript
- Zod（Schema 校验）
- git 浅克隆 + ripgrep（源码检索，GitHub API 只用于仓库元数据）
- JSON 文件 Session 持久化
- 自实现 Agent tool loop
- 模型：DeepSeek `deepseek-v4-flash`（API Key 放在仓库根目录 `.env.local`，已被 `.gitignore` 覆盖，不得提交）

第二阶段（假设验证通过后）：

- Next.js + Tailwind CSS
- PostgreSQL + Drizzle
- Pi SDK / AgentSession（候选）

具体实现会优先保持模块可替换，避免把 RepoCoach 的学习逻辑绑定在单一模型或 Agent runtime 上。

## 本地开发

应用代码尚未开始搭建。下一步会先完成：

1. 初始化 TypeScript 工程；
2. 建立仓库导入（浅克隆）和只读检索（ripgrep）接口；
3. 用 fixture repo 跑通第一条 CLI 版 Feature Trace 流程。

## 文档

- [MVP 规格](./docs/mvp-spec.md)
- [架构设计](./docs/architecture.md)

## 开源协议

项目计划使用 MIT License，正式发布前会补充许可证文件。

