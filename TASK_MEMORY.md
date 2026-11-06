# 任务记忆

> 只记还没做完、下回要接着干的工作。写法见 `.agents/task-memory.md`。
> 可复用结论写 `AI_MEMORY.md`，不要在这里归档长复盘。

---

## Provider RoleBinding Session slice [进行中 2026-11-02]

目标：完成 Provider 页 RoleBinding Session 创建与 Workspace Session 列表切片的审查收尾。
状态：Reviewer Round 3/3 按用户裁决将 F-001 标为 DISMISSED（仅 RoleBinding 需 connect 前校验）；代码未因该 finding 修改。
阻塞或未决：完整变更基线可核验后重新进行范围审查；此前保持 HOLD，且不扩大 legacy Provider/model 行为。
涉及文件：`apps/web/src/pages/ProviderPage.vue`、`packages/server/src/application/sessions/session-service.ts`、`.ccb/ccbd/artifacts/text/completion-reply/`。

## Web Phase 2/3 功能补齐 [进行中]

目标：补齐 Web 多 Agent 协作闭环（TaskBoard、Artifact、Mailbox、Coordinator/P-E-R、Workflow、同 ID reset-context），桌面端和视觉重做延期。
状态：0C 本机合成容量观察及报告已记录在 `docs/architecture/容量基线.md` 和同目录 CSV；SQLite inline Artifact（≤65,536 UTF-8 bytes）服务端切片已完成，文件模式仍关闭。Mailbox 单 Task handoff 收件（unread/read、migration v11、Web 入口）已完成。Session-scoped Artifact metadata 列表与按需纯文本预览 UI 切片已交付。多 Task handoff/`source_task_id` 的 Event provenance RED 测试已完成并提交；测试覆盖可信 Runtime Task、Task/Run 写入归属及完成水位内 fail-closed 读取，生产实现尚未开始。提交前修复了 `saveTask` 对多 Task Run 撞 `(run_id, node_key, attempt)` 唯一索引的回归：默认 lineage 只在 Run 内首个 Task 写入，其余写 NULL，逻辑移入 `sqlite-run-closure.ts` 的 `saveTaskWithDefaultLineage`。
阻塞或未决：当前只获准停在 RED；须等用户明确授权后才进入 GREEN。F-001 保持 OPEN，后续实现须明确处理 SQLite attempt 存储类型与非整数值。
涉及文件：`docs/architecture/容量基线.md`、`docs/architecture/capacity-curve-observations-2026-10-30.csv`、`scripts/measure-capacity-curve.mjs`。

## Claude 单轮跨进程 Session Resume live 验证 [已搁置 2026-10-26]

目标：验证真实 Claude transcript-backed ACP `session/resume`。
状态：独立测试任务；不作为产品功能开发门槛。
阻塞或未决：macOS sandbox 当前不能将 Broker 出站限制到固定公网 IP；恢复前须先证明精确 egress 隔离，不得放宽网络边界。
涉及文件：`tests/contract/src/acp-session-resume-live-smoke.test.ts`、`tests/contract/src/acp-session-resume-live-harness.ts`、`tests/contract/src/provider-adapter-probe/`、`docs/modules/acp-runtime.md`。
