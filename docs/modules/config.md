# Config 模块

## 目标

解析内置、用户、Workspace 和 Session Override 配置，并生成带来源信息的运行时配置。

## 配置层级

```text
内置默认
  < ~/.rolecast/config.json
    < <workspace>/.rolecast/config.json
      < Session Override
```

## 对外提供的能力

```text
loadDefaults()
loadUserConfig()
loadWorkspaceConfig(workspaceRoot)
resolveConfig(layers)
validateConfig(config)
migrateConfig(config, fromVersion)
explainSource(path)
```

## 规则

- 配置文件由用户管理，程序不得无提示重写；
- API Key 只保存 credential_ref；
- 每个字段报告来源；
- 配置必须有版本号；
- 高层覆盖低层必须可解释；
- `ProviderConnection.environment_mode` 默认 `inherited`，改为 `isolated` 时必须显式记录来源和配置完整性；
- 外部配置导入采用 preview → 用户确认 → apply，不能把导入文件原文或凭据写入 Rolecast 配置。
- Role / RoleBinding 是 Workspace 配置，默认保存于受控 runtime root 下的 JSON 文件；配置文件包含 `schema_version` 和单调 `version`。
- Role / Binding 的创建、更新、删除必须经 Workspace 级异步串行 mutation，在同一临界区完成读取、引用检查、CAS 版本比较和原子写入；不允许以独立的 count-then-write 绕过该边界。
- 配置路径使用 Workspace ID 的固定 SHA-256 hash 目录键，不直接拼接外部输入；打开文件前检查 realpath 和符号链接，未知 schema 版本或迁移失败必须 fail-closed。

Codex 配置导入只允许从受控 Codex Home（`CODEX_HOME` 或 `~/.codex`）读取 `config.toml` 并生成非秘密字段草稿。受控根目录必须由当前用户拥有且不可被其他用户写入。导入的 `base_url`、网关类型、模型目录和推理默认值进入 ProviderConnection 的 `codex_config`；API Key 仍由 `credential_ref` 指向 CredentialStore，登录态不得复制，isolated 只接受 API key；Runtime 只在 Adapter spawn 边界通过 CredentialStore 注入 Secret，isolated Codex 会过滤继承认证环境变量；真实 Keychain 注入已经由 Infrastructure 实现，Linux/Windows 后端另行实现。preview 绑定 Workspace、Provider、源文件摘要和 `config_revision`，apply 必须显式确认并通过 SQLite 条件更新；导入失败、摘要变化、目标连接冲突或字段缺失必须报告结构化错误，不得静默回退到全局环境。源文件路径拒绝符号链接和危险 URL，错误不回显原文。

## 依赖

允许依赖：contract Schema、文件读取 Port。

禁止依赖：ACP、进程管理、编排、Keychain 实现、HTTP。

## 错误

配置格式错误、版本过旧、路径非法、引用缺失都必须返回结构化错误，不能静默使用默认值。

## 输入、输出和错误

输入是配置层和文件来源；输出是带来源信息的 ResolvedConfig；错误包括格式、版本、路径和引用错误。

## 状态和不变量

配置加载是纯函数；解析不能修改用户文件；同一字段的来源和覆盖顺序必须可解释。

## 持久化

只负责 JSON 配置文件；SQLite 运行状态由 Persistence 模块管理。

## 事件

配置创建、迁移和加载失败可以生成诊断事件，但不发布 Agent 运行事件。

## 安全边界

禁止把 API Key 写入 JSON；路径必须限制在允许的配置目录；配置错误不能执行任意命令。

## 替换和升级策略

配置 Schema 必须有 migration version；迁移前备份，失败时保留原文件。

## 已知限制

高层覆盖低层的策略暂不支持任意字段级合并规则，复杂合并需另建明确 Schema。

## 测试

覆盖层级合并、覆盖优先级、来源解释、迁移、非法路径和敏感字段过滤。
