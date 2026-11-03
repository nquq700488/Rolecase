# CCB 配置说明

> CCB（Collaborative Code Bridge）是一个多 AI Agent CLI 协作平台，基于 tmux 终端多路复用器。
> 当前速查按 nquq700488/claude_code_bridge 远程 README v8.0.19、本机 `ccb --help` 和安装指南核对更新。
> 源码与完整说明见 [nquq700488/claude_code_bridge](https://github.com/nquq700488/claude_code_bridge)。
> 详细安装说明见 [CCB_INSTALL_GUIDE.md](https://github.com/nquq700488/claude_code_bridge/blob/main/CCB_INSTALL_GUIDE.md)。

---

## 安装与更新

当前 fork 不提供 npm 包；不要用 upstream npm 包安装本 fork。推荐使用源码安装：

```bash
git clone https://github.com/nquq700488/claude_code_bridge.git
cd claude_code_bridge
./install.sh install
```

如果远程发布了匹配平台的 release 包，也可以下载并解压后安装：

```bash
# release 包：下载并解压匹配平台的 ccb-*.tar.gz 后
cd ccb-*
./install.sh install
```

源码安装后的更新方式：

```bash
cd /path/to/claude_code_bridge
git pull
./install.sh install
```

基础依赖：

- Python 3.10+
- tmux
- git
- bash 3.2+
- curl（推荐）

安装后验证：

```bash
command -v ccb
ccb --help
ccb version
```

---

## 本项目 Agent 团队

当前项目使用 CCB 配置档案路由器：`.ccb/ccb.config` 只负责选择 profile，实际布局分别放在 `.ccb/ccb-compact.config` 和 `.ccb/ccb-multi.config`。

```toml
# .ccb/ccb.config
config_profile = "compact"
```

切换模式：修改 `config_profile` 后运行 `ccb reload`。

| Profile | 配置文件 | 模式 | 说明 |
|---------|----------|------|------|
| `compact` | `.ccb/ccb-compact.config` | 紧凑单窗口 | 用一行 compact 布局声明团队，适合日常使用 |
| `multi` | `.ccb/ccb-multi.config` | v2 多窗口 | 两个 tmux 窗口，适合多角色并行观察 |

当前 compact / multi profile 均配置以下 Agent；`inspiration` 当前未启用：

| Agent | Provider | 角色 |
|-------|----------|------|
| `planner` | Codex | Planner（方案设计） |
| `developer` | Claude | Developer（编码实现） |
| `reviewer` | Codex | 方案审查 + 代码审查 |
| `tester` | Claude | 测试验证 |

详细角色映射见 `.agents/agent-registry.md`，provider / model 配置见 `.ccb/ccb-compact.config` 或 `.ccb/ccb-multi.config`，协作流程见 `.agents/collaboration.md`。

---

## 本项目配置模式

本项目采用三文件 profile 模式，不把 agent/provider 直接写在 `.ccb/ccb.config`：

1. `.ccb/ccb.config` 只保存当前 profile，例如 `config_profile = "compact"`。
2. `compact` 时读取 `.ccb/ccb-compact.config`。
3. `multi` 时读取 `.ccb/ccb-multi.config`。
4. 切换 profile 后运行 `ccb reload`。
5. 配置变更后运行 `ccb config validate` 校验。

当前路由器：

```toml
# .ccb/ccb.config
config_profile = "compact"  # compact / multi
```

```toml
# .ccb/ccb-compact.config
(planner:codex; developer:claude), (reviewer:codex; tester:claude)

[agents.planner]
description = "方案设计"

[agents.developer]
description = "核心开发"

[agents.reviewer]
description = "代码审查"

[agents.tester]
description = "测试验证"
```

多窗口 profile 使用 v2 `[windows]` 拓扑。当前项目把 agent 分到 `main` / `work` 两个 tmux 窗口，window 内的 agent 排布由 `,` 和 `;` 控制上下堆叠和左右分栏；所有 agent leaf 必须声明 provider。

```toml
# .ccb/ccb-multi.config
version = 2
entry_window = "main"

[windows]
main = "planner:codex; developer:claude"
work = "reviewer:codex; tester:claude"

[ui.sidebar]
mode = "every_window"
width = "15%"
bottom_height = 20

[ui.sidebar.view]
agents_height = "50%"
comms_height = "15%"
tips_height = "35%"
comms_limit = 5
```

切换示例：

```bash
# 切到多窗口
perl -0pi -e 's/config_profile = "compact"/config_profile = "multi"/' .ccb/ccb.config
ccb reload

# 切回紧凑单窗口
perl -0pi -e 's/config_profile = "multi"/config_profile = "compact"/' .ccb/ccb.config
ccb reload
```

配置校验和启动：

```bash
ccb config validate  # 校验当前 profile 解析后的配置
ccb
```

compact profile 使用一行布局，loader 会规范化为 project config：

```text
(planner:codex; developer:claude), (reviewer:codex; tester:claude)
```

语法要点：

- `agent:provider`：Agent 名和 AI CLI provider
- `cmd`：shell 终端面板
- `;`：左右分屏
- `,`：上下堆叠
- `(worktree)`：为该 Agent 使用独立 git worktree
- `(N)`：权重比例
- `@N`：绝对百分比（如 `@50`）

配置形态：

- **compact**：一行布局，适合快速接入。
- **rich TOML**：完整 `version = 2` 配置，适合多窗口、sidebar、maintenance、tool window。
- **hybrid**：compact header + TOML overlay，只允许补充 `agents` 和 `maintenance`。

---

## v8 核心特性

- **Agent Sidebar**：每个 tmux 窗口左侧原生 TUI，显示 Agent 状态并支持点击切换焦点
- **多窗口拓扑**：一个项目可配置多个 tmux 窗口，每个窗口有独立布局和 Sidebar
- **Dynamic Reload**：编辑 `ccb.config` 后可通过 `ccb reload` 动态应用支持的配置变更
- **Agent Roles Store**：通过 `ccb roles ...` 安装、刷新、绑定角色资产
- **Artifact Transport**：大消息自动或手动溢写到 text artifact
- **Provider Activity 追踪**：通过 provider-native hook 识别 active / pending / idle / failed 状态
- **Job Heartbeat**：项目级任务心跳超时检测，可在 `[maintenance.heartbeat]` 中配置
- **Rich Workbench**：`ccb update rich` 安装 / 更新，`ccb rich` 启动富媒体终端工作台
- **Mobile App**：`ccb update mobile` 安装 / 更新 Android 远程控制组件；`ccb install mobile` 启动 server-wide gateway 和配对入口
- **Dynamic Agent**：`ccb agent add/remove/park/resume/release` 支持运行时动态增减或暂停 agent
- **Loop Runtime**：`ccb loop ...` 管理运行时 workflow graph 和 loop worker round

---

## 多模型协作命令速查

> 详细协作规则、不可用处理和调用示例见 [`.agents/collaboration.md`](../.agents/collaboration.md)。

| 协作场景 | 命令 | 说明 |
|---------|------|------|
| 首次向 Agent 发任务 | `ccb ask <agent>` | 提交异步任务，记录返回的 `job_id` |
| 发任务后等待结果 | `ccb watch <job_id>` | 轮询 job 直到终态或超时 |
| 兼容观察模式 | `ccb pend --watch <job_id>` | 旧观察入口，优先传 `job_id` |
| 精简回复 | `ccb ask --compact <agent>` | 请求目标 Agent 输出精简回复 |
| 链式委派 | `ccb ask --chain <agent>` | 活跃 CCB 任务内需要子任务结果才能继续时使用 |
| 链式委派兼容别名 | `ccb ask --callback <agent>` | `--chain` 的旧别名仍可用 |
| 只需完成通知 | `ccb ask --notify-sender <agent>` | 完成后向 sender inbox 发系统 notice |
| 静默发送 | `ccb ask --silence <agent>` | 用户明确说不用等回复时使用 |
| 大消息 artifact | `ccb ask --artifact-io <agent>` | 请求和回复都使用 text artifact |
| 等全部完成 | `ccb wait-all <target>` | 等待 target 全部结果 |
| 等任意完成 | `ccb wait-any <target>` | 等待 target 任意结果 |
| 等 N 个结果 | `ccb wait-quorum <N> <target>` | 等待多数结果 |
| 检查 Agent 是否在线 | `ccb ping <agent>` | 注入前判断可用性 |
| 查看收件箱 | `ccb inbox --detail <agent>` | 查看通知和系统消息 |
| 查看队列 | `ccb queue --detail <agent\|all>` | 查看 backlog 状态 |
| 追踪链路 | `ccb trace <id>` | 从 job/message/reply 等 id 重建 lineage |
| 确认收件箱 head | `ccb ack <agent>` | 只确认 inbox head |

---

## 完整命令列表

```bash
# 启动与停止
ccb                         # 启动 Agent 团队
ccb -s                      # 安全启动
ccb -n                      # 重建运行时状态（保留配置）
ccb kill                    # 停止项目运行时
ccb kill -f                 # 强制清理运行时残留
ccb restart                 # 重启所有 Agent pane
ccb restart <agent>...      # 重启指定 Agent（可多个）
ccb reload                  # 动态应用支持的配置变更
ccb reload --dry-run        # 预览 reload 计划
ccb rich                    # 启动 Rich Workbench
ccb cleanup                 # ccbd 停止后清理可重建缓存
ccb theme [light|dark|+|-]  # 设置或查看全局 CCB UI 主题

# Agent 间通信
ccb ask <agent>                    # 向指定 Agent 委派任务
ccb ask --compact <agent>          # 请求精简回复
ccb ask --chain <agent>            # 链式委派（v8.0.9+ 推荐）
ccb ask --callback <agent>         # 链式委派兼容别名
ccb ask --notify-sender <agent>    # 任务完成后通知发送方
ccb ask --silence <agent>          # 静默发送
ccb ask --artifact-request <agent> # 强制请求正文存入 text artifact
ccb ask --artifact-reply <agent>   # 强制最终回复存入 text artifact
ccb ask --artifact-io <agent>      # 请求和回复都使用 text artifact
ccb ask get <job_id>               # 诊断：查看一个已提交 job
ccb ask cancel <job_id>            # 取消一个已提交 job

# 查看回复与状态
ccb watch <agent|job_id>                   # 观察 job 或 agent 事件直到终态或超时
ccb pend <agent> [count]                   # snapshot 目标状态
ccb pend --watch <agent|job_id>            # 兼容观察模式，优先传 job_id
ccb pend --inbox [--detail] <agent>        # 查看 Agent 收件箱
ccb pend --queue [--detail] <agent|all>    # 查看 backlog 状态
ccb queue [--detail] <agent|all>           # 查看 mailbox queue
ccb inbox [--detail] <agent>               # 查看 agent inbox head 和 pending items
ccb ping <agent|ccbd>                      # 检查 Agent 或控制平面健康
ccb trace <id>                             # 从 submission/message/attempt/reply/job id 重建链路
ccb ack <agent> [inbound_event_id]         # 确认 inbox head

# 等待与观察
ccb wait-any <target>              # 等待 target 任意结果
ccb wait-all <target>              # 等待 target 全部结果
ccb wait-quorum <N> <target>       # 等待 N 个结果

# Role、工具和维护
ccb roles add <role:provider>      # 将 role 绑定到项目
ccb roles install <role>           # 安装 role 资产和依赖
ccb roles update <role>            # 刷新 role 资产
ccb roles list                     # 列出可用 role
ccb roles show <role>              # 查看 role 信息
ccb roles doctor <role>            # 诊断 role
ccb tools install <tool>           # 安装托管工具
ccb tools doctor <tool>            # 诊断托管工具
ccb maintenance status             # 查看 heartbeat 策略与状态
ccb maintenance tick               # 运行一次诊断 tick
ccb agent add NAME:PROVIDER --role ROLE [--window NAME|--window-class CLASS] --hidden --json
                                    # 运行时热加载动态 agent，不改写 ccb.config
ccb agent remove NAME|--agents a,b --policy park|unload --json
                                    # park 或卸载动态 agent
ccb agent park NAME|--agents a,b --json
                                    # 暂停派发，保留 pane
ccb agent resume NAME|--agents a,b --json
                                    # 恢复派发
ccb agent release NAME --idle-only --json
                                    # 按 role policy 安全释放动态 agent
ccb loop capacity ensure --loop-id ID --profile worker=1 --profile code_reviewer=1 --json
                                    # 按 loop.role_profiles 规划动态 loop worker
ccb loop topology propose|commit|reconcile|status|release --loop-id ID --json
                                    # 管理 runtime workflow graph
ccb loop run-once --loop-id ID --task TEXT --json
                                    # 运行一次 worker / reviewer / orchestrator / round-checker round

# 诊断与调试
ccb doctor                         # 项目诊断
ccb doctor ps                      # 运行时 / session / workspace 诊断
ccb doctor logs <agent>            # 查看 Agent 日志
ccb doctor storage                 # 查看 .ccb 存储分类统计
ccb doctor --output                # 导出诊断支持包
ccb ps                             # 运行时清单（兼容入口）
ccb logs <agent>                   # 查看 Agent 日志（兼容入口）
ccb queue <agent|all>              # 查看任务队列状态
ccb queue --detail <agent|all>     # 查看详细队列状态
ccb config validate                # 验证当前 profile 解析后的配置
ccb cancel <job_id>                # 取消任务
ccb trace <id>                     # 查看任务/消息/回复的完整 lineage
ccb ack <agent>                    # 确认 Agent 的回复/收件箱进度
ccb retry <id>                     # 重试失败的任务
ccb resubmit <message_id>          # 基于历史消息重新提交
ccb clear [agent...]               # 发送 /clear 到 Agent pane

# 安装、更新与卸载
ccb version                        # 查看版本
ccb update [rich|mobile|VERSION]   # 更新当前安装版 / rich / mobile / 指定版本；源码 fork 更新优先用 git pull + install.sh
ccb update mobile                  # 安装 / 更新手机远程控制组件
ccb install mobile                 # 启动 server-wide CCB Mobile gateway 和配对 QR
ccb mobile serve                   # 启动当前项目的 loopback mobile gateway
ccb mobile devices                 # 查看已配对移动设备
ccb mobile revoke <id>             # 撤销本地配对设备
ccb update rich                    # 安装 / 更新 Rich Workbench
ccb reinstall                      # 重新安装
ccb uninstall [rich]               # 卸载 CCB 或 Rich Workbench
```

---

## 启动脚本

- `start.sh` — 启动 CCB
- `stop.sh` — 停止 CCB
- `restart.sh` — 重启 CCB
