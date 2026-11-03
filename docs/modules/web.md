# Web UI 模块

## 目标

提供纯浏览器的 Workspace、配置、Session、Task 和 Artifact 界面。

## 技术栈

| 类别 | 选型 |
| --- | --- |
| 框架 | Vue 3（Composition API，`<script setup lang="ts">`） |
| 构建 | Vite |
| 语言 | TypeScript |
| 样式 | UnoCSS（`presetWind3` + `presetAttributify` + `presetIcons`） |
| 组件库 | Naive UI |
| 路由 | Vue Router 4 |
| 状态 | Pinia |
| 契约校验 | Zod（来自 `packages/contract`） |
| 按需引入 | `unplugin-auto-import` + `unplugin-vue-components` + `NaiveUiResolver` |
| Markdown 渲染 | `markdown-it` + `shiki` |
| 虚拟滚动 | Naive UI `n-virtual-list` |
| 日期时间 | `dayjs` |
| HTTP | axios（统一封装 + 拦截器） |
| WebSocket | 原生 `WebSocket`（只有单一 `/api/ws`） |
| 类型检查 | `vue-tsc` |
| 单元 / 组件测试 | Vitest + `@vue/test-utils` |
| 浏览器手工验收 | 现有 Playwright MCP（本计划不新增 E2E runner） |

样式与主题注意事项：

- UnoCSS preflight 会重置基础样式并与 Naive UI 冲突，必须显式关闭或限定作用域；
- 暗色模式统一到同一个开关：Naive UI 走 `darkTheme`，UnoCSS 走 `dark:` 变体，不允许各写各的。

## Phase 1A 视觉与交互方向

界面采用“运行台（Run Console）”方向：深墨蓝工作区作为稳定背景，琥珀色只表示需要用户介入的权限节点，冰蓝表示实时 Agent 输出；不使用通用渐变 Hero 或均匀卡片网格。标题使用 `DM Sans`，正文和数据使用 `IBM Plex Sans`，等宽信息使用系统等宽字体。Chat 页面以左侧 Workspace/Session 导航、中央事件流、右侧 Runtime 状态轨为骨架；权限卡采用有刻度的时间轨而不是弹窗遮挡上下文。

1A 必须实现空态、加载、错误、断线、权限 pending/overdue/expired、键盘 focus 和 `prefers-reduced-motion` 状态。小屏幕下右侧状态轨折叠到 Chat 顶部，消息流不得产生横向溢出。

## 页面能力

这些视觉约束只属于 Web UI，不改变 Contract 或 Domain 语义。

```text
工作区选择 → Provider 连接 → Role / RoleBinding 配置 → Session 运行台
```

```text
WorkspaceSelector
ProviderSettings
ModelCatalog
RoleEditor
RoleBindingEditor
SessionList
SessionRoom
AgentSlotPanel
TaskBoard
ArtifactPanel
RunTimeline
PermissionDialog
PermissionHistory
ProviderConfigImport
```

## AgentSlot 定向对话（Phase 2 初始切片）

SessionPage 在输入框上方显示 `发送给` Slot selector，并允许从当前 Workspace 的 enabled/selectable/dispatchable RoleBinding 中添加一个 AgentSlot。Selector 默认原始的未绑定 Slot；其他 Slot 的 label 显示 Role 名和其 Slot 固定 model。非空 `runtime_options` 的 Binding 暂不提供，页面明确说明限制。

发送请求携带 `agent_slot_id`，该 ID 同时参与消息幂等键身份；目标 Slot 改变时必须使用新 request_id。API 允许旧客户端省略目标，服务端仍选择原始 Slot。创建 Slot 时 Store 为同一 Session + RoleBinding 的未决请求复用业务 `request_id`；成功后清除待处理键，失败后刷新快照对账并保留 key 供安全重试。用户后续有意再次添加同一 RoleBinding 会取得新的 key。

非默认 Slot 提供“移除”操作，需二次确认；活动 Run 由服务端拒绝，成功后刷新快照并在删除当前目标时回落到默认 Slot。软删除保留历史任务与 Role snapshot；Runtime attachment 关闭确认前作为私有 cleanup record 保留。需要全新上下文时，删除 Slot 后使用原 RoleBinding 新建一个 Slot（Slot ID 会改变）；同 ID 的 reset-context 接口未实现。用户输入和消息历史只显示原文，不拼入 Role Context；Role instructions 由通用 Runtime ContextBundle 处理。

## Run 恢复操作（Phase 1F）

SessionPage 按 Run 状态显示取消 / Resume / Retry。Resume 与 Retry 在 dispatch 前必须二次确认并提示「外部副作用可能重复发生」；取消不需要确认。操作进行中禁用重复点击，成功或冲突后刷新 snapshot 与 WS 游标。WS `resume` 逻辑保持不变，只用于事件续传。

Session 消息与 Run 命令的 body `request_id` 是操作级幂等键，不是每个 HTTP 请求独立生成的 `X-Request-Id`。Store 在当前页面运行期间为同一 Session + 消息内容 + AgentSlot 目标、或同一 Run + 命令保留待处理键：失败后重试复用原键，成功后清除；新内容、Slot、命令或 Run 使用新键。服务端返回 `command_outcome_ambiguous` 时不以旧键重派；相同消息/Slot 使用新键前须明确确认可能重复外部副作用，Resume / Retry 沿用其既有确认。命令键仅保留在 Pinia 内存，不写入浏览器持久化存储；刷新页面后不会恢复待处理键。

## 分层

```text
Vue Component（pages / components）
   ↓
Pinia Store / Composable
   ↓
Typed ApiClient（网络层封装 + Zod 校验）
   ↓
packages/contract
```

组件不得直接拼 URL、访问数据库或启动子进程。

## 网络层

业务代码**禁止**直接调用 `axios`、`fetch` 或 `WebSocket`，一律经封装层。

```text
apps/web/src/api/
├── httpClient.ts       axios 实例 + 拦截器
├── wsClient.ts         WebSocket 连接管理
├── errors.ts           ApiError 类型与归一化
├── endpoints/          按模块分组的类型化 API
│   ├── workspaces.ts
│   ├── providers.ts
│   ├── roles.ts
│   ├── sessions.ts
│   └── runs.ts
└── index.ts
```

### httpClient

基于 axios 实例，集中处理：

- **请求拦截**：注入 `Authorization: Bearer <Local Token>`；未指定时生成 `X-Request-Id`；
- **响应拦截**：解包 `{ ok: true, data }`；`{ ok: false, error }` 转成 `ApiError` 抛出；
- **错误归一化**：超时、网络错误、HTTP 状态码、业务错误码统一成 `ApiError { code, message, details, requestId }`；
- **重试**：按 wire 约定实现（读操作指数退避、写操作默认不重试），调用点不自行循环；
- **脱敏日志**：不打印 Local Token、Authorization、API Key。

Local Token 在 Server 侧默认只存进程内存；Web 侧在读取 URL fragment 后立即清除 hash，并存入 `sessionStorage`，不写 `localStorage`。SQLite 不保存 Token 原文。

### wsClient

- 连接 `/api/ws` 后立即发送首帧 `{ type: 'auth', token, workspace_id }`；原生 WebSocket 不使用 query string Token，服务端在认证前不发送业务事件，并以 Workspace ID 限制 replay 订阅；
- 断线指数退避重连；
- 按事件 `type` 分发到订阅者；
- 记录每个 Run 的最后 `sequence`，重连后按 wire 约定续传；
- **重连后必须重新拉取 Run / Task / Session 快照**，不能只依赖补发事件；
- 心跳检测，超时判定为断线。

### 边界校验

Zod Schema 校验放在 `endpoints/` 层，不放在拦截器——拦截器不知道具体接口的 Schema。校验失败按 `invalid_response` 处理，不把未校验数据传进 Store。

### Provider 环境配置交互

Provider 页（`ProviderPage.vue`）围绕「Provider 环境配置与凭据引用」设计，并通过 `CredentialRefField.vue` 提供最小的一次性 API key 创建入口：

- 表单的非秘密字段是 `provider_kind`、`connection_kind`、`environment_mode` 与 `base_url`；`credential_ref` 是不透明引用 ID，不是 Secret。
- `CredentialRefField` 在创建连接、编辑连接和 Codex 导入三处复用：引用文本框 + API key 密码框 + 「保存到 Keychain 并生成引用」。API key 只在提交时读取，成功后立即清空并把引用回填到表单；失败保留输入但错误文案不回显 Secret。
- 幂等键不是秘密，按表单实例短期存于 `sessionStorage`，使刷新或导航后仍能重试同一操作；成功或显式清除时删除。Secret 不写入 Pinia、路由、URL 或任何 storage。
- 同一幂等键 + 同一 Secret 的重试返回同一引用；同键不同 Secret 收到 409 时提示使用原 API key 重试，并提供「使用已保存的引用」直接采用服务端回传的 `credential_ref`。文案明确「清除待确认」只丢弃重试状态，不会删除已保存的凭据。
- 该请求单独使用 30s 客户端超时：macOS Keychain 命令最坏 15s，默认 10s 会把正常写入打断。
- `credential_ref` 只显示「引用已设置，待连接验证」，不回显原值含义，也不据此推断认证成功。
- 状态由 `provider-readiness.ts` 单点推导，与后端组合判定同源：`ready` / `needs_configuration` / `needs_import` / `unverified`。非 `ready` 时禁用「测试连接并发现模型」与「开启 Session」。
- 结构性拒绝（inherited + `credential_ref`、local + `credential_ref`、custom_endpoint 缺 `base_url`）在 Provider 分支之前判定，旧 DTO 里的这些组合不会被显示为 ready。
- 切换连接时清空模型目录与选中模型；模型响应只在仍属于当前连接时采用，迟到的旧响应被丢弃，加载失败会清空并显示错误。
- `base_url` 仅在 `connection_kind=custom_endpoint` 时提交，切换类型会清除隐藏值；凭据引用状态从当前连接派生，不跨连接沿用。
- Codex 只要带 `base_url`（含历史 `api_key + base_url`）就显示「认证未验证」，不提供运行入口。
- Codex isolated 只能通过配置导入建立：页面提供受控**服务器路径**文本输入 → 脱敏 preview → 用户确认 apply；不实现浏览器文件选择或 file bridge。apply 成功后旧模型目录与选中模型被清空，必须重新发现模型后才能开启 Session——导入会改变连接的运行配置，旧目录不可信。模型请求用单调 generation 作废：apply 时递增，响应提交前同时校验连接与 generation，apply 之前发出、之后才返回的请求不会恢复旧目录。
- 导入入口对 inherited Codex 的 `local` / `api_key` 也显示——既定流程就是先建 inherited 再 apply 转 isolated，只在 `needs_import` 时显示会让用户无路可走。待导入与待配置状态都保留入口作为恢复路径；Codex custom endpoint（含任何带 `base_url` 的连接）只显示「认证未验证」只读状态，不给可操作入口。
- 失败按 `ApiClientError.code` 展示文案，并保留表单选择，不静默切回 inherited。
- 「编辑连接」只提交 `connection_kind` / `environment_mode` / 非秘密 `base_url` / 既有 `credential_ref`（以及用于清除遗留值的 `codex_config: null`）与 `config_revision`。目标组合仍需要引用且输入留空时**省略** `credential_ref`（保留已有引用）；只有目标为 inherited 或 local 时才显式发 `null`。`base_url` 同理：非 custom_endpoint 发 `null`。当前不提供「清除引用但仍保持 isolated 可运行」的动作，页面提示必须输入新引用或切换到不使用引用的组合。更新成功后调用 `invalidateModels`：清空模型目录、选中模型并使在途请求失效；必须重新发现模型才能开启 Session。
- 凭据相关错误提供可执行恢复文案（重新绑定引用 / 走配置导入），页面仍不显示引用原值。
- Provider 页创建 Session 默认仍使用当前 Provider/model；切换到 RoleBinding 模式后才惰性加载当前 Workspace 的 Role 与 Binding。候选仅包含同 Workspace、已启用、`runtime_options` 为空，且关联 Role 同时 `selectable`、`dispatchable` 的 Binding。候选标签显示 Role 名及 Binding 自己的 Provider/model，并明确不会沿用表单当前选择；请求体仅含 `name` 与 `role_binding_id`。空态或加载失败不阻断 Provider/model 创建路径；Workspace 切换会清空旧选择，丢弃迟到的旧 Workspace 响应。

### Workspace Session 列表

Provider 页在配置表单下方列出当前 Workspace 的 Session：保留 API 顺序，显示名称、生命周期状态与更新时间，并链接到既有 `/sessions/:sessionId` Room。组件覆盖加载、空结果、请求失败与重试；空态提供跳转到 Provider 配置表单的入口。Workspace 路由参数变化时清空旧列表并重新读取，忽略旧请求迟到响应及卸载后的结果。列表只执行现有 Session 查询，不创建 Session、Task、Slot、Run，也不触发 Runtime。

### 权限与配置导入交互

- PermissionDialog 只渲染 Adapter 返回的选项，不自行生成跨 Provider 的 allow/deny 映射；
- 请求待处理时显示倒计时和来源，5 分钟后提升提醒但不自动选择；
- 收到 `agent.permission_expired` 后显示「已过期」，禁用回答按钮并提供查看现场、继续或重试入口；
- ProviderConfigImport 必须先展示脱敏 preview，再由用户明确确认 apply；任何 API Key、OAuth 文件和原始 TOML 都不能进入 Store 或页面状态；
- 页面刷新或 WS 重连后从快照恢复权限状态，不依赖前端定时器作最终裁决。

## 依赖

允许依赖：Vue 3、Vue Router、Pinia、Naive UI、UnoCSS、axios、Zod、`packages/contract`、PlatformHost。

禁止依赖：`@tauri-apps/*`、Electron IPC、SQLite、ACP SDK、Node 文件系统、装饰器 DI 框架。

## 必须支持

- 流式事件；
- 重连后状态对账；
- Agent、Task、Run 状态；
- 权限请求；
- 取消、暂停和恢复；
- API Key 脱敏状态；
- 键盘操作和错误反馈；Role 编辑器必须覆盖加载、空态、保存、删除、version 冲突和 Binding 引用冲突。

## 禁止

- 导入 `@tauri-apps/*`；
- 使用 Electron IPC；
- 保存原始 API Key；
- 假设某个 Provider 一定支持某个选项；
- 用固定时间等待异步完成；
- 在组件里直接拼后端路径字符串，必须经 Typed ApiClient。

## PlatformHost

文件选择、通知、打开外部链接等平台能力必须通过 PlatformHost。第一阶段使用 Web API，后续 Tauri 只增加实现。

## 输入、输出和错误

输入是用户操作和 Event Envelope；输出是 ApiClient Command、视图状态和明确的错误反馈。

## 状态和不变量

视图状态可以从 API 快照和事件重建；重连后不能只依赖本地缓存；组件不直接修改领域对象。

## 持久化

不保存 API Key；必要的 UI 偏好使用浏览器安全存储，Session 数据由 Server 保存。

## 事件

订阅并对账 session、run、task、artifact、permission 事件；断线后重新获取快照。

## 安全边界

不执行本地命令，不读取原始凭据，不访问其他 Workspace；所有写操作经 Local Token 保护的 API。

## 替换和升级策略

页面组件可替换，只要保持 Typed ApiClient 和 Contract；PlatformHost 通过接口替换。

## 已知限制

第一阶段浏览器能力受 File System Access API 支持情况限制；不做国际化，界面文案为中文单语言。

## 测试

- 单元 / 组件：Vitest + `@vue/test-utils`，覆盖 Store、Composable、ApiClient 封装和数据转换；
- 类型：`vue-tsc` 类型检查；
- 浏览器手工验收（本计划局部例外）：沿用仓库现有 Vitest 自动化；使用现有 Playwright MCP 手动执行主流程、关键状态与键盘路径，并覆盖 320/375/768/1024/1440/1920 六个 viewport 截图。不新增 `@playwright/test`、`test:e2e` 或浏览器下载。
- 视觉：关键页面在明暗两种主题下各截图一次；
- Provider 页：`ProviderPage.test.ts`（happy-dom）覆盖非秘密 payload、引用不回显、loading、ready、needs_configuration、unverified、credential 错误、预览/应用流程、创建/编辑/导入三处生成引用，以及配置导入入口的可见性（inherited Codex 显示、Claude 隐藏、custom endpoint 只读）；320/768 需在真实浏览器核对，happy-dom 不作为视觉证据。
- `CredentialRefField.test.ts` 覆盖：只发送幂等键与 Secret、成功清空 Secret 并回填引用、失败保留输入并复用同一键、改 Secret 后仍复用同一键、409 冲突提示、刷新后从 sessionStorage 恢复待确认键、显式清除与禁用态。

## Phase 2 handoff 交接 UI

SessionPage 在已完成 Run 上提供目标 Slot 选择与「交接」按钮；成功后切换到接收 Slot 并刷新 snapshot。`kind='handoff'` 的 Message 只在 `to_slot_id` 匹配的 Slot 视图显示来源→目标与「填入草稿」；填入草稿只写 textarea，不调用发送或 Runtime。

## Web Phase 2/3 目标入口（未实现）

目标态：Workspace 新建要求本地服务端目录文本输入（无文件选择器），旧 Workspace 显示未配置与一次性补设；TaskBoard、Inbox（unread/read）、Artifact 列表与预览、Workflow/Coordinator 控制、reset 确认与 generation 提示。保留现有视觉语言，不做整体重做；Artifact 文件写入未开放时显示不可用原因。
