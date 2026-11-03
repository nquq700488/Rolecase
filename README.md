# Rolecast

本地优先的多 Agent 协作工作区。

**把 Provider、Model 和 Role 解耦**：用户可以在同一个 Workspace 中，让能力不同的模型承担 Planner、Executor、Reviewer 等不同角色，并通过 Coordinator 和 Workflow 组织协作。

## 当前状态

**Phase 0 ACP Spike、Phase 1A 单 Agent 服务/Web 垂直切片、Phase 1B Provider/Role 配置与 Phase 1F Run resume/retry + Runtime 重挂接已完成。Phase 2 首个 AgentSlot 切片（RoleBinding Slot、私有 Role snapshot、定向消息与 Slot 生命周期）及持久化 Agent-to-Agent handoff 已交付；handoff Web 主流程已用合成 ACP 验收（重载后需切到接收 Slot 查看，未用真实 Provider）。Coordinator、Task Board、Workflow 和完整多 Agent 编排尚未开始。Codex custom endpoint 认证仍未验证并保持 fail-closed。**

当前决策：

- 第一阶段支持 Claude 和 Codex；
- ACP 优先；
- Node.js + TypeScript + Fastify 后端；
- Vue 3 + Vite + TypeScript + UnoCSS + Naive UI + axios Web UI；
- pnpm workspaces 管理 monorepo（`apps/` + `packages/`）；
- Web-first，Tauri 后续增加；
- Session 和 Run 历史必须持久化；
- 默认继承用户 Provider 环境，按 ProviderConnection 支持隔离；Codex 隔离必须先导入非秘密配置；
- 权限请求 5 分钟软提醒、默认 30 分钟硬超时，过期不自动批准或重跑；
- 模块边界和能力文档是实施前置条件。

## 从这里开始

👉 **[调研与决策.md](调研与决策.md)** —— 架构总览、术语、决策记录和实施阶段。

👉 **[模块边界与升级规则](docs/architecture/模块边界与升级规则.md)** —— 模块职责、依赖方向、Port 和独立升级规则。

👉 **[数据模型与 API](docs/architecture/数据模型与API.md)** —— 领域实体、状态和接口契约。

## 目录

```text
Rolecast/
├── README.md
├── 调研与决策.md
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── tsconfig.web.base.json
├── apps/
│   └── web/                   Vue 3 Web 控制台
├── packages/
│   ├── contract/              Zod Contract Schema
│   └── server/                Fastify、SQLite、Port、权限协调和 ACP Runtime
├── tests/
│   └── contract/              Fake / Claude / Codex Contract Test
└── docs/
    ├── architecture/
    │   ├── 模块边界与升级规则.md
    │   ├── 数据模型与API.md
    │   ├── 技术选型说明.md
    │   ├── 接入层能力矩阵.md
    │   └── 实施计划与测试.md
    └── modules/
        ├── contract.md
        ├── domain.md
        ├── application.md
        ├── config.md
        ├── credentials.md
        ├── providers.md
        ├── acp-runtime.md
        ├── context.md
        ├── orchestration.md
        ├── persistence.md
        ├── events.md
        ├── http-ws.md
        ├── web.md
        ├── platform-host.md
        └── observability.md
```

每个模块必须先有能力文档，再开始实现代码。
