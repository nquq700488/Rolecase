# 规范索引

> 本文件是规范路径导航的唯一维护点。
> `AGENTS.md` 只保留启动协议和关键入口，不展开完整索引。

## 主流程必读

- `.agents/task-routing.md` — 任务类型到最小必读集
- `.agents/workflow.md` — 工作方式与执行流程
- `.agents/execution-mode-guidelines.md` — 完整模式 / 轻量模式判断
- `.agents/planner.md` — 完整模式方案结构与影响面

## 领域规范

- `.agents/coding-standards/common.md` — 语言无关原则，所有编码任务必读
- `.agents/coding-standards/typescript.md` — TypeScript / JavaScript 项目补读
- `.agents/coding-standards/css.md` — 改 CSS / SCSS / Less 或组件内样式时补读
- `.agents/git-workflow.md` — Git 提交、分支、PR 流程
- `.agents/quality-checklist.md` — 安全、性能、实现质量门禁
- `.agents/testing-guidelines.md` — 测试编写、验证和验收标准
- `.agents/security-baseline.md` — 处理外部数据 / 外部 agent 返回 / 多 Agent 协作时必读

新增领域规范时在本节追加路径，并同步 `task-routing.md`。

## 模式上下文

- `.agents/contexts/development.md` — 编码实现阶段
- `.agents/contexts/review.md` — 代码审查阶段
- `.agents/contexts/research.md` — 技术调研 / 探索阶段
- `.agents/contexts/debug.md` — 调试排错阶段
- `.agents/contexts/loop-automation.md` — Loop 自动化 / 心跳巡检

## 自动化钩子

- `.agents/hooks.md` — hook 事件、脚本与各工具接线
- `.agents/hooks/pre-tool-use.md` — PreToolUse 拦截规则与扩展方式
- `.agents/hooks/session-reentry.md` — compact / resume 后重读规范提醒正文
- `.agents/hooks/memory-write-decision.md` — 记忆写入决策树正文（SessionStart 注入）
- `.agents/hooks/memory-stop-nudge.md` — Stop 催办记忆决策树的正文

## 执行前约束系统

- `constraints.json` — 可机检规则的唯一定义点
- `scripts/pre-edit-guard.sh` — 写前拦截、读记录、记忆脏标记、Stop 催办
- `scripts/memory-reminder-guard.sh` — SessionStart 记忆写入决策树注入
- `scripts/session-reentry-guard.sh` — compact / resume 后重读规范注入
- `scripts/generate-guard-config.sh` — 生成各工具 hook 配置（Claude 合并 hooks，不覆盖 permissions）
- `.gitattributes` — `*.sh` 强制 LF，避免 Windows 检出 CRLF

## 协作规范

多 Agent / CCB 多模型场景补读：

- `.agents/collaboration.md`
- `.agents/orchestrator.md`
- `.agents/agent-registry.md`
- `.ccb/ccb.config`
- `.ccb/ccb-compact.config`
- `.ccb/ccb-multi.config`

## 记忆与治理

- `AI_MEMORY.md` — 项目背景、架构决策与通用经验
- `TASK_MEMORY.md` — 未完成任务的接着干信息
- `.agents/task-memory.md` — `TASK_MEMORY.md` 写法与精简规则
- `.agents/ai-memory.md` — `AI_MEMORY.md` 写法与长期经验沉淀触发规则
- `.agents/context-compression-guidelines.md` — 何时切断上下文、压缩前后做什么
- `.agents/spec-governance.md` — 规范治理规则、职责边界、写作与合并准则
- `.agents/spec-index.md` — 本索引文件
- `.agents/continuous-learning.md` — 观察信号何时升级为 Skill / 规范（须用户确认）

## Skill 与工具适配

- `.agents/skills.md` — Skill 索引和跨工具适配边界
- `.agents/skills/{skill-name}/SKILL.md` — 通用规范 Skill 正文
- `.claude/commands/{skill-name}.md` — Claude Code 斜杠命令薄路由，按需存在
- `CURSOR.md` — Cursor 专用补充（hooks / Skill 发现）
- `.cursor/hooks.json` — Cursor 项目 hook 配置

说明：`.agents/skills/` 是通用规范 Skill，不等于所有工具都会原生自动触发。跨工具触发边界、适配层和真实自动化方式见 `.agents/skills.md`。

## CCB 可选配置

- `.ccb/README.md` — CCB 安装、验证、项目配置与排障
- `.ccb/ccb.config` — profile 路由器
- `.ccb/ccb-compact.config` — compact profile 的 agent / provider 配置
- `.ccb/ccb-multi.config` — multi profile 的 agent / provider 配置
- `.ccb/start.sh` — 启动 CCB 团队
- `.ccb/stop.sh` — 停止 CCB 团队
- `.ccb/restart.sh` — 重启 CCB 团队

## 维护规则

- 新增、拆分或调整规范路径时，只更新本文件中的完整索引
- `AGENTS.md` 只保留 `.agents/spec-index.md` 的入口链接
- 新增规范前按 `.agents/spec-governance.md` 检查职责边界
- 不在多个文件重复展开同一组路径
