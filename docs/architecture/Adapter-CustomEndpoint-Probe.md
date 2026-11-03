# Adapter Custom Endpoint Contract Probe（Batch 0）

> 适用版本：`claude-agent-acp@0.90.0`、`codex-acp@2.2.2`（lockfile 锁定）。
> 目的：为 Provider「custom endpoint」组合提供实测依据，避免把未验证组合声明为支持。

## 方法与硬门槛

- **默认跳过**：Probe 只在 `RUN_PROVIDER_ADAPTER_PROBE=1` 时运行，代码位于
  `tests/contract/src/provider-adapter-probe/`。
- **出口隔离由断言证明，不靠「没连上」推断**：所有 Adapter 进程通过 macOS
  `sandbox-exec` 启动，profile 为「默认允许、`deny network*`、只放行 loopback」。
  断言包含：loopback 连接结果为 `OK` 且子进程退出码 0；`192.0.2.1:80` 的错误码
  必须是 `EPERM`（sandbox 拒绝），**超时 / 不可达不计为隔离生效**；Adapter 指向
  非 loopback endpoint 时 mock 命中数为 0。
- **代理通道单独处理，不混入 sandbox 结论**：sandbox 放行 loopback，因此
  「loopback 代理 → 非 loopback」是它拦不住的通道。测试用显式 CONNECT 客户端
  连一个本地转发代理，断言代理**确实收到** `CONNECT 192.0.2.1:80`（证明通道真实
  存在），再断言 `buildProbeEnvironment` 的结果里没有任何代理变量（证明 Adapter
  拿不到这个通道）。注意：不能靠给 `net.connect` 设代理变量来验证——该 API 根本
  不读代理变量；本 Node 版本的 `http.Agent({ proxy: true })` 同样不读，会把
  「直连超时」误判为转发成功。
- **最小 allowlist 环境**：Adapter 子进程不继承 `process.env`，只保留
  `PATH`/`TMPDIR`/`LANG`/`LC_*`/`TERM`，`HOME` 指向该 case 的临时目录；认证类键
  （`ANTHROPIC_*`、`OPENAI_*`、`CLAUDE_*`、`CODEX_*`、`*_API_KEY`、`*_AUTH_TOKEN`、
  `*_OAUTH*` 等，含大小写变体）与代理键一律不注入，只放本用例的合成值。运行期
  还会断言 allowlist 结果中不含任何敏感键名。
  > 这条守卫有实测意义：开发机 shell 里存在 `ANTHROPIC_AUTH_TOKEN` 时，早期版本
  > 把它继承给 Adapter，Claude 请求的认证头来源会从 `x-api-key` 变成
  > `authorization`，即 Probe 实际用了开发者真实凭据。
- **只观测非敏感元数据**：记录 HTTP method、**pathname**（剥离 query）、`Host`、
  请求头**名称**与认证来源类别；不记录 header 取值、query、body、Secret 或真实
  配置路径。有专门用例注入 `?api_key=synthetic-query-secret` 并断言记录中不含该值。
- **合成凭据**：`synthetic-<uuid>`，每个 case 独立 0700 临时目录，结束即删除；
  不触碰用户真实凭据和真实 Provider endpoint。
- **资源回收可观察**：目录创建后的全部 setup 都在 `try/finally` 内。清理走
  `ensureAdapterExited`：`close()` 与随后的退出确认**各自有界**（close 永不 settle
  时超时后强制 SIGKILL，再在上限内确认退出）；只有确认退出后才删除目录。若进程
  未确认退出，**保留目录并在失败信息里给出路径**用于诊断，绝不提示「检查已删除的
  目录」，也不让 Probe 表面通过。该辅助函数有独立单元测试覆盖 close 失败、close
  永不 settle、进程不退出、close 与 kill 双失败；并用忽略 SIGTERM 的真实进程验证过
  强制回收。
- **子进程输出解析**：sandbox sentinel 在 stdout `close` 之后才解析输出并核对退出码，
  避免 stdio 数据在 `exit` 之后到达造成的偶发误判。

## 实测结果

每次都断言 `connectOk = true`、`sessionOk = true`、命中数 > 0，且至少出现预期业务请求
（Claude `POST /v1/messages`、Codex `POST /responses`）；空请求或握手失败会直接失败。
业务请求的**认证来源也锁定为断言**：Claude 必须是 `x-api-key`，Codex 必须是 `none`。
Adapter 行为一旦变化，测试会失败并迫使重新评审支持结论，而不是静默改变。

| Provider | environment | 命中 method/path | 业务命中 | 认证来源 | 结论 |
|---|---|---|---|---|---|
| Claude | isolated | `HEAD /api/hello`、`POST /v1/messages` | 4 | `x-api-key` | `ANTHROPIC_BASE_URL` 生效 |
| Claude | inherited | 同上 | 4 | `x-api-key` | `ANTHROPIC_BASE_URL` 生效，认证来自合成继承环境 |
| Codex | isolated | `POST /responses` | 6 | **无认证头** | `CODEX_HOME/config.toml` 的 `base_url` 生效 |
| Codex | inherited | `POST /responses` | 6 | **无认证头** | 仅改临时 `CODEX_HOME` 的 config，不影响用户目录 |

所有 `Host` 都等于 mock 的 `127.0.0.1:<port>`，无非 loopback 命中。Codex 的
`turnSettled = true`（mock 返回 200、Adapter 认为轮次正常结束）；Claude 的
`turnSettled = false` 且 `errorKind = AcpRemoteError`，因为 mock 的响应体不满足其
消息格式，这只影响 turn 结果、不影响「是否命中 endpoint」的结论。

## 关键结论

1. **Claude custom endpoint 走 `ANTHROPIC_BASE_URL`**，isolated 与 inherited 都生效；
   在最小 allowlist 环境下，认证来源是 `x-api-key`（来自注入的合成 `ANTHROPIC_API_KEY`）。
2. **Codex 不读取 `OPENAI_BASE_URL`**（Adapter 内不存在该变量），只认
   `CODEX_HOME/config.toml` 的 `[model_providers.<id>] base_url`。Batch A 必须沿用
   现有 config 物化路径，不能新增环境变量假设。
3. **Codex 的认证头没有出现在配置声明的 `base_url` 请求上**。也就是说：把 Codex
   指向 custom endpoint 时，`OPENAI_API_KEY` 并未被附加为 `Authorization`/
   `x-api-key`。这解释了为什么这部分组合此前被认为「不可靠」。
4. **Claude custom endpoint 的 `HEAD /api/hello` 是 Adapter 自身的连通性探测**
   （`authSource=none`，无认证头），不属于业务请求，评估 URL 生效时应以
   `POST /v1/messages` 为准。

## 对 Batch A 的约束

- Claude `custom_endpoint`（inherited / isolated）**可以开放**，实现方式为
  `ANTHROPIC_BASE_URL`。
- Codex `custom_endpoint` 的 **endpoint 覆盖可以开放**（config.toml 已证明生效），
  但**认证是否随 custom endpoint 一起生效未获证明**。在补到认证侧证据之前，
  该组合必须保持「测试连接可发现 endpoint，但认证状态不得声明 ready」。
- 不得为了「让组合通过」而新增未经验证的环境变量或猜测 Adapter 语义。

## 未覆盖 / 限制

- 只在 macOS + `sandbox-exec` 上验证；其他平台需要等价的 OS 级出口隔离才能复用结论。
- 只验证到 ACP `initialize` / `session/new` / 一次最小 `session/prompt`，不代表
  完整对话、流式或多轮行为。
- 没有真实 Provider 认证：合成凭据被 mock 接受，因此**只证明 URL 与头部形状**，
  不证明真实认证成功。
- Codex 认证头缺失的具体原因（是否需要 `env_key` / provider 声明）未在本次 Probe
  中追查，属于 Batch A 的待证项。
- 出口隔离的 sandbox 断言针对**直连**；代理通道的安全依赖「子进程环境不含代理
  变量」，已有回归用例，但如果 Adapter 未来自行读取其他代理机制（如 PAC、系统
  代理设置）或 DNS 侧行为，本 Probe 不覆盖。
