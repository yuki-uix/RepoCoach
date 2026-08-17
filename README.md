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
- 每次 Session 最多 3 个问题（可用 `--max-turns` 覆盖）；大仓库可能在 Token 预算耗尽时提前收尾，用 `--max-input-tokens` 抬高上限
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

```bash
pnpm install
pnpm test        # 全部单测（mock，不发网络请求）
pnpm build
```

## 运行 CLI

需要仓库根目录有 `.env.local`（一行 `Deepseek_key=<你的 DeepSeek API Key>`）。真实模型为 `deepseek-v4-flash`。

```bash
# 开始一次学习 Session（GitHub URL 或本地路径；fixture 走本地路径）
pnpm start -- start ./fixtures/fixture-repo

# 中断（Ctrl-C 或 /quit）后恢复
pnpm start -- resume <sessionId>

# 列出历史 Session（id、仓库、阶段、耗时）
pnpm start -- list

# 查看某个 Session 已保存的问答与证据（error / abandoned 结束后也能看）
pnpm start -- show <sessionId>
```

- 问答中直接回车 = 跳过本题；输入 `/quit` 提前结束。
- Session 按轮持久化在 `~/.repocoach`（可用 `--data-dir` 覆盖），Ctrl-C 不丢进度。
- 等待模型时工具调用过程会流式打印在 stderr。

## 评估 (Eval)

`src/eval/` 把此前手动做的事（管道灌答案、跑真模型、人工读日志算指标）自动化成可重复的 harness，并作为后续 #25 成本优化的测量仪器。它复用真实装配路径（含强制接地），产出两种测量：

- **活会话 eval（live session）**：用脚本化回答驱动完整 Session，按 `fixtures/expectations/` 的标注计算 Evidence precision、Path accuracy、Adaptation、Hallucination、单 Session 成本五项。
- **judge 模式（judge eval）**：单独测量**评判函数**的 Assessment 一致率。活会话里模型会自己生成问题，无法按回答文本与标注配对（同一脚本回答会被喂给多个不同的模型问题，对照无效）。judge 模式把每条标注样本的 (question, userAnswer) 原样交给评判函数——复用真实的 system prompt 与 rubric、允许只读工具检索证据——只输出 assessment，再与标注逐条比对。

指标口径：

- **Evidence precision**：按「至少一个被引用的符号落在引用范围内」判定支持；reason 未声称任何符号的条目计为「不适用」（不计入分母），并在报告中单独列出供人工核查。
- **Path accuracy**：期望调用链作为**子序列**匹配实际证据路径顺序（允许混入 README、类型定义等非链路文件）。
- **Assessment 一致率（judge 模式）**：除一致率外还输出**混淆矩阵**（标注 × 模型判定）与分歧明细（明细同时显示标注问题与模型看到的问题，二者在 judge 模式下相同，防止再次出现按回答文本错配却不自知）。注意 `fixtures/expectations/answer-samples.json` 的标注是预置的；若出现持续性系统偏差，应先复核标注本身，而非直接判定模型不合格。
- **Hallucination**：符号抽取只保留具备代码上下文的标识符（反引号包裹、camelCase/PascalCase、`name(` 调用、`path.ts` 文件名），散文中的全大写强调词（如 PARSE / VALIDATE）不再被当作符号。

```bash
pnpm build          # eval 脚本运行的是构建产物 dist/eval/bin.js，需先 build

# 确定性 mock provider 跑 fixture，验证 harness 与指标计算本身（CI 跑这个，无需 API key）
pnpm eval:mock

# 真实 DeepSeek provider 跑 fixture，产出真实指标报告（需要 .env.local，不在 CI 跑）
pnpm eval:real
```

两种模式每次都同时跑「活会话 eval」与「judge eval」，只有 provider 不同。输出两份：stdout 的人类可读表格（分两节），以及仓库根目录 `eval-report.json`（机器可读，含完整 run——每轮的问题/回答/assessment/evidence/usage——供事后诊断与优化前后对比；已加入 `.gitignore`）。可用 `node dist/eval/bin.js mock --out <path>` 覆盖 JSON 输出位置。

## 文档

- [MVP 规格](./docs/mvp-spec.md)
- [架构设计](./docs/architecture.md)

## 开源协议

项目计划使用 MIT License，正式发布前会补充许可证文件。

