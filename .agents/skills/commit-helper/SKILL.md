---
name: commit-helper
description: >
  仅当用户本轮明确说"提交代码"、"commit"、"提交更改"、"提交修改"时使用。
  任务做完、收尾、交付、可以结束了不要用本 skill。本会话里曾经提交过也不构成后续授权。
  提交类型、拆分、分支与门禁以 git-workflow.md 为准。未要求时不要 push。
---

# Commit Helper

> 本 skill 只负责执行提交流程；提交规范、拆分规则和质量门禁统一维护在 `.agents/git-workflow.md`。
> 没有本轮明确提交指令时立刻停止，不要进入下面骨架。

## 必读规范

1. `AGENTS.md`
2. `.agents/git-workflow.md`

## 执行骨架

0. **授权门：** 用户本轮是否明确要求提交？否 → 停止。上一轮提交过不算。
1. 检查完整工作区：`git status --short --untracked-files=all`、`git diff --stat`、`git diff --cached --stat`、`git ls-files --others --exclude-standard`，必要时读 diff 理解变更目的。列出 untracked：属于本次逻辑的纳入分组，其余不加。
2. 按 `git-workflow.md` 做变更拆分分析；需要多次提交时先让用户确认分组。
3. 按项目实际配置运行 lint、typecheck、必要测试。error 必须修；仅 warning 须说明。没有可运行命令时说明原因。
4. 根据当前提交组推断 Conventional Commit type，生成 50 字以内中文 description。
5. 精确暂存当前提交组文件，禁止 `git add .`。
6. 提交前复核 staged：`git diff --cached --stat`，必要时读 `git diff --cached`，确认没有密钥、临时调试、无关文件或错误分组。
7. 用 HEREDOC 执行 `git commit`，禁止 `--no-verify`。格式见 `git-workflow.md`。
8. 多提交组按组重复 4–7；每组单独 stage、单独复核、单独 commit。组间有依赖或中途改了文件，重跑相关验证。
9. 提交后输出 commit hash、提交信息、验证结果和剩余工作区状态。未明确要求不 `git push`。

## 必守红线

- 禁止提交 lint / 类型检查 error；验证命令不存在时必须说明。
- 禁止把多个无关目的塞进一次提交。
- 禁止暂存无关文件、密钥、构建产物或用户未确认的变更。
- 禁止不看 untracked 列表就提交；该进本次的不能漏，不该进的不能加。
- 禁止在用户未本轮明确要求时执行 `git add` / `git commit` / `git push`。
- 禁止把「任务完成」「收尾」「交付」或本会话历史提交当成授权。
- 禁止 `git add .`、`git commit --no-verify`；禁止直接推送受保护主干。
- 禁止提交业务代码中的临时调试语句（按仓库语言检查）。
- 暂存范围不清时先确认，不猜。
