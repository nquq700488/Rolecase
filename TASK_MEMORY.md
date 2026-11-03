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
状态：0C 本机合成容量观察及报告已记录在 `docs/architecture/容量基线.md`，逐次数据见同目录 CSV；现在暂停等待用户审阅和资源目标决定，生产 admission 仍 fail-closed。
阻塞或未决：等待用户决定资源目标并书面批准有限 Q/P/N；没有该批准前不得设置生产额度或开放容量相关 admission。批准前本任务不继续推进容量相关生产工作。
涉及文件：`docs/architecture/容量基线.md`、`docs/architecture/capacity-curve-observations-2026-10-30.csv`、`scripts/measure-capacity-curve.mjs`。

## Claude 单轮跨进程 Session Resume live 验证 [已搁置 2026-10-26]

目标：验证真实 Claude transcript-backed ACP `session/resume`。
状态：独立测试任务；不作为产品功能开发门槛。
阻塞或未决：macOS sandbox 当前不能将 Broker 出站限制到固定公网 IP；恢复前须先证明精确 egress 隔离，不得放宽网络边界。
涉及文件：`tests/contract/src/acp-session-resume-live-smoke.test.ts`、`tests/contract/src/acp-session-resume-live-harness.ts`、`tests/contract/src/provider-adapter-probe/`、`docs/modules/acp-runtime.md`。
