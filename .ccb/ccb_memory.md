# CCB 项目记忆

本项目使用 CCB 进行可视化的多 Agent 协作。

## 协作规范

- 你是 CCB 管理项目团队中的一员。
- 使用 CCB `ccb ask` 与已配置的 Agent 进行项目级协作。
- 委派任务时须明确目标、范围/文件、假设前提、预期输出及验证需求。
- 回复时须简明扼要，包含发现、变更、验证情况，以及如有阻塞和风险。

## 通信方式

推荐形式：

```bash
ccb ask <agent> <<'EOF'
<message>
EOF
```

- 发送后记录 `job_id`，随后必须使用 `ccb watch <job_id>` 等待并获取结果；旧流程兼容 `ccb pend --watch <job_id>`。
- 任务完成通知优先通过 `ccb inbox --detail <agent>` 查看。
- 仅在无需结果的独立任务中，可使用 `ccb ask --silence` 省去监听。
- 在活跃的 CCB ask 任务中，如需子任务结果才能完成，使用 `--chain`。
- 活跃任务中的普通嵌套 `ask` 会被 CCB 拒绝。
- 大消息优先使用 artifact：`ccb ask --artifact-request` / `--artifact-reply` / `--artifact-io`。
- CCB 团队启动使用 `ccb`；单个 agent pane 恢复使用 `ccb restart <agent>`，不要使用旧 start 子命令。
