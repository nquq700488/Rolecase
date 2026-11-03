# 上下文模式：审查模式（Review）

> 触发时机：执行代码审查（独立审查或完整模式 Phase 3）。
> 门禁、判定、输出格式的唯一来源是 `quality-checklist.md`「Reviewer 实现质量门禁」。本文件不重复正文。

---

## 核心约束

1. **同轮双阶段（P0）**：每轮按 Stage 1 → Stage 2 评估；Stage 1 未通过也执行 Stage 2，但 Stage 1 FAIL 表示不可合入。只把依赖失效假设的项目标为 provisional，且不降低其 severity/blocking。Review Input Pack、ledger 与回合处置见 `quality-checklist.md`。
2. **不信任汇报**：必须读代码核实。
3. **功能可用但写得差** → 至少 HIGH，不能直接通过。
4. 语言专属问题（如 TypeScript `any`）按 `coding-standards/` 对应文件审，不要当全项目铁律。
5. UI 可视化审查仅在「有页面改动且项目已有可用检查手段」时做，见 `quality-checklist.md`「UI 审查」。

禁止：跳过 Stage 1；只看变更描述不读代码；用表演性认同代替技术判断。
