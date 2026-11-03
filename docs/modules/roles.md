# Role / RoleBinding 模块

## 目标

管理 Workspace 内可复用的 Role 定义，以及将 Role、ProviderConnection 和已发现 Model 组合起来的 RoleBinding。该模块为后续 AgentSlot 和多 Agent 编排提供稳定配置，不直接执行 Agent。

## 对外提供的能力

- 创建、读取、列出、部分更新和删除 Role；
- 创建、读取、列出、部分更新和删除 RoleBinding；
- 校验 Role、ProviderConnection、Model 的 Workspace 归属；
- 以 `version` 提供乐观并发控制；
- 保存非秘密 Workspace 配置，并为 Web 配置页提供稳定错误语义；
- Session 创建初始 AgentSlot 或后续新增 AgentSlot 时，解析并验证同 Workspace 的 RoleBinding 与 Role；绑定必须启用且不含暂不支持的 `runtime_options`，Role 必须 `selectable` 且 `dispatchable`。Application 使用已验证的配置为 Slot 生成私有、不可变的 Role/Binding source snapshot。

## 不提供的能力

- 不启动 ACP Adapter，不读取 Credential 原文；
- 不执行 `gates`、`blocking_conditions` 或 `output_contract`；
- 不决定 Coordinator、TaskBoard、Workflow 或 AgentSlot 调度；
- 不把 Binding 的变更追溯写入既有 AgentSlot；
- 不提供 Provider 特定分支或模型运行时配置应用。

## 公共接口

Application 通过以下 Port 使用本模块：

- `RoleConfigRepositoryPort`：Role/Binding 的读取和写入；Slot 解析通过 `getBindingWithRole(workspaceId, bindingId)` 从同一 JSON snapshot 读取一对配置，避免并发更新时混用不同版本；
- `RepositoryPort`：读取 Workspace、ProviderConnection 和 ModelCatalog；
- `ClockPort` / `IdGeneratorPort`：生成时间和标识。

所有 Role/Binding 写入必须经过 `WorkspaceConfigPort.mutate` 的同 Workspace 串行临界区。mutation 支持异步 callback：读取、引用检查、版本比较和原子写入在锁内完成；Binding 的 Provider/Model 校验通过 Port callback 在同一锁内重新执行，不能只依赖锁外预检查。

## 输入、输出和错误

输入是经过 Contract Schema 验证的创建或更新命令。输出是不可变 RoleDto / RoleBindingDto。

稳定错误包括：

- `workspace_not_found`、`role_not_found`、`binding_not_found`；
- `model_unavailable`：模型不存在、归属不一致或不属于指定 ProviderConnection；
- `resource_in_use`：删除仍被 Binding 引用的 Role；
- `state_conflict`：版本冲突或其他并发状态冲突；
- `invalid_request`：字段或 runtime_options 不合法。

错误 details 不包含 runtime_options 敏感值、Credential、文件内容或内部堆栈。

## 状态和不变量

- Role 与 RoleBinding 都属于且只能属于一个 Workspace；
- Role 不直接绑定 Model；Binding 才持有 ProviderConnection 和 Model 引用；
- Binding 的 Role、ProviderConnection、Model 必须属于同一 Workspace，且 Model 必须属于指定 ProviderConnection 的 ModelCatalog；
- `version` 从 1 开始，每次成功更新递增；更新必须提供期望版本；
- Role 删除与 Binding 创建/更新在同一 Workspace mutation 内完成，不能产生悬空 Binding；
- Role/RoleBinding 变更不修改已经创建的 AgentSlot 私有 source snapshot（Role/Binding ID、version、prompt、guidelines、output contract）；改动只作用于新 Slot；
- Role 的 prompt、guidelines、gates、output contract 和 blocking conditions 是数据，不在本模块执行；
- 配置 mutation 失败时原 JSON 文件保持不变。

## 允许依赖

- Domain 值对象和纯校验函数；
- `application/ports`；
- `packages/contract` 的 DTO 映射；
- JSON Config Port；
- Provider/Model 的只读 Repository Port。

## 禁止依赖

- ACP SDK、Adapter 进程、HTTP、Fastify、Vue；
- SQLite Driver、Node 文件 API（Application / Domain 禁止；仅 Infrastructure Config 实现允许）；
- CredentialStore 原文；
- Coordinator、TaskBoard 和具体 Provider 分支。

## 持久化

Role 和 RoleBinding 是 Workspace JSON 配置，默认保存于受控 runtime root 下按 Workspace ID hash 隔离的 `config.json`。配置文件包含 `schema_version` 和配置 `version`。

写入要求：目录和文件权限受限；路径进行 realpath 与符号链接检查；临时文件与目标文件同目录并原子 rename；迁移前保留带时间戳备份；未知版本或迁移失败 fail-closed，不覆盖原文件。

SQLite 保存 Phase 1A 的 Workspace、ProviderConnection 和 ModelCatalog 运行数据。跨存储引用由 Application 在 JSON mutation 临界区内校验；当前 Provider/Model 没有删除路径，未来增加删除前必须加入引用阻断或跨存储迁移事务。

## 事件

本切片的配置 CRUD 不发布 Agent 运行 EventBus 事件。后续若需要配置审计，应新增明确的配置事件契约，不复用运行事件。

## 安全边界

- 原始 API Key、OAuth 文件、Token 和 Credential 不得进入 JSON、DTO、日志、Prompt 或 Artifact；
- workspace 路径使用固定 SHA-256 hash 目录键，不直接拼接用户输入；
- 只允许浅层、有限数量的 runtime_options primitive 值，并在 Contract、Application、Repository 三层拒绝敏感键；
- 所有 HTTP 写操作仍受 Local Token、Origin 和 Host 保护；
- 跨 Workspace 资源访问不返回资源是否存在的额外信息。

## 替换和升级策略

RoleConfigRepository 可以替换为 SQLite、远程配置服务或 Tauri 文件实现，但必须保持 Port 的 async mutation/CAS 语义、Workspace 隔离、版本冲突和错误码。配置文件 schema 只能通过显式 migration registry 向前升级；升级失败保留原文件和备份。

新增或修改 Role/Binding 字段必须同步 Contract、Domain 映射、Web 表单和配置 migration，并补充兼容测试。

## 测试策略

- Contract：字段边界、未知字段、空 PATCH、runtime_options 敏感键；
- Domain：默认值、trim、版本递增、不可变性和 Workspace 不变量；
- Config：异步 mutation 串行、CAS 竞争、删除/创建竞态、原子写、迁移备份恢复、路径遍历和符号链接；
- Application：跨 Workspace、ModelCatalog 引用、错误脱敏和引用删除保护；
- HTTP：鉴权、单资源 GET、CRUD、409/422 和错误信封；
- Web：加载/空态/错误/冲突恢复、键盘操作和响应式无溢出。

## 已知限制

- Phase 1B 使用单 Server 进程内的 Workspace mutation 串行化，不提供多进程分布式锁；
- ProviderConnection / ModelCatalog 仍由 SQLite 管理，当前没有删除路径；
- Binding 的 runtime_options 尚不应用到通用 Runtime；AgentSlot 创建会拒绝非空 runtime_options，避免静默忽略；
- Slot 创建与运行生命周期由 Session/Context/Application 模块负责；本模块只解析并验证 Workspace-scoped RoleBinding。
