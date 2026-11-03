# ACP Runtime 模块

## 目标

封装 Claude 和 Codex ACP Adapter 的进程生命周期、stdio 通道、Session 和事件转换。

## 对外提供的能力

```text
connect(connection)
discoverCapabilities(connection) → CapabilitySnapshot
createSession(agentSlot, options)
sendTurn(runtimeSession, input, context)
respondPermission(runtimeSession, requestId, decision)
cancelTurn(runtimeSession, turnId)
resumeSession(runtimeSession)
closeSession(runtimeSession)
```

## 内部职责

- spawn 和 kill Adapter；
- initialize 握手；
- 管理 stdio JSON-RPC；
- 转换 Runtime Event；
- 处理权限请求；
- 接收结构化 ContextBundle，并在通用 ACP `session/prompt` 边界按确定顺序渲染为文本段；Provider 分支不得自行拼装 Role prompt；ACP 不提供通用 system-message 通道，因此 Role 指令只是普通文本上下文，不是权限或 prompt-injection 防护。
- 将 `ProviderConnection.environment_mode` 翻译为 Provider 支持的运行时目录、配置和凭据注入方式；isolated 模式通过 CredentialStorePort 读取 `credential_ref`，只在 Adapter spawn 前构造临时 env；
- inherited 模式保留用户环境，不主动覆盖认证变量；isolated 模式过滤继承环境中的敏感变量；Codex/Claude 只允许固定的 Provider 环境变量名；凭据读取失败在 spawn 前返回可分类错误；
- **inherited 不接受 `credential_ref`**：历史数据或直接调用出现 `inherited + credentialRef` 时，在读取 CredentialStore 之前抛出 `credential_environment_mismatch`，不 spawn、不读 Secret；
- 读取 Secret 成功后创建 `SecretRedactionScope`，并用覆盖配置解析、目录物化、spawn、initialize 的 `try/finally` 保证任一步失败都会 `close()` 未交接的 scope；成功 initialize 后 scope 才交给 Context 持有，由连接失效清理在进程回收前关闭；
- **spawn 前组合闸门**：`connect` 在读取 CredentialStore 之前先做防御性组合校验；inherited+ref、isolated local、isolated 缺引用、custom_endpoint 缺 `base_url` 直接抛 `provider_needs_configuration`，Codex custom endpoint 抛 `codex_custom_endpoint_unverified`（认证未证）。Application 已过滤一遍，Runtime 是最后一道闸；
- **custom endpoint 翻译**：只有 `connectionKind === 'custom_endpoint'` 且有 `baseUrl` 时，Claude 注入 `ANTHROPIC_BASE_URL`（inherited 与 isolated 都生效，Probe 实测）。Codex 不走环境变量，只由 `CODEX_HOME/config.toml` 的 `base_url` 生效；
- **所有离开 Runtime 的成功响应结构也要脱敏**：initialize 的 `agentCapabilities` / `authMethods` / `agentInfo`、`session/new` 与 `session/resume` 的 `configOptions`、`session/set_config_option` 的 `configOptions` 都必须先经当前 scope 递归脱敏，再构造 CapabilitySnapshot、RuntimeSession 和配置选项；正常模型配置语义不变（无 Secret 时脱敏为恒等变换）；
- 统一的连接失效清理路径：显式 `closeConnection`、ACP fatal 错误和 Adapter 异常退出（崩溃 / 空闲退出）都调用同一个幂等清理，同步占用 contexts 条目以避免竞态，依次关闭 scope、丢弃流窗口、拒绝并清空 pending permission、移除 Context、回收进程；清理由进程 `exited` 与 fatal 回调驱动，递归调用因条目已删除而自然终止；
- 处理传输超时、取消、崩溃和重启；业务层权限软/硬超时由 Orchestration 根据持久化时间戳驱动；
- ACP stdio 的 stderr 持续 drain 但不保留；stdout 单帧超过受控上限时终止 framing 和整个 Adapter 进程组；
- ACP 帧不是合法 JSON 或不是合法 JSON-RPC 报文时转为稳定的 fatal 错误，错误信息不含原始行（`JSON.parse` 的报错会把输入片段带进 message）；
- **非主动关闭的 stdio 中断**（Adapter 半关闭 stdout、input error 或崩溃）同样转入 fatal 状态：标记 client closed、拒绝 pending 并触发 `onFatalError`，从而走统一连接失效清理。子进程可能仍存活，因此不能只依赖进程 `exited`；主动 `close()` 先置 closed，不会触发 fatal 回调，避免递归清理；
- sendTurn 的消费者提前结束时 abort pending request，再发送 ACP cancel notification 并等待底层请求收敛；
- 关闭连接时收敛所有 pending permission Promise，并且不再向已关闭的 Adapter 写响应；
- 清理孤儿进程。

## 接入路径与能力边界

本模块是**唯一**了解 Provider 差异的地方。

| Provider | Adapter | 底层形态 |
| --- | --- | --- |
| Claude | `claude-agent-acp` | Claude Agent SDK（内嵌 Bun 编译的 Claude Code 运行时） |
| Codex | `codex-acp` | `cross-spawn` 启动捆绑的 Codex CLI |

约束：

- **不得按 CLI 行为推断 Adapter 能力。** SDK 模式会拒绝部分 CLI 命令（如 `/mcp reconnect|enable|disable`），Adapter 需绕道 SDK control API。CLI 能做的事，通过 ACP 不一定能做。
- **ACP 是默认路径，但不是唯一路径。** AionCore 在同样的两个 Provider 上选择直连 CLI 原生协议。Rolecast 维持 ACP（ADR-003 / ADR-027），因为实测已证明 ACP 覆盖所需能力；若后续出现 ACP 无法满足的必需能力，逃生口是直连原生协议，参照 AionCore 的 `aionui-session` crate。证据见 [接入层能力矩阵](../architecture/接入层能力矩阵.md) §7。
- 工具集、权限系统、上下文压缩、子 Agent、MCP 客户端**由 SDK / CLI 提供**，本模块不实现这些能力，只做进程管理、协议转换与配置翻译。
- **文件访问范围由 Adapter / CLI 控制。** 工具执行在其内部，本模块无法事后拦截读写，只能正确传工作目录与权限模式，并保证不传错路径。
- 两个 Provider 能力集不对等（工具名称与语义、权限模型、压缩策略、MCP 方式均不同），不得假设对等。
- `inherited` 模式允许读取用户全局配置；`isolated` 模式必须使用 Rolecast 派生目录，不能通过软链接重新引入全局配置。
- Codex isolated 的非秘密配置必须来自已确认的 ProviderConnection；本模块不得自行读取并采纳 `~/.codex/config.toml`，也不得静默回退到 inherited；CredentialStore 的 Secret 读取只在 spawn 边界发生，Adapter 整个生命周期持有环境变量，关闭后注入生命周期结束；全新空目录或凭据引用缺失可能在 `session/new` 前返回 `provider_needs_configuration`，上层必须显示 `needs_configuration`。
- 具体差异只允许出现在本模块，不得外泄到 Orchestration 或 Application。

## 边界

上层不能知道：

- 子进程命令行；
- ACP 帧格式；
- Claude/Codex 环境变量名；
- Adapter 私有状态机；
- 哪个 Provider 走 SDK、哪个走 CLI。

## 依赖

允许依赖：AgentRuntimePort、CredentialStorePort、进程 API、ACP SDK。

禁止依赖：Role、TaskBoard、HTTP Controller、Vue。

## 版本策略

- Adapter 使用 lockfile 精确版本；
- 能力缓存记录 Adapter 版本；
- 禁止运行时自动升级；
- 升级前通过 ACP Contract Test；
- 失败时允许回滚。

### Adapter 依赖归属和启动

Claude/Codex Adapter 由 `packages/server` 以锁定版本的生产依赖拥有。Server 默认通过 Node `createRequire` 解析 Adapter 包入口，并使用当前 Node 进程启动，不要求 `claude-agent-acp` 或 `codex-acp` 预先出现在系统 `PATH` 中。`ROLECAST_CLAUDE_ADAPTER_COMMAND` 和 `ROLECAST_CODEX_ADAPTER_COMMAND` 可显式覆盖默认入口，用于外部安装、调试或替换 Adapter；覆盖命令不得写入凭据或业务配置。

## 错误

区分 adapter_start_failed、handshake_failed、session_failed、permission_timeout、turn_cancelled、adapter_crashed、credential_denied、credentials_unavailable 和 credential_environment_mismatch；ACP 单帧超限不得把原始 stdout/stderr 写入错误，非法帧使用稳定的 `ACP_INVALID_FRAME` 且不含原始行，远端错误的 message/data 必须脱敏后才能离开 Runtime。

## 输入、输出和错误

输入是规范化 ProviderConnection 和 ContextBundle；输出是 CapabilitySnapshot、Runtime Event 或明确的 Adapter 错误。

## 状态和不变量

每个 Runtime Session 只能由一个受控生命周期管理；关闭后不能发送 turn；Adapter 退出必须回收子进程和句柄。

## 持久化

不保存 ACP 原始帧；只由上层保存规范化 Event、Session 引用和能力缓存。

## 事件

输出 adapter_started、capability_discovered、session_update、permission_requested、adapter_crashed 等 Runtime Event。

## 安全边界

Secret 只由 Infrastructure 在 Adapter spawn 前从 CredentialStore 读取；父进程不把 Secret 原文保存到 Runtime Context、事件或日志，Adapter 子进程在其生命周期内持有对应环境变量，关闭后注入生命周期结束。Runtime 在 ACP payload 进入 RuntimeEvent 前对敏感字段、已知 Authorization/API-key 文本和注入 Secret 的精确字符串值执行防御性脱敏，ConversationService 在 EventStore/EventBus 边界再次脱敏；stdout、stderr 和错误都不得携带原始 Secret。

Secret 的精确匹配由短生命周期 `SecretRedactionScope` 完成：scope 只在连接期间持有原文（不序列化、不写日志、不进入事件），Context 只持有该对象本身。`session/update` payload 按 Session 文本流脱敏，维护「最长 Secret 前缀后缀窗口」以拦截跨 message chunk 的 Secret；取消、异常和连接关闭时 `dropStream` 丢弃窗口，下一轮不继承旧窗口。

turn 正常结束时 `flushStream` **按字段路径分别**交还安全尾部（每条都是 Secret 的真前缀，不构成完整 Secret）。Runtime 只在**同时满足**以下条件时才把尾部还原成事件：恰好一条窗口、字段路径就是 `text`、`owner` 唯一且是已知事件 kind。此时用原 kind 发出 `{ text }`，保持 thought / tool / message 的语义；否则丢弃——把 thought 或 tool 字段的尾部改写成普通 Agent 消息比丢文本更危险。权限请求与 turn 完成 payload 只做结构脱敏，不参与流窗口。

**JSON-RPC request ID 的类型就是身份的一部分**：number `1` 与 string `"1"` 是两个不同的请求，从 ACP request 到 pending map、`RuntimeEvent.payload.request_id`、`PermissionRequestDto.adapter_request_id`、SQLite 持久化、超时取消回传都必须保留该类型。

- Runtime 的 pending map 用带类型标签的键（`n:1` / `s:1`），`respondPermission` 按同样的键查找；类型不匹配时抛 `acp_permission_id_not_found`，**不退回按字符串查找**去命中另一个请求。
- **合法域全链路统一**：非空 string，或 `Number.isSafeInteger` number。ACP ingress（`isRpcId`）、Contract（`isJsonRpcRequestId`）、Runtime、ConversationService 与 SQLite codec 共用 Contract 里的同一个谓词。空 string、小数、NaN/Infinity、超 `MAX_SAFE_INTEGER` 的整数在进入 Runtime 前就被拒绝，不会留下无法应答的 pending。
- 不同类型的同值 ID **可以并存**（number `1` 与 string `"1"` 是两个独立请求），可分别应答与持久化往返。
- 只有**同类型同值**的重复请求才抛 `acp_permission_id_conflict`，fail-closed 且**不覆盖**已有 pending（覆盖会让原请求永久悬空）。
- 用户应答按 JSON-RPC 类型身份匹配：number `1` 的 pending 存在时，string `"1"` 应答被拒（`acp_permission_id_not_found`）且原请求仍可应答，反之亦然。
- SQLite 用带标签编码列 `adapter_request_id_encoded`（`n:` / `s:`）保存；编码入口同样按合法域校验并抛错，无标签或非法编码解码为 `null` 而不是猜测类型。历史裸文本列 `adapter_request_id` 在 migration 004 中按 **string** 身份迁移（旧版本确实按 string 使用该字段）。

成功响应与错误都必须脱敏后才能离开 Runtime：CapabilitySnapshot、RuntimeSession、配置选项在构造前递归脱敏；JSON-RPC 远端错误的 message 与 data 按当前 scope 脱敏后重建；非法帧转为稳定错误码且不含原始行。普通文本中嵌入未知格式的值仍由上层边界和 Provider 行为约束。

## Session 重挂接（Phase 1F）

Runtime 不持久化任何内容；`SessionService` 把 attachment 存在 SQLite。恢复时按 attachment 重新 `connect → resumeSession`，成功只登记连接并把非终态 Run 收敛为 `paused`，**不会自动 sendTurn**。Provider `config_revision`、provider kind、Adapter 版本、cwd/runtime directory 或私有 Adapter 指纹任一不一致都不 spawn，关联 Run 收敛 `interrupted`。指纹由实际 spawn 的 executable 解析路径与内容 digest、每个可验证入口文件的路径与内容 digest，以及非秘密参数组成；PATH/入口无法可靠解析时返回 `null`（fail-closed），不会退回仅比较版本号。

`session/cancel` 是 notification，调用返回不代表 turn 已停止；上层必须等待 turn 结束或 `turn_cancelled` 事件，否则只能把 Run 收敛为 `interrupted`。`resume` 与 `retry` 会重放原用户输入，属于 at-least-once，不是 ACP turn 的 exactly-once 恢复。retry 建立的新 ACP Session 会写回 attachment，旧 Session/连接在替换后关闭。

## 替换和升级策略

新增 Adapter 必须实现 AgentRuntimePort 和 CapabilityDiscoveryPort，并通过相同 Contract Test。

## 已知限制

Adapter 的具体认证能力和模型配置能力取决于运行时握手，不能由本模块强行补齐。

### 认证动作不在本模块

Runtime 只把脱敏后的 `auth_methods` 放进 `CapabilitySnapshot`；`authenticate`、`logout` 和 URL elicitation 回调**没有**进入 `AgentRuntimePort`，也不会加入。`_auth/status_update` 只作诊断状态观察，不是凭据获取接口。产品认证只支持 inherited 本地 CLI 或 isolated API key；Phase 1C 的可行性探针（`tests/contract/src/provider-auth-feasibility-probe/`，`RUN_PROVIDER_AUTH_FEASIBILITY=1` 门控）只是历史 Adapter 行为记录，独立于 Runtime 运行。

## 测试

Fake Adapter 测试协议状态；真实 Adapter 做 Claude/Codex 集成测试；必须覆盖崩溃清理、半关闭 stdio 和取消竞态。组合闸门另需覆盖：Claude isolated local、isolated 缺引用、custom_endpoint 缺 `base_url` 均在 spawn 前待配置且不读凭据；Codex custom endpoint 抛 `codex_custom_endpoint_unverified`；Claude custom_endpoint 的 `ANTHROPIC_BASE_URL` 确实进入 Adapter 环境。凭据边界另需覆盖：scope 在 spawn 失败、握手失败和正常关闭时被关闭（成功交接后不提前关闭）；跨 chunk 的完整 Secret 不出现在任何 yield 的 RuntimeEvent；不同字段窗口的尾部不被拼成完整 Secret；turn 尾部只在唯一归属且路径为 `text` 时按原 kind 还原，thought / 非 text / 嵌套 / 归属不唯一时丢弃；结构化字段不参与窗口因而不会被截断；initialize / session/new / set_config_option / discover 回显的 Secret 不进入 CapabilitySnapshot、RuntimeSession 和模型目录；远端错误的 message/data（含顶层数组）不含 Secret；非法帧不携带原始行且触发 fatal；合法域统一（空 string、小数、NaN/Infinity、超安全整数在 ingress 被拒且不登记 pending）；不同类型的同值 ID 可并存并分别应答，仅同类型同值重复才 fail-closed 且不覆盖已有 pending；关闭连接时 pending permission 收敛且不向已关闭 Adapter 写响应；Adapter 空闲退出、stdio 半关闭（子进程仍存活）、存在挂起权限时退出和 fatal 输入错误时都清理 Context、scope 与进程且重复关闭幂等。

真实 Adapter 的凭据注入由 `RUN_ACP_CREDENTIAL_SMOKE=1` 门控的 opt-in smoke 覆盖：用合成 Secret 走 FileCredentialStore → Runtime env → 真实 Claude/Codex Adapter 的握手与 `session/new`，并断言合成 Secret 不出现在返回结构里。

该 smoke 的准确边界：**不发送 prompt**，因此不会触发现有 Agent 执行链路；但它**不验证真实认证**，也**不保证完全没有网络活动**——Adapter 自身启动期的网络行为不由测试控制，未实现可验证的网络隔离。它证明的是「凭据引用被按引用读取」与「真实 Adapter 在注入环境下完成握手与建 Session」。

另有独立的 `RUN_ACP_SESSION_RESUME_SMOKE=1` smoke（`tests/contract/src/acp-session-resume-smoke.test.ts`），默认跳过；Claude/Codex 仅使用内存 CredentialStore 中的合成 Secret，不发送 prompt。Adapter A 创建 ACP Session 后关闭进程但不发送 `session/close`；新 Runtime/Adapter B 在同一 session ID、cwd 和 runtime/config 下调用 `session/resume`。它只验证 Adapter 层重挂接握手，不证明 Rolecast Server 进程重启、认证有效或对话上下文连续性，也不执行会重放原输入的 `resumeRun` / `retryRun`。

此 smoke 每次 Runtime 连接前以严格 macOS sandbox profile 预检 loopback 成功、外网连接明确 `EPERM`、adapterRoot 内写入成功及 controlRoot 写入明确 `EPERM`；任一预检不通过都在 CredentialStore 读取和 Adapter spawn 前 fail-closed。Adapter 仅能写入 0700 私有 adapterRoot；profile 放在 Adapter 不可写的 controlRoot，`HOME`、`cwd`、`TMPDIR` 和 provider runtime/config 均限定在私有树内。每次 `Runtime.connect` 前还会重新 canonicalize `cwd`、`runtimeDirectory`、`HOME`、`TMPDIR` 及 Codex `config.toml` 目标：目录或已存在配置文件是 symlink、硬链接（`nlink ≠ 1`）、无法 canonicalize 或逃逸 adapterRoot 时在凭据读取与 spawn 前 fail-closed。sandbox probe 超时或输出超限后 kill 进程组并等待 `exit` 与 stdout `close` 都确认才 settle；输出超限后只保留有限前缀，不再累积后续 stdout。退出无法确认时抛出保守失败，保留 probe 工作文件与临时目录，且仍关闭不依赖该子进程的 loopback listener。会在 Adapter 确认退出后以 no-follow 方式扫描普通文件中的合成 canary；不会读取或跟随 symlink。Claude 失败时只收集 `<sessionId>.jsonl` 的元数据（相对路径、file/symlink、size、nlink）：流式扫描 adapterRoot，受每目录、全扫描总量与匹配数上限约束，不读取文件内容、不输出绝对路径或原始 stderr。运行时 stderr 由 `AcpProcess` drain 并丢弃，因此该测试不宣称检查原始 Adapter stderr/log。真实 Adapter smoke 只有在明确授权的 macOS 环境中显式启用；不得为通过测试而放宽网络或文件隔离。

Claude 单轮正向 live gate（`RUN_CLAUDE_SESSION_RESUME_LIVE_SMOKE=1`，默认关闭）计划使用 test-only raw ACP harness：`session/new` 强制 `tools: []`、`maxTurns: 1`、`maxBudgetUsd: 1`，只发送一条固定无敏感 prompt；A 退出确认后由新 Runtime B 对同一 session ID 调用 `resumeSession`，B 不发送 prompt。凭据只使用既有 macOS Keychain `ROLECAST_CLAUDE_CREDENTIAL_REF`，且只在所有本地 sandbox/broker/路径门禁通过后读取；跨进程 live lock 必须在 Keychain、broker bind 与 Adapter spawn 前互斥。锁定的 `claude-agent-acp@0.90.0` → `claude-agent-sdk@0.3.296` → CLI 二进制中存在 ACP options / 环境转发及 `HTTPS_PROXY` 进入 Anthropic API fetch 的静态路径标记；这些 marker 只证明锁定产物包含该代码，不证明运行时实际采用代理或所有请求均经过代理，本会话没有运行真实 Adapter 验证运行时行为。**Live gate 仍为 BLOCKED，Batch 0 未完成且 `batch0Complete` 必须保持 false：macOS `sandbox-exec` 拒绝对固定公网地址的规则 `(remote ip "8.8.8.8:443")`（`host must be * or localhost`），因此目前无法把 Broker 出站限制到预解析的 API IP 集；不得退化为允许任意外网或 `*:443`。**零轮 no-prompt Claude 场景独立为 `RUN_CLAUDE_ZERO_TURN_DIAGNOSTIC=1` 负向边界。`maxBudgetUsd=1` 只是 SDK 估算阈值，不是账单硬上限；该 gate 不证明 Server 重启、上下文连续或 `resumeRun`/`retryRun`。Batch 1 离线 B-resume 未完成；Batch 2 锁/cleanup 尚未接入；固定 loopback `HTTPS_PROXY` 应由 ACP `_meta.claudeCode.options.env` 注入 SDK 子进程，Adapter 最小进程环境仍须排除继承代理，但该 live env 注入尚未实现。当前 readiness booleans 只是测试输入，未由实际门禁推导。阻断解除前不读 Keychain、不 bind broker、不 spawn Adapter、不发送 prompt。
