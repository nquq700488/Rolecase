# Credentials 模块

## 目标

安全保存、读取和注入 Provider 凭据，避免秘密进入配置、日志、DTO 和领域对象。

## 对外提供的能力

```text
save(idempotency_key, secret) → credential_ref
get(reference) → secret（仅 Adapter 启动短生命周期受控调用）
validate(reference) → boolean（不返回 Secret）
rotate(reference, secret) → void（引用不变）
delete(reference) → void
redact(value)
createScope(secret) → SecretRedactionScope（仅连接生命周期内持有 Secret）
```

公共凭据值校验（`isCredentialValueValid`）由 Fake、开发文件 Store 和 macOS Store 共用：非空、不超过 `MAX_CREDENTIAL_BYTES`，且不含 `CR`/`LF`。行分隔符会破坏按行传递 Secret 的写入协议，因此所有后端统一拒绝，保证 Contract 行为一致。

## 幂等创建

`save` 以**客户端生成的幂等键**而不是随机 UUID 确定引用：

```text
reference = 'credential-' + sha256('rolecast.credential.v1:' + idempotency_key)[0..32]
```

- 条目不存在时创建；已存在且 Secret 相同则返回既有引用（安全重试）；**已存在且 Secret 不同则抛 `CredentialIdempotencyConflictError`，绝不覆盖**——覆盖会让创建入口隐式具备轮换能力；
- 冲突错误携带既有 `credential_ref`（引用不是 Secret），Application 放进 409 错误信封的 `details`，页面据此提供「使用已保存的引用」，避免用户清除重试状态后再也无法找回该引用；
- 推导在 Infrastructure（`credential-reference.ts`）完成，Application 只传幂等键；
- 进程重启后同一幂等键仍落到同一引用，因此「写入已提交但响应丢失」的重试不会产生第二份凭据；
- 跨进程创建也是原子的：Keychain 用非覆盖式 `add` + 失败后重读比较，文件 Store 用逐条目的原子创建；并发同键异值时后到者得到 409，而不是静默覆盖。

## 存储策略

```text
macOS      → `security` CLI generic-password Keychain
Linux      → Secret Service / libsecret（后续）
Windows    → Credential Manager（后续）
开发降级   → 0600 本地目录，每个凭据一个条目文件

macOS Keychain 后端在同一 Rolecast 进程内（包括多个 Store 实例）用同引用锁串行化；**创建**在跨进程时也成立——`save` 使用不带 `-U` 的 `add-generic-password`，Keychain 对已存在条目返回重复项错误而不是覆盖，失败后重读并按 Secret 判定。只有 `rotate` 仍是跨进程非原子的读改写，属于已知限制。开发文件 Store 每个凭据一个 0600 条目文件：先写同目录临时文件，再用 `link` 的「仅创建」语义发布，其他进程不会读到半写入内容；没有共享索引，因此跨进程并发创建同一条目时也只有一个能成功，另一个读到既有值后按同值/异值处理。发布后的临时硬链接会立即删除，失败时返回可重试的不可用错误；`delete` 会同时回收崩溃遗留的临时链接，避免 Secret 以第二个名字残留。`get` 与 `validate` 共用同一内容校验，损坏条目一律 fail-closed。引用在文件后端同时是文件名，只接受 `credential-[A-Za-z0-9-]{1,64}` 形状，拒绝路径分隔符与 `..`。Runtime 只在 Adapter spawn 前读取 Secret，并通过固定的 Provider 环境变量名注入。

开发模式启动时会把旧版单文件 `credentials.json` 迁移为逐条目目录，保留既有引用，迁移成功后旧文件改名为 `credentials.json.migrated`。新目录由 `ROLECAST_CREDENTIALS_DIR` 指定（默认 `<runtimeRoot>/credentials`）；`ROLECAST_CREDENTIALS_PATH` 仍被读取，但只作为旧文件的迁移来源。新旧数据对同一引用给出不同 Secret 时启动失败并提示手动处理，不会静默丢弃任何一份。备份目标已存在时改用唯一备份名，不覆盖上一次迁移的备份。

`security add-generic-password ... -w` 在末尾进入提示模式，会从 stdin 连续请求两次相同的密码（输入 + 复核），因此 Runner 把输入写成两行相同值；Secret 只走 stdin，不进入 argv。注意该命令在两次输入不匹配时仍可能返回 0，所以行数必须正确，不能依赖退出码发现写入失败。

Keychain 错误分类以真实 exit code 为主（item-not-found、interaction-not-allowed、auth-failed），只在**非零且未识别**的退出码上按本地化文案兜底；明确的用户拒绝/交互禁止映射为 `credential_denied`，无法分类、超时或系统不可用仍映射为 `credentials_unavailable`。成功退出码的 stdout 就是 Secret 原文，绝不能用它做关键词匹配，否则合法 Secret 里出现「could not be found」等普通文本会被误判为 `credential_not_found`。
```

## 脱敏 scope

`SecretRedactionPort.createScope(secret)` 返回只在一次 Adapter 连接期间有效的 `SecretRedactionScope`：

```text
redact(value)                                     直接脱敏，不参与流窗口
redactValue(value)                                递归结构脱敏，不参与流窗口
redactStreamRecord(value, streamId, owner?)       按 Session 文本流脱敏，跨 chunk 匹配
flushStream(streamId) → 按路径的安全尾部            turn 正常结束，返回 { path, owner, text }[]
dropStream(streamId)                              取消 / 异常 / 关闭
close()                                           幂等释放 Secret 引用
```

scope 通过闭包持有 Secret 原文，只用于精确子串替换；不序列化、不写日志、不进入 Runtime Event。空 Secret fail-closed。按 `streamId + 字段路径` 维护「最长 Secret 前缀后缀窗口」：被窗口扣住的尾部一定是 Secret 的真前缀，因此单独出现时不构成完整 Secret；`dropStream` 直接丢弃，`close()` 幂等，释放后所有脱敏调用 fail-closed（整体替换为固定标记）。

**只有 `text` 字段参与跨 chunk 窗口**，其余字段（事件 kind、工具标题、状态等结构化字段）只做直接脱敏。窗口保护的是文本流；对结构化字段做窗口会在 flush 时截断它们自身的内容（实测 `tool_call_update` 会变成 `tool_call_upda`），属于数据损坏。

`flushStream` **按字段路径分别返回**尾部，并带上是哪个事件 kind 写入了该窗口（`owner`）：绝不把不同路径的尾部拼成一段文本（Secret 为重复串如 `abab` 时，两个字段各扣住 `ab`，拼接即可重组完整 Secret）。尾部跨越不同 owner 的 chunk 时 `owner` 为 `null`，表示无法证明唯一归属，调用方必须丢弃。

## Web 边界

Provider 页提供**一次性创建入口**：用户可提交 API key，经 `POST /api/credentials` 写入 CredentialStore，并得到不透明的 `credential_ref`。除此之外不提供 `get`、`list`、`rotate`、`delete` 入口——页面不能读取、回显或枚举已有 Secret。产品认证路线固定为 inherited 本地 CLI 或 isolated API key，不实现 OAuth、device-code 或交互终端登录。

`CredentialRefField` 的 Secret 生命周期：

- Secret 只存在于组件内存与 POST body；成功后立即清空输入，永不写入 Pinia、路由、URL、`localStorage` 或 `sessionStorage`；
- 失败时保留输入以便重试，错误文案不回显 Secret；
- 幂等键**不是秘密**，按表单实例短期存放在 `sessionStorage`（`rolecast.credential.pending:<scope>`），使页面刷新或导航后仍能用同一操作重试；成功或用户显式清除时删除；
- 关闭标签页会丢失该键，而服务端可能已完成写入——这是残余的孤儿条目风险，写入已知限制；本切片没有删除入口。

## 规则

- 上层只保存 credential_ref；
- Web 前端永远不能取得原始密钥；
- 日志脱敏 API Key、Token、Authorization；
- 不修改全局 Claude 或 CC Switch 配置；
- 凭据使用最短生命周期注入 Adapter；
- `credential_ref` 只配合 `isolated` 环境使用：`inherited` 连接携带引用会被拒绝（`credential_environment_mismatch`），避免 Secret 静默注入用户继承环境；
- isolated Runtime 不复制用户全局登录态文件，只通过新的 `credential_ref`（API key）建立凭据；不实现隔离环境内的登录或重新认证。

## 依赖

允许依赖：CredentialStorePort、SecretRedactionPort、系统 Secret Store SDK。

本模块实现 `CredentialStorePort` 和 `SecretRedactionPort`。

禁止依赖：Role、Orchestration、Vue、HTTP Controller。

## 错误

区分 `credential_not_found`、`credential_denied`、`credential_invalid`、`credential_idempotency_conflict` 和 `credentials_unavailable`。未知引用的 `get` 返回 null、`validate` 返回 false、`delete` 幂等成功；未知引用的 `rotate` 返回 `credential_not_found`。错误不得包含 Secret 原文。环境模式与引用不匹配时由 Runtime 抛出 `credential_environment_mismatch`，Application 映射为 422。创建用例把上述错误映射为 422 / 403 / 409 / 503，未知错误原样上抛；409 的 `details.credential_ref` 携带既有引用。

## 输入、输出和错误

输入是用户提供的 Provider 凭据；输出只有 credential_ref 或受控的短生命周期 Secret；错误必须区分不存在、拒绝、无效和存储不可用。

## 状态和不变量

凭据引用可以失效，但原始 Secret 不能进入 Domain、DTO 或日志；删除后不能继续注入。

## 持久化

由系统 Keychain 或开发降级存储负责；普通 JSON 和 SQLite 只保存引用。

## 事件

当前切片**不发布**凭据事件：创建入口只返回引用给调用方，不把引用扩散到事件流。`credential.created` / `credential.rotated` / `credential.deleted` 仅作为后续凭据管理能力的预留名称，实现时必须脱敏且不包含 Secret。

## 安全边界

只有受控的 Adapter 启动流程可读取 Secret；Web UI 和诊断包永远不能读取。scope 是 Secret 在内存中的唯一驻留形态，只在连接期间存在，连接失败、取消、异常和正常关闭都必须调用幂等 `close()`；Runtime Context 不保存 Secret 原文字段或可序列化 matcher。`close()` 只保证释放引用，不承诺 JavaScript 堆内存物理擦除。

## 替换和升级策略

存储后端可替换，只需保持 CredentialStorePort；迁移必须支持旧引用失效提示。

## 已知限制

不同 Provider 的认证字段仍由 Adapter 解释，Credentials 模块不保证 Provider 认证一定成功。

幂等只覆盖「同一幂等键 + 同一 Secret」的重试。用户更换 Secret 后会得到 409，可改用原 API key 重试，或直接采用服务端回传的既有引用；**显式清除只丢弃重试状态，不删除已保存的条目**，页面文案必须明确这一点。关闭标签页同样会丢失待确认键。凭据回收仍需要后续的 delete/rotate 入口。`rotate` 在跨进程下仍是读改写竞态，当前产品没有调用方。

ACP 的 `authenticate` API key metadata、gateway headers 与 Adapter-owned OAuth 都不能绕过本模块的 Secret 边界：这些值一旦进入 ACP JSON-RPC 或 Web 状态，就不再受 CredentialStore 控制。Phase 1C 只观察认证方法元数据，不把任何 Secret 写入 ACP 报文、DTO、事件、配置或 SQLite。登录流程不在产品范围，因此不存在认证结果与 `credential_ref` 的交接、保存或轮换。

## 测试

使用同一套 CredentialStore Contract Test 测试 Fake Store、开发文件 Store 和 macOS Keychain 适配器的保存、读取、validate、rotate、删除、空/超限/含行分隔符 Secret、未知引用、并发 mutation、拒绝分类、脱敏和失败恢复。幂等边界另需覆盖：同键同值重复与并发保存只产生一个引用；同键异值抛 `credential_idempotency_conflict`（携带既有引用）且不覆盖原值；非法幂等键被拒绝；Keychain 并发创建抢到同值/异值条目时的重读分支；创建失败且重读仍不存在时按原失败分类；模拟「写入成功但命令报错」时在本调用内重读并只出现一个 account；文件 Store 的逐条目发布、重复保存只留一个文件、拒绝目录穿越引用、损坏条目的 `get`/`validate` 一致 fail-closed；旧版单文件迁移覆盖条目保留、无旧文件、损坏旧文件、新旧冲突与重复迁移幂等。默认测试只使用 Fake Runner 和无凭据 Runner，不读取真实用户 Keychain；真实 Keychain 只通过显式设置 `RUN_MACOS_KEYCHAIN_INTEGRATION=1` 的集成 smoke 运行，使用合成 Secret 和唯一 service，失败输出不含 Secret，并在 finally 清理。测试同一进程内多个 Store 实例的串行锁，并明确跨进程 rotate 仍不是 CAS。Linux/Windows 后端只做后续平台集成测试。凭据注入到真实 Adapter 的链路由 `RUN_ACP_CREDENTIAL_SMOKE=1` 门控的 opt-in smoke 覆盖（见 [acp-runtime](acp-runtime.md)）。

`SecretRedactionScope` 单独测试：直接脱敏、跨 2/3 个 chunk 的 Secret、不同流互不干扰、`flushStream` 按路径返回安全尾部且不跨字段拼接、`dropStream` 丢弃、`close` 幂等且 fail-closed、空 Secret fail-closed、敏感字段按字段名脱敏。

## Web Phase 2/3 Secret 边界（目标态）

Artifact 内容只从已脱敏的任务输出/Coordinator 产物/受控用户文本构建，写入前再次调用 `SecretRedactionPort`；拒绝 Credential 字段、Keychain 原文与任意文件上传。脱敏失败即拒绝写入，错误/日志不含正文；合成 canary 扫描覆盖 SQLite、文件、API、事件与日志。当前 Artifact 尚未实现。
