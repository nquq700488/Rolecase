---
name: parallel-worktree
description: >
  当需要多个 Agent（本地或 CCB）同时在同一项目开发不同模块、要用 git worktree
  隔离工作目录时使用。不用于单 Agent 串行。隔离工作区不等于授权 git commit，提交仍须用户本轮明确说。
---

# 并行 WorkTree 隔离

> 多 Agent 并行开发时，为每个 Agent 分配独立 git worktree，避免文件冲突。
> 本地执行方法论见 `workflow.md`，CCB 协作见 `collaboration.md`，提交授权见 `git-workflow.md`。

## 铁律

```text
禁止多个 Agent 在同一分支/目录同时修改文件
```

Worktree 只能隔离工作目录，不能消除合并冲突。任务拆分时必须尽量避免文件重叠；公共接口、类型定义、数据库 schema、配置入口等共享改动应优先串行合入。

## 适用场景

**本地子 Agent 并行且需要隔离**：同一会话内派发多个子 Agent，各自编码不同模块；当改动较大、验证环境可能互相影响或存在合并风险时使用 worktree。

**CCB Developer 承接可并行任务**：CCB 的 `developer` 通常是单例。Phase 2 只派发给 `developer`，由 Developer 在支持时把独立子任务拆给本地子 Agent；需要隔离时为每个子任务创建独立 worktree，最后由 Developer / Orchestrator 汇总合并。

不使用：

- 单 Agent 串行任务
- 标准 CCB 流程（Plan → Dev → Review → Test 本身就是串行的，不需要隔离）
- 多个任务必须频繁修改同一文件同一区域（改为串行）

## 启动前检查

执行任何 `git worktree add` 前，必须完成：

```bash
git rev-parse --show-toplevel
git status --short --untracked-files=all
git branch --show-current
git worktree list
```

检查项：

- 当前目录是 Git 仓库
- 已识别主工作区路径和当前分支
- 已确认 base branch（用户指定优先；否则使用当前分支）
- 工作区有未提交变更时，先判断是否会影响拆分；不得擅自 stash、reset 或 checkout
- 目标 worktree 路径不存在，分支名未被占用
- 已确认每个 Agent 的文件归属和禁止触碰范围

## 任务分配表

创建 worktree 前输出并确认：

| Agent | 分支名 | Worktree 路径 | 负责范围 | 禁止触碰 | 验证命令 |
|-------|--------|---------------|----------|----------|----------|
| developer-a | （跟随仓库已有分支约定，例 `wt/agent-a`） | ../project-agent-a | `<模块路径>` | `<共享路径>` | 仓库里已确认存在的验证命令 |

若两个 Agent 都需要修改同一公共文件，先拆出“公共接口/类型”前置任务，串行完成并合入后再并行。

## 操作流程

### 1. 创建 Worktree

```bash
git worktree add -b <branch-name> ../<project>-<name> <base-branch>
```

- `<branch-name>`：跟随仓库已有分支约定，不要默认 `feature/agent-*`
- `../<project>-<name>`：独立工作目录路径
- `<base-branch>`：基于哪个分支创建（用户指定优先；否则使用当前分支）

### 2. 通知 Agent 工作目录

**本地子 Agent**：直接指定 worktree 路径为工作目录。

**CCB developer**：在 `ccb ask developer` 的 prompt 中明确写清楚 worktree 分配规则，由 developer 只在指定 worktree 内执行或继续派发本地子 Agent：

```text
【工作目录】/path/to/project-<module>（已初始化的独立 git worktree，基于 <base-branch>）
【负责范围】<模块路径>
【禁止触碰】<共享路径>
【验证命令】<仓库已确认存在的验证命令>
请只在此目录下开发该模块；如派发本地子 Agent，子 Agent 也必须限定在该 worktree 和负责范围内。不要修改其他目录或禁止触碰文件。未获用户本轮明确要求不要 git commit。
```

### 3. 每个 Worktree 内验证

```bash
cd ../<project>-<name>
git status --short --untracked-files=all
# 运行分配表中的验证命令
```

要求：

- 读取 diff，确认只改了负责范围
- 运行分配表中的验证命令
- 验证失败不得合并；按任务路由修复或升级人工
- 未获用户本轮明确要求不要在 worktree 内 `git commit`（见 `git-workflow.md`「何时提交」）

### 4. 合并回主干

在主工作区执行：

```bash
cd <主项目目录>

# 按分配表的分支名合并，名称用表里的，不要另造
git merge <分配表中的分支名>
```

合并规则：

- 合并顺序：公共接口/类型 → 基础设施 → 业务模块 → UI/文案
- 每合并一个分支，检查冲突和 diff
- 所有分支合并后，运行项目最小整体验证命令
- 整体验证失败时停止清理，先修复或回滚本次合并策略（不得 `reset --hard`，除非用户明确授权）

### 5. 清理

```bash
git worktree remove ../<project>-<name>
git branch -d <分配表中的分支名>
```

清理前必须确认：

- 分支已合并或用户明确决定废弃
- worktree 中没有未提交改动
- 主工作区整体验证已通过，或失败原因已明确记录

## 并行安全原则

| 风险 | 预防 |
|------|------|
| 两个 Agent 改了同一文件同一区域 | 拆分任务时明确文件归属 |
| 类型定义冲突 | 公共接口/类型先作为前置任务串行合入，其他 Agent 基于新版本继续 |
| 合并冲突 | 接口层优先合并；业务层冲突由 Orchestrator 协调解决 |
| 验证环境不一致 | 每个 worktree 内局部验证，主工作区合并后整体验证 |

## 禁止行为

- ❌ 多个 Agent 共用同一个 worktree 目录
- ❌ 在未合并前删除 worktree（`git worktree remove --force`）
- ❌ Agent 之间直接修改对方的 worktree 文件
- ❌ 跳过合并直接在主干继续开发
- ❌ 未确认 base branch、目标路径和分支名就创建 worktree
- ❌ 未跑每个 worktree 的验证就合并
- ❌ 合并后未跑整体验证就清理分支
- ❌ 用 worktree 掩盖必须串行处理的公共接口变更
- ❌ 未获用户本轮明确要求就在 worktree 里 `git commit`

## 快速参考

| 步骤 | 命令 |
|------|------|
| 创建 | `git worktree add -b <分支> <路径> <基准>` |
| 查看 | `git worktree list` |
| 进入 | `cd <路径>` |
| 合并 | `git merge <分支>` |
| 移除 | `git worktree remove <路径>` |
| 清理分支 | `git branch -d <分支>` |

## 相关文档

- [collaboration.md](../../collaboration.md) — 多 Agent / CCB 协作规范
- [workflow.md](../../workflow.md) — 本地执行方法论
- [git-workflow.md](../../git-workflow.md) — 何时提交、禁止擅自 commit
- [multi-agent-orchestrate](../multi-agent-orchestrate/SKILL.md) — CCB 编排器
