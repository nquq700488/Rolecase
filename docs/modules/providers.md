# Providers 模块

## 目标

管理 Provider 类型、连接配置、模型目录和动态能力缓存。

## 对外提供的能力

```text
listProviderDefinitions()
createConnection(input)
updateConnection(id, input)
deleteConnection(id)
testConnection(id)
discoverCapabilities(id)
listModels(connectionId)
getCapabilitySnapshot(connectionId)
previewConfigImport(connectionId, sourcePath)
applyConfigImport(connectionId, draftVersion)
```

## 能力发现

Providers 模块只处理规范化后的 `CapabilitySnapshot`，不解析 ACP 帧，也不依赖具体协议字段。Phase 1A 的模型目录来源是 Runtime 从 ACP `session/new` 提取的 `config_options.category=model`，不能假设 initialize 快照直接提供 `models` 字段。用户选择的模型必须在该目录中，并由 Session 用例通过 Runtime Port 应用到 ACP Session。

能力来源由 `CapabilityDiscoveryPort` 提供，Providers 负责：

- 保存能力快照；
- 记录 source、observed_at 和 adapter_version；
- 将过期能力标记为 stale；
- 向配置页提供可选项。

具体 ACP initialize 和字段转换由 ACP Runtime 负责，见 [acp-runtime](acp-runtime.md)。

## Provider 与 Role

Provider 和 Role 都是配置实体，不能互相拥有。RoleBinding 负责组合 Role、ProviderConnection 和 Model。

## 环境模式与 Codex 配置导入

ProviderConnection 的 `environment_mode` 默认是 `inherited`。Providers 模块只管理连接配置和导入草稿，不负责启动进程或读取 Credential 原文。Codex 导入成功后保存 `codex_config` 和 `config_revision`，通过 SQLite 条件更新实现目标连接 CAS。

`credential_ref` 只与 `isolated` 配对：

- `createConnection` 创建 inherited 连接时拒绝携带 `credential_ref`（422 `credential_environment_mismatch`），避免引用被静默忽略或注入用户继承环境；
- **Claude** 可以直接以 isolated 创建：`api_key` / `custom_endpoint` 必须带 `credential_ref`（创建前只 `validate`，绝不 `get` 原文；不存在 / 拒绝 / 不可用分别映射 `credential_not_found` / `credential_denied` / `credentials_unavailable` 且不写记录），`custom_endpoint` 还必须带 `base_url`；`local` 可以无引用保存为待配置；引用可由 Provider 页的 `POST /api/credentials` 直接生成，无需外部预置；
- **Codex** isolated 仍只能由 `applyConfigImport` 一次性写入 `environment_mode=isolated`、`credential_ref` 与非空 `codex_config`，`createConnection` 直接拒绝；导入含 `base_url` 时连接同时转为 `custom_endpoint`；
- 历史数据或直接调用若出现 `inherited + credential_ref`，Runtime 在读取 CredentialStore 前抛出 `credential_environment_mismatch`，`testConnection`、`discoverModels` 和 Session 创建统一映射为结构化 422。

### 非秘密连接更新与目录失效

`updateConnection` 允许修正 `connection_kind`、`environment_mode`、非秘密 `base_url` 与既有 `credential_ref`（`null` 表示清空），必须携带 `config_revision` 做 CAS。`codex_config` 只接受 `null`（用于清除历史遗留值），不接受任意写入。请求中**省略**字段表示保持原值，`null` 表示清空。对 `base_url` 与 `credential_ref`：目标组合仍使用该字段且未提供新值时**省略**以保留原值；目标组合不再使用该字段时才发 `null`（例如 non-custom 连接清 `base_url`、inherited/local 清 `credential_ref`）。反向操作会失败：该清不清会被组合校验拒绝，该留却发 `null` 会让 isolated 连接缺少引用。Secret、Token 或认证会话字段一律拒绝。

- 顺序固定：请求 schema/组合校验 → Workspace/Provider 存在 → 引用只 `validate`（绝不 `get`）→ CAS 写入；任一步失败都不写入、不改变 revision。
- Claude 连接携带遗留 `codex_config` 属于历史脏数据：组合判定 fail-closed，页面显示「配置不合法」，只能通过 `codex_config: null` 清除后重建配置。
- 配置更新成功后，同一事务内删除该连接的 `model_catalog` 行：旧目录立即不可见。
- `discoverModels` 捕获开始时的 `config_revision`，通过 `saveModelsIfCurrentRevision` 在同一事务内「检查 revision + 替换目录」。Adapter 往返期间配置被更新时返回 409 `state_conflict`，旧发现不会复活旧目录。

### 组合规则（`provider-combination.ts`）

`resolveProviderCombination` 是 `provider_kind × connection_kind × environment_mode × credential_ref/base_url/codex_config` 的唯一判定点，`testConnection`、`discoverModels` 与 `SessionService.create` 共用，判定在 spawn 与读取 CredentialStore 之前完成。

| 结果 | 含义 | Application 映射 |
|---|---|---|
| `ready` | 可运行；`requiresCredential` 表示 Runtime 需读取引用 | 继续 |
| `needs_configuration` | 结构允许但配置不足（isolated local、缺引用、缺 base_url、Codex 缺 `codex_config`） | 422 `provider_needs_configuration` |
| `invalid` | 结构上不成立（inherited+ref、Claude 带 `codex_config`） | 422 `credential_environment_mismatch` / `unsupported_option` |
| `unverified` | endpoint 覆盖已证实、认证未证 | 422 `codex_custom_endpoint_unverified` |

关键条目：

- Claude inherited 的 local / api_key / custom_endpoint 均可运行；custom_endpoint 必须有 `base_url`，并通过 `ANTHROPIC_BASE_URL` 生效（Probe 实测）。
- 创建路径与运行判定分离：`createConnection` 只校验请求形状（引用格式、URL、环境模式），能否运行由 `resolveProviderCombination` 在 test/discover/Session 入口判定——因此 Claude isolated local 可以保存，但运行一律待配置。
- Claude isolated local 保存可接受，但三个运行入口统一待配置——不存在可用的隔离认证路径。
- Claude isolated api_key / custom_endpoint 需要 `credential_ref`；custom_endpoint 额外需要 `base_url`。
- Codex isolated 只由 config-import/apply 建立；api_key 需要非空 `codex_config` 与引用，local 一律待配置。
- **Codex custom endpoint 一律 `unverified`**：Probe 证明 endpoint 覆盖生效，但请求不带任何认证头，因此只能记录 endpoint，绝不能声明 ready。
- 该判据看的是**有没有 `base_url`**，不是 `connection_kind`：旧版 apply 可能把 `base_url` 留存在 `api_key` / `local` 记录上，那些形状同样不能按普通连接运行。
- 持久化 `codex_config` 也必须能物化出 config.toml 字段（`model` / `wire_api` / `reasoning_effort`）；只有 `model_provider` 时判待配置，避免组合判 ready 却在 Runtime 读完 Secret 后才失败。
- 非 custom_endpoint 连接不能设置 `base_url`，避免 URL 被存下却从不生效。

Codex 隔离时：

- 模型目录来自 Runtime 握手与 `session/new` 的成功响应，这些结构在离开 Runtime 前已按当前连接 scope 脱敏，因此 `discoverModels` 写入 SQLite 的目录不会携带 Secret；Providers 模块不额外接触 Secret；
- `previewConfigImport` 只读取受控 Codex Home（`CODEX_HOME` 或 `~/.codex`）下由用户选择的普通 `config.toml`，提取并脱敏非秘密字段（网关、base URL、模型目录、推理默认值）；受控根目录必须由当前用户拥有且不可被其他用户写入；
- preview 不写入 Rolecast 配置，也不修改用户的 `~/.codex`；preview 绑定 Workspace、Provider、源文件 SHA-256 和目标 revision，并生成短生命周期一次性 `preview_id`；
- 文件本身和父目录中的符号链接、非普通文件、超大文件和非法 TOML 均拒绝；读取使用 `O_NOFOLLOW`、打开句柄 dev/ino 校验和同一句柄摘要，避免检查后路径替换；
- base URL 只允许 HTTP/HTTPS host，拒绝 username、password、query 和 fragment；`auth.json`、OAuth、API Key、Token 等字段只产生固定 warning，不进入草稿；
- `applyConfigImport` 必须带用户确认、preview ID 和目标 revision；claim 后先校验草稿**能否形成 Runtime 配置**（`base_url` / `wire_api` / `model` / `reasoning_effort` 至少一个），再校验凭据引用，最后用数据库条件更新保存非秘密字段——有效配置校验必须先于 CredentialStore，避免「判定 ready 但 Runtime 配置为空」；
- 草稿带 `base_url` 时写入连接必须同时把 `connection_kind` 改为 `custom_endpoint`：否则普通 api_key 会带上 endpoint 绕过「Codex custom endpoint 认证未证」的边界；
- `local` 连接不接受 `credential_ref`，create 与 apply 两条写入路径都在任何 validate / 写入之前拒绝；
- API Key 连接必须提供可由 CredentialStore `validate` 验证的 `credential_ref`；Runtime 在 Adapter spawn 前通过 CredentialStore 读取并注入固定 Provider 环境变量，Secret 不进入 Application、配置或日志；引用缺失、Keychain 不可用或 Secret 不存在时 isolated Codex fail-closed；local/custom endpoint 同样不能静默继承认证；认证路线固定为 inherited 本地 CLI 或 isolated API key，登录态不复制、Rolecast 不实现登录；
- 草稿不完整或目标连接已变化时返回结构化冲突，不得静默改回 `inherited`。

Rolecast 不复制整个 Codex 配置目录、`auth.json` 或用户技能目录。具体配置字段如何翻译给 Adapter 由 ACP Runtime 负责，ProviderService 与 SessionService 共用同一个 Runtime 输入映射。真实系统 Keychain 与 Web 文件选择器另行实现；Run resume/retry 与 Runtime 重挂接已由 Phase 1F 完成。

## 依赖

允许依赖：domain、RepositoryPort、CapabilityDiscoveryPort、CredentialStorePort（仅引用校验，不读取原文）。

禁止依赖：具体 Vue 组件、HTTP 路由、Task 调度、Credential 原文。

## 错误

区分 connection_invalid、capability_discovery_failed、model_unavailable、unsupported_option、config_import_invalid、config_import_not_found、config_import_stale、config_import_target_conflict、credential_environment_mismatch 和 codex_custom_endpoint_unverified。能力发现入口（`testConnection`、`discoverModels`）把 Runtime 抛出的凭据/环境错误映射为结构化错误：`credential_environment_mismatch`、`provider_needs_configuration`、`codex_custom_endpoint_unverified` → 422，`credential_denied` → 403，`credentials_unavailable` → 503；无法识别的错误原样上抛。

## 升级策略

Provider 新增能力只能通过能力快照和 Contract 支持，不在 Orchestration 中添加 Provider 分支。

## 输入、输出和错误

输入是 ProviderConnection 和 CapabilitySnapshot；输出是模型目录、可选配置和连接错误；不支持的能力必须显式返回。

## 状态和不变量

能力快照可以 stale，但不能伪装成最新；Model 必须属于对应 ProviderConnection；删除连接不能留下可运行的 Binding；`codex_config` 只能保存非秘密字段；`credential_ref` 只能出现在 `isolated` 连接上。

## 持久化

保存非敏感连接配置、Codex 非秘密配置、Model Catalog 和能力快照；密钥只保存 credential_ref。

## 事件

发布 provider.connected、provider.capabilities_updated、provider.health_changed 等脱敏事件。

## 安全边界

不接触 Credential 原文；Base URL 必须校验协议和本地访问策略；不允许从远程配置静默执行命令；导入 preview/apply 不返回文件路径、TOML 原文或秘密字段。

## 替换和升级策略

新增 Provider 通过 ProviderDefinition 和 CapabilitySnapshot 接入，不在 Orchestration 中添加 Provider 分支。Codex 导入通过 `CodexConfigImportPort` 替换 TOML 读取实现，不改变 ProviderService 契约。

## Auth Feasibility（Phase 1C 历史探测，不在产品范围）

认证路线已固定为两条：**继承本地 CLI 状态（inherited）**或**使用 API key（isolated `credential_ref`）**。Rolecast 不实现 OAuth、device-code、交互终端或其他登录流程；本节记录的是 Phase 1C 对 Adapter 登录能力的探测结果，只作为 Adapter 行为资料，不构成产品待办。

| 客户端能力声明 | Claude 0.90.0 | Codex 2.2.2 |
|---|---|---|
| 默认 | `authMethods = []` | `api-key`、`chat-gpt`（`NO_BROWSER` 会去掉 `chat-gpt`） |
| `terminal` + `auth.terminal` | `claude-ai-login`、`console-login`（`type=terminal`，args 4 项） | 无变化 |
| `elicitation.url`（对象） | 无变化 | 增加 `chat-gpt-device-code` |
| `auth._meta.gateway` | `gateway`、`gateway-bedrock` | 增加 `gateway` |

可复用的结论：

- **`authMethods` 为空不能判定 Provider 不可用**：Claude 在默认能力下为空，声明 terminal 后才出现方法。
- **Codex 的 auth method 不带 `type` 字段**（`api-key` / `chat-gpt` / `chat-gpt-device-code` / `gateway` 都是如此）；不要假设统一 `type` 枚举，只能按 method ID 分类。
- **URL elicitation 能力形状是 `elicitation: { url: {} }`（对象）**，顶层而非 `auth` 之下；写成 `true` 不会让 Adapter 暴露 device-code 方法。
- Claude terminal 方法必须由客户端另起交互终端，**不能**传给 `authenticate`。

探测记录的边界（不产生产品能力）：

- Codex `chat-gpt-device-code` 的取消路径在 loopback-only sandbox 下未观察到 URL elicitation，结果为 `unverified: elicitation_not_observed:<failureKind>`；该探测不再继续，也不影响当前本地 CLI / API key 路线。
- 未调用 `authenticate` 完成登录，未产生 Token，未验证 `authenticated` 状态；这些能力不会实现。
- 不新增 `ProviderAuthPort`、认证接口、HTTP 路由、SQLite 表、Web 登录入口或认证状态持久化。

可运行性仅由本地 CLI 继承或 API key 引用决定；`authMethods` 不参与产品状态判定。

## 已知限制

第一阶段只验证 Claude 和 Codex；其他 Provider 需要独立 Adapter Contract Test。macOS Keychain 与 Provider 页的 API key 凭据创建入口已实现；Web 文件选择器尚未实现（Codex 导入仍输入服务器路径），Linux/Windows 凭据后端延后；OAuth、device-code 与交互终端登录不在产品范围。运行可运行性不能由 `authMethods` 单独推断，也不依赖登录能力发现。

## 测试

使用 Fake AgentRuntime 测试握手、能力缓存、模型失效、版本变化和连接测试；使用 Codex Config Import Contract Test 覆盖非秘密字段、路径安全、摘要冲突、URL 凭据过滤和 preview 一次性消费。组合规则另需覆盖：`resolveProviderCombination` 的 ready / needs_configuration / invalid / unverified 全矩阵；创建 inherited 连接携带 `credential_ref`、custom_endpoint 缺 `base_url`、非 custom 连接设置 `base_url` 均被拒绝且不写记录；Claude isolated local 与 Codex isolated local 在 test/discover/Session 三入口统一待配置、不 spawn、不写 Session/Slot；Codex custom endpoint 返回 `codex_custom_endpoint_unverified` 且 HTTP 响应不含合成 Secret。
