# AI_MEMORY.md — 项目共享认知入口

> 目标：让任意 AI 在读完本文件后，快速建立本项目的工作心智模型。
> 内容包含：项目概览、架构地图、关键业务链路、高风险区域、长期有效规则。
> 不包含：任务级流水、临时调试过程（这些写入 `TASK_MEMORY.md`）。

## 项目概览

- 业务：本地优先的多 Agent 协作工作区；把 Provider、Model 与 Role 解耦，让用户按 Workspace 配置模型和角色并编排协作
- 技术栈：Node.js + TypeScript + Fastify（后端）、Vue 3 + Vite + TypeScript + UnoCSS + Naive UI + axios（前端）、ACP 协议接入 Claude / Codex Adapter、SQLite 运行状态 + JSON 配置 + 系统 Keychain、桌面壳后续用 Tauri 2
- 代码主入口：`packages/contract`、`packages/server`、`tests/contract` 与 `apps/web`；产品设计见 `docs/`

## 工程基线

- Node：v22.21.1；根 `package.json` 要求 `>=22`
- 包管理：pnpm workspaces，锁定 `pnpm@10.20.0`；Adapter 锁定 `claude-agent-acp@0.90.0` / `codex-acp@2.2.2`
- 当前验证命令：`pnpm -r typecheck`、`pnpm test`；真实 ACP 集成使用 `RUN_ACP_INTEGRATION=1 pnpm --filter @rolecast/acp-contract exec vitest run`
- 真实集成测试默认跳过，缺少任一 Provider 的实测证据不能宣称 Phase 0 通过
- 已接入 Fastify / Vue / SQLite；按各 workspace 脚本运行 typecheck、test、build，浏览器自动化仍按需执行
- 文档阶段仍使用 Markdown 结构检查（内部链接、重复标题、连续空行、单文件 800 行上限）

### Phase 0 代码入口

- `packages/contract/src/index.ts` — Zod DTO、事件和命令 Schema
- `packages/server/src/application/ports/` — Runtime / Capability / Clock Port
- `packages/server/src/application/permission/permission-state-coordinator.ts` — 权限超时状态协调
- `packages/server/src/infrastructure/acp/` — JSON-RPC、进程生命周期、ACP Runtime、环境翻译
- `tests/contract/src/` — Fake 与真实 Claude/Codex Contract Test

### Phase 0 实测事实

- Claude isolated 使用 `CLAUDE_CONFIG_DIR` 可以完成握手、Session 和执行，用户全局目录未写入
- Codex isolated 使用空 `CODEX_HOME` 时 `session/new` 可能返回 `Authentication required`；必须显示 `needs_configuration`，不得回退 inherited
- ACP `session/cancel` 是 notification，不是等待 RPC response 的 request
- **[约束]** `session/cancel` 调用成功只代表通知已发出，不代表 turn 已停止；必须等待活动 turn 结束或 `turn_cancelled` 证据，否则 Run 只能收敛为 `interrupted`。
- **[约束]** 幂等命令回执必须先在状态/Runtime 检查之前重放；`failed/not_dispatched` 复用既有 Run/Task/Message 或子 attempt 重新 dispatch，不能重新创建实体。
- **[约束]** 回执 `completed/accepted` 只能在证明 `session/prompt` 已写出（Runtime dispatch 信号或已收到事件）后写入；dispatch 前失败必须回 `failed/not_started`，崩溃窗口内保持 `running/started` 并交给启动恢复判 `ambiguous`。
- **[约束]** cancel 超时（`interrupted`）不代表旧 turn 已停止：旧 turn 活动期间必须保留 Slot claim，禁止同 Run resume/同 session 新 dispatch；旧 turn 结束后才释放 claim，释放后 resume/re-dispatch 仍须确认 claim 归本 Run，且不得改判 `cancelled`。
- ACP `session/resume` 使用 `{ sessionId, cwd, mcpServers }`，两个锁定 Adapter 均已验证
- `pnpm install --frozen-lockfile --prefer-offline` 可复现；pnpm 仍提示 esbuild build script 被忽略，但当前类型检查和测试通过

## 架构地图（先看这一节再改代码）

> 以下以模块契约作为职责地图；具体实现入口以各模块文档和当前代码为准。

### 入口 / 表现层

- `docs/modules/web.md` — Vue 3 + Vite + UnoCSS + Naive UI Web UI，经 HTTP/WS 访问本地服务
- `docs/modules/http-ws.md` — 本地 REST 与 WebSocket 控制面，校验 Local Token / Origin / Host
- `docs/modules/platform-host.md` — 浏览器与 Tauri 的平台能力隔离层

### 状态 / 数据层

- `docs/modules/persistence.md` — SQLite 保存运行状态，JSON 保存用户配置，文件保存大型 Artifact
- `docs/modules/config.md` — 内置 < 用户 < Workspace < Session Override 分层配置，并报告字段来源
- `docs/modules/credentials.md` — 只保存 `credential_ref`，真实密钥进系统 Keychain

### 核心领域层

- `docs/modules/domain.md` — Workspace / ProviderConnection / ModelCatalogEntry / Role / RoleBinding / Session / AgentSlot / WorkflowTemplate / Task / Message / Artifact / Run
- `docs/modules/application.md` — 用例编排与事务边界
- `docs/modules/orchestration.md` — Coordinator、Task 调度、状态推进
- `docs/modules/context.md` — 按最小必要原则构建 Agent 上下文

### 基础设施层

- `docs/modules/providers.md` — Provider 连接与 Model Catalog、能力快照
- `docs/modules/acp-runtime.md` — Claude / Codex ACP Adapter 进程生命周期与协议转换
- `docs/modules/events.md` — EventBus（实时）与 EventStore（持久化 / replay）
- `docs/modules/contract.md` — 前后端与事件流的稳定数据契约
- `docs/modules/observability.md` — 结构化日志、诊断与脱敏

## 关键业务链路（高频改动先过脑）

### 链路 1：配置到执行

- Workspace 配置 Provider → 发现模型 → 配置 Role → RoleBinding 绑定 Model → 创建 Session / AgentSlot → 派发 Task → 经 ACP 执行 → Artifact 回流
- 风险点：RoleBinding 与 Provider / Model 的引用一致性；能力不支持时的静默降级

### 链路 2：ACP 执行与权限

- 启动 Adapter → initialize 握手 → 创建 Session → 流式事件 → 权限请求 → 用户应答 → 取消或完成
- 风险点：权限请求未应答导致 Agent 挂起；Adapter 崩溃后的进程清理与状态恢复

## 高风险区域（改前优先补读）

- ACP Adapter 进程生命周期与孤儿进程清理 — `docs/modules/acp-runtime.md`
- 权限请求中转，未应答会挂起 — `docs/modules/orchestration.md`
- 本地控制面安全（Local Token、Origin / Host 校验） — `docs/modules/http-ws.md`
- 上下文增长与跨 Session 隔离 — `docs/modules/context.md`
- 凭据边界，禁止原文进入配置 / 日志 / Prompt — `docs/modules/credentials.md`

## 长期有效规则（跨任务复用）

- **[约束]** 新增 SQLite migration 必须同步 `CURRENT_SCHEMA_VERSION`：迁移函数体在 `version >= CURRENT_SCHEMA_VERSION` 处提前 return，常量漏改会让已处于上一版的库跳过新迁移，而 `:memory:` 从 0 建库的测试发现不了；迁移测试要构造旧版库文件。
- **[约束]** Provider、Model、Role 通过 RoleBinding 组合；Orchestration 不得分支依赖具体 Provider 或 Adapter。
- **[事实]** Workspace Role / RoleBinding 的 JSON 配置是独立事实来源；ProviderConnection / ModelCatalog 仍由 SQLite 提供引用校验，跨存储变更必须通过 Application 编排。
- **[约束]** Workspace JSON 配置的读取、引用检查、CAS 版本比较和原子写入必须在同一异步串行 mutation 临界区内完成，路径使用安全 hash 目录并拒绝符号链接。
- **[约束]** Codex config.toml 导入只产生非秘密草稿；preview 绑定源摘要、目标 Provider 和 config_revision，SQLite 条件更新成功前不落盘凭据，OAuth/auth.json 永不复制。
- **[约束]** isolated Codex Runtime 必须过滤继承环境中的敏感变量；Secret 只由 Infrastructure 在 Adapter spawn 边界通过 CredentialStore 读取并注入固定 Provider 环境变量，Application/Domain 只传 credential_ref。
- **[约束]** `credential_ref` 只与 `isolated` 配对：inherited 连接在创建时和 Runtime 读取 CredentialStore 前都拒绝（`credential_environment_mismatch`），不能静默忽略或注入用户继承环境。
- **[平台]** `security add-generic-password ... -w` 放在末尾会进入提示模式，从 stdin 连读两行相同密码；两次不一致时命令**仍返回 0**，所以「写入成功」不能只看退出码。Keychain 分类以退出码为主（44 item-not-found、36 interaction-not-allowed、51 auth-failed），文案兜底只在非零且未识别退出码时使用——成功退出码的 stdout 就是 Secret 原文，拿它做关键词匹配会把合法 Secret 误判为 not found。
- **[约束]** Secret 脱敏必须覆盖 Runtime 的**全部出口**，不只是事件：ACP 成功响应结构（initialize 能力、session/new 与 set_config_option 的 configOptions、进而 discover 返回并写入 SQLite 的模型目录）与错误 message/data 都要先经当前连接 scope 递归脱敏才能离开 Infrastructure。
- **[约束]** 流式脱敏窗口只对 `text` 字段生效，且按 `streamId + 字段路径` 隔离、flush 必须按路径分别返回（不同路径尾部拼接可能重组出完整 Secret）。结构化字段（事件 kind、工具标题）**不能**参与窗口：flush 会截断它们自身的内容，实测 `tool_call_update` 变成 `tool_call_upda`。
- **[约束]** Runtime 还原 turn 尾部时必须同时满足「恰好一条窗口 + 路径就是 `text` + owner 唯一且是已知事件 kind」，用原 kind 发出；否则丢弃——把 thought/tool 字段的尾部改写成普通 Agent 消息比丢文本更危险。
- **[平台]** ACP 权限请求 ID 的 JSON-RPC 类型（number / string）就是身份的一部分：`1` 与 `"1"` 是两个请求，可并存并分别应答。全线（pending map 键、RuntimeEvent payload、DTO、SQLite、超时回传）都用带类型标签的编码，禁止 `String(id)` 归一；类型不匹配 fail-closed，只有同类型同值重复才算冲突。
- **[约束]** JSON-RPC request ID 的合法域只有一处定义：Contract 的 `isJsonRpcRequestId`（非空 string 或 `Number.isSafeInteger` number）。ACP ingress、Contract schema、Runtime、ConversationService、SQLite codec 都必须复用它——各自放宽会让空 string/小数/超安全整数先进入 pending，再被下游丢弃，留下永远无法应答的权限请求。
- **[平台]** SQLite 的 JSON 数字列经 better-sqlite3 会变成 REAL（实测 `1` 读回 `'1.0'`），所以任何需要保真的 ID/整数必须用带标签 TEXT 或显式 INTEGER 列，不能依赖 JS number 往返。
- **[事实]** 两个锁定 Adapter 在**无网络、无真实凭据**下可完成 isolated `connect`（initialize 握手）与 `session/new`，因此可用合成 Secret 做真实链路 smoke（`RUN_ACP_CREDENTIAL_SMOKE=1`）；发 prompt 才会真正走网络。
- **[平台]** custom endpoint 的生效方式不对称：Claude 读 `ANTHROPIC_BASE_URL`（isolated/inherited 都生效，业务请求为 `POST /v1/messages`，`HEAD /api/hello` 只是连通性探测）；**Codex 不读 `OPENAI_BASE_URL`**，只认 `CODEX_HOME/config.toml` 的 `[model_providers.<id>] base_url`。实测 Codex 在 custom endpoint 请求上**不带任何认证头**，因此 Codex custom endpoint 的认证是否生效仍属未证项。证据见 `docs/architecture/Adapter-CustomEndpoint-Probe.md`。
- **[平台]** macOS `sandbox-exec` 可用于 loopback-only 出口隔离（`(deny network*)` + 放行 localhost），策略继承到子进程；判定必须断言**具体错误码 `EPERM`**——超时或不可达不能当作隔离生效。Adapter Probe（`RUN_PROVIDER_ADAPTER_PROBE=1`）据此设硬门槛，并用最小环境 allowlist 剔除真实凭据与代理变量：实测继承 `ANTHROPIC_AUTH_TOKEN` 会让 Claude 请求改用它，等价于 Probe 使用了开发者真实凭据。注意 loopback 代理是 sandbox 拦不住的通道（允许 loopback），所以代理安全靠「环境里没有代理变量」，且不能用 `net.connect` 或 `http.Agent({proxy:true})` 去验证——它们不读代理变量。
- **[平台]** macOS `sandbox-exec` 的 SBPL `remote ip` host 仅接受 `*` 或 `localhost`，不能用规则把 broker 出站限制到固定公网 IP 集；需要精确目标 IP 隔离时不得把代码内 allowlist 当作 sandbox 等价替代。
- **[约束]** Domain 不依赖 I/O、HTTP、数据库、Provider SDK 或 UI；外部系统一律通过 Port 接入。
- **[约束]** 新增模块必须先写模块能力文档，再实现代码。
- **[约束]** 凭据只保存引用，不进入普通配置、日志、Prompt 或 Artifact。
- **[事实]** ACP 握手是模型能力的权威来源，离线映射表只作兼容兜底。
- **[事实]** Web UI 只依赖 Contract、HTTP/WS Client 和 PlatformHost，不直接依赖 Tauri / Electron。
- **[平台]** 本地服务能启动进程并使用密钥，因此即便不做用户登录，也必须校验 Local Token、Origin 和 Host。
- **[坑位]** UnoCSS preflight 会重置基础样式并与 Naive UI 冲突，必须显式关闭或限定作用域。
- **[约束]** 暗色模式必须统一到一个开关：Naive UI 走 `darkTheme`，UnoCSS 走 `dark:` 变体，不允许各写各的。
- **[约束]** 业务代码禁止直接调用 `axios` / `fetch` / `WebSocket`，只能经封装层；wire 行为唯一定义在 `docs/architecture/数据模型与API.md`。
- **[约束]** 当前跨平台凭据路线只维护 macOS Keychain；Linux Secret Service/libsecret 不纳入项目范围，Windows Credential Manager 延后处理。
- **[约束]** 认证只支持两条路径：继承本地 CLI 状态（inherited），或使用 API key（isolated `credential_ref`）。Rolecast 不实现 OAuth、device-code、交互终端登录、`ProviderAuthPort`、认证回调或认证状态持久化。
- **[平台]** Node `child_process` 的 stdout 数据可能晚于 `exit` 事件到达；解析子进程输出要等 stdout `close`，否则会读到空字符串造成偶发误判。

## 观察中模式（持续学习信号收集）

> 格式、阈值、何时计数见 `.agents/continuous-learning.md`。第一次就能写成结论的坑不要记在这里。

<!-- 已达阈值、等待用户确认是否固化的模式写在「持续学习通知区」。 -->

## 持续学习通知区

> 达阈值后写在这里并问用户。条目形态见 `.agents/continuous-learning.md`。

## 读取建议（给新 AI）

1. 先读本文件的"架构地图 + 关键链路"
2. 再读"长期有效规则 + 高风险区域"
3. 命中具体领域时，按需读对应 `.agents/*.md`
4. 接着干未完成任务时，按需读 `TASK_MEMORY.md`

## 维护规则

- 写入 / 删除门槛见 `.agents/ai-memory.md`
- 只写结论与边界；证据与实现回 PR / 代码
- 收尾或压缩前按删除门槛扫存量（过期 / 实现细节 / 重复 → 删或合并）
