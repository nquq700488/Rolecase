# 质量检查清单（Quality Checklist）

> 类型检查、lint、测试、交付前验证看 `AGENTS.md` 与 `workflow.md`。
> 本文件定义**性能、安全、代码组织与审查门禁**。
> 第一节性能默认面向 Web 前端；非前端项目只采用内存 / 网络 / 安全 / 代码组织中适用的条目，忽略 FCP / LCP 等浏览器指标。

---

## 一、性能

### 加载性能

- 路由懒加载
- 大组件异步加载
- 图片懒加载
- 构建按需分包

### 运行时性能

- 静态内容使用缓存机制
- 大数据列表使用虚拟滚动
- 大对象使用浅响应/非响应式标记
- 高频事件（scroll/resize/input）加防抖/节流
- 动画使用 `requestAnimationFrame`

### 内存管理

- 组件卸载时清理：定时器、事件监听、实例、缓存
- 大对象避免深层代理

### 网络优化

- API 请求使用缓存策略
- 图片使用现代压缩格式（WebP/AVIF）
- 启用 gzip/brotli 压缩

### 性能指标

| 指标 | 目标 |
|------|------|
| FCP | < 1.8s |
| LCP | < 2.5s |
| TTI | < 3.8s |

验证方式：开发联调优先 Performance 面板做本地基线；涉及真实网络/图片/首屏的场景在接近真机的环境验证；不具备可测条件时必须在交付说明中标注"性能指标未实测"。

---

## 二、安全

### 输入验证

- 所有表单输入使用 schema 验证
- 前端验证不可信，后端必须二次验证

### XSS 防护

- ❌ 禁止直接使用未经处理的 HTML 注入
- ❌ 用户输入不要直接插入 DOM

### 敏感数据处理

- Token 存储：httpOnly cookie 优先于 localStorage
- ❌ 禁止在前端硬编码密钥
- 敏感日志脱敏处理

### 文件上传

- 限制文件类型和大小（客户端 + 服务端双重校验）
- 服务端检查 MIME 类型，重命名上传文件

### 依赖安全

- 定期运行安全审计，及时修复有漏洞的依赖

---

## 三、代码组织

Reviewer 审查和 Developer 编码时均需关注。行数上限与 `coding-standards/common.md` 一致；有语言文件时以语言文件为准。

- **函数拆分**：单函数超过通用上限应拆分；每个函数只做一件事
- **文件拆分**：单文件超过上限应提取子模块；UI 项目才谈组件拆分
- **拆分合理性**：避免过度拆分（每文件 10-20 行且无独立复用价值）或拆分不足（一个文件包含多个独立职责）
- **职责单一**：每个模块的职责边界清晰，不把无关层揉在一起
- **复用提取**：出现 3 次及以上的相同逻辑提取为公共函数或模块；2 次但业务语义一致、预计共同演进时也应提取
- **封装克制**：只为真实复用、复杂度隔离或职责边界封装；禁止为单次使用或过早抽象制造无意义封装

---

## 四、Reviewer 实现质量门禁

功能跑通只是最低要求，不等于审查通过。Reviewer 必须审查"实现方式是否值得合入"。

### 同轮双阶段审查（强制，P0）

每个审查轮次都必须按 Stage 1 → Stage 2 的顺序评估；Stage 1 未通过也不能跳过 Stage 2。

**Stage 1：Spec 合规审查**（确认「做对了事」）

- 对比方案/需求逐行检查实际代码
- 检查缺失需求、多余实现、误解
- **不信任 Developer 汇报**：必须读代码核实，不能只看汇报内容
- 通过标准：全部需求已实现、无多余功能、无需求误解
- Stage 1 FAIL = 本轮审查不通过、不可合入；未满足已确认需求的 finding 无论 severity 都必须 `blocking=YES`，但不得为此人为抬高 severity。路由 Developer / Planner 修复后重新审查
- 记录通过/未通过及具体 finding；未通过项进入 ledger

**Stage 2：代码质量审查**（确认「把事做对了」）

- 无论 Stage 1 结果如何，都检查文件组织、命名、复用、抽象、测试；类型问题按该语言的 `coding-standards/` 审
- 若 Stage 1 失败使某项质量判断依赖的方案/接口假设失效，该项标记 `PROVISIONAL` 并写明待确认条件；其余 Stage 2 检查照常完成
- `PROVISIONAL` 只表示依据待确认，不得隐藏 finding、降低 severity 或清除 blocking 状态

### 审查维度

- **方案一致性**：实现是否偏离已确认方案、接口契约、数据流或任务边界
- **既有模式一致性**：是否复用项目已有模块、工具函数、状态/错误处理和命名风格
- **可维护性**：是否存在临时拼接、重复逻辑、过长函数/文件、过度嵌套、隐式副作用
- **抽象与封装质量**：是否遗漏应提取的复用单元，或过度封装、过早抽象、仅转发参数的薄封装
- **可读性**：命名是否表达意图，控制流是否清晰
- **类型与边界**：空值绕过、吞异常、用类型逃逸掩盖问题。语言专属禁令（如 TS `any`）见对应语言文件，不要当全项目铁律
- **最小改动**：是否引入无关重构、无关依赖、过宽影响面
- **目标贴合度**：每个新增模块、抽象、依赖或重构是否能追溯到本次需求和成功标准
- **可测试性**：核心逻辑是否可独立验证

### 范围膨胀门禁

Reviewer 发现以下情况时必须标记，不能因为代码"看起来更好"就放过：

- 改动解决了本次问题，但顺手改了无关模块、命名、格式或目录结构
- 新增抽象只有单一调用点，且没有隔离复杂度或外部依赖
- 为未确认的未来需求增加配置、扩展点、状态字段或兼容路径
- 删除、替换或重写了用户未要求变更的既有行为
- 变更范围明显大于成功标准所需，且没有可验证收益

### 判定规则

| 严重级别 | 判定标准 | 处理 |
|----------|----------|------|
| CRITICAL | 破坏功能、数据安全、核心契约或引入不可接受风险 | 阻断 |
| HIGH | 功能可用但实现粗糙，明显破坏可维护性、项目模式、抽象边界或后续演进 | 阻断 |
| MEDIUM | 有局部质量问题但不阻断当前合入，可明确后续修复 | 记录并建议修复 |
| LOW | 命名、注释、细节风格等轻微问题 | 建议 |

若"功能实现了但写得差"，Reviewer 必须至少给出 HIGH 或 MEDIUM。HIGH 问题必须路由 Developer 修复后复审。

### 报告前举证闸（Pre-Report Gate）

报告任一问题前，必须通过以下三道闸，任一不满足 → 降级或丢弃该问题：

1. **能引用确切位置**：指出具体 `文件:行`，不能只说"某处可能有问题"。
2. **能描述具体失败场景**：什么输入 / 状态 → 什么坏结果，不能只说"可能不健壮"。
3. **严重级别可辩护**：能说清为什么是这个级别，而不是凭感觉拔高或凑数。

附加要求：

- CRITICAL / HIGH 必须附确切代码片段 + 触发该问题的具体场景。
- 多处相似问题合并为一条（带代表位置 + 出现次数），不逐条刷屏。
- 目的：压制"为凑数报一堆 LOW / 模糊 MEDIUM"的噪音式评审，保证每条 finding 都可执行、可验证。来源归因不能替代缺陷证据，也不能单独改变严重级别或阻断判断；有效 CRITICAL / HIGH findings 不设数量上限。

### Review Input Pack 与 finding ledger（P0）

- 每个任务使用一个 task-scoped ledger；不创建跨任务累积的项目级 finding 日志。初审 ledger 明确写 `空`；复审必须收到上一轮完整 ledger，缺失时先由 ledger 维护者恢复，不得静默当作新审查。
- Review Input Pack 必须包含：task/scope ID、用户批准的范围及明确排除项、base/head 与本轮 diff hash、已确认需求和验收标准、完整 diff 上下文、本轮序号与目的、上一轮 ledger。复审还必须包含 Developer 的修复报告：实际改动文件/行块、验证结果、声明的直接/间接 blast-radius 路径；Reviewer 必须核对该声明与实际 diff，缺失时停止并要求补齐。初审无修复范围时将此字段标为 `N/A`。
- 每轮记录 Reviewer 身份元组：CCB 使用 `profile + agent_name + provider + model`；本地使用相应本地角色/agent + 实际 model。无法确认的字段写 `UNKNOWN`，不得从 provider 猜 model；不要求跨 profile 使用同一 Reviewer。
- Orchestrator 是完整流程中的 ledger 维护者；独立调用审查时，由发起并执行该审查的 agent/session 承担同一职责。Reviewer 返回更新后的完整 ledger；维护者只能按本节裁决规则更新状态，不得删除、改写或过滤 Reviewer finding。
- 每条 finding 有稳定 task 内 ID（`F-001`、`F-002`……），首次分配后不得重编号；新 finding 用下一个 ID。来源与发现状态分开记录：来源为 `TARGET_CHANGE`、`FIX_REGRESSION`、`BASELINE_PREEXISTING` 或 `UNCERTAIN`；发现状态为 `NEW`、`MISSED_IN_SCOPE`、`REPEAT` 或 `REOPENED`。`MISSED_IN_SCOPE` 必须说明该问题为何在上一轮漏报，并确认它当时已在 Review Input Pack 的范围内；该证据用于 Reviewer Rubric 的覆盖度评分，不得用固定扣分代替判断，也不得因此压掉新 finding。
- 每条 finding 至少记录：ID、origin、discovery、severity、blocking、review state、文件/行、失败场景/证据、ledger status、处置及理由。ledger status 仅用 `OPEN`、`FIX_IN_PROGRESS`、`FIXED_UNVERIFIED`、`VERIFIED_CLOSED`、`BACKLOG`、`ACCEPTED`、`DISMISSED`。
- Reviewer 按现有严重级别表和举证闸提出 severity；来源/发现时间不能改变 severity。Ledger owner 核实晚发现项的 scope 与 blocking 关系；若分歧会改变阻断结论，标明争议并升级用户/独立复核，不得仅因发现较晚就抬高等级，也不得为结束循环而压低有证据支持的 CRITICAL/HIGH。
- 合法状态流转：`OPEN → FIX_IN_PROGRESS → FIXED_UNVERIFIED → VERIFIED_CLOSED`；Reviewer 未验证修复时将 `FIXED_UNVERIFIED` 退回 `OPEN`。只有 MEDIUM / LOW 且明确非阻断的 finding 可从 `OPEN` 转为 `BACKLOG` 或经用户明确接受后转为 `ACCEPTED`。Reviewer 仅在有证据确认该项不是缺陷时，才可将 `OPEN` 标为 `DISMISSED`；不能用来搁置真实但超出本次范围的问题。
- CRITICAL / HIGH 不得转 `BACKLOG` 或 `ACCEPTED`，保持阻断直至验证关闭或按批准的范围变更重新评估。Reviewer 只能提出重开请求；只有 ledger owner（Orchestrator/独立审查 session）核实了新的客观证据，或用户明确批准了范围/裁决变更，才可将已关闭、已接受、已驳回或已入 backlog 的 finding 以原 ID 回到 `OPEN`。记录新证据、scope change、授权人和理由，并把 discovery 记为 `REOPENED`；仅有 Reviewer 不同意见不得翻案。
- `PROVISIONAL` 是 review state，不是 severity 或 ledger status；必须报告并说明待确认条件，不得因此降低 severity 或清除 blocking。
- 初审完整覆盖当前 diff 与已批准需求。复审仍以完整当前 diff 为上下文并完成 Stage 1、Stage 2，但完整 diff 是上下文，不授权扩大 follow-up 范围；复审核验 open ledger，并将新 ordinary finding 限定在本轮修复改动行/块与 Developer 声明且 Reviewer 验证过的 blast-radius 路径。范围外的常规新发现不得加入本轮 ledger 或触发新一轮。新 finding 同时标 origin/discovery：有证据证明由修复引入 → `origin=FIX_REGRESSION`；问题在 base 中已存在 → `origin=BASELINE_PREEXISTING`；若上一轮审查已覆盖当前允许范围但漏报 → `discovery=MISSED_IN_SCOPE`。不得把发现时间直接当成缺陷来源。
- 可信的 CRITICAL/HIGH 风险若在允许范围之外，单独放入「范围外严重风险升级」并附证据，不作为当前范围 finding、不自动消耗轮次；审查结论为 `HOLD`，由 ledger owner 核验其是否影响当前交付并交用户明确处置。若影响当前交付，保持阻断；只有确认不影响当前交付且用户批准转独立任务后，当前任务才可继续。不得静默放行、降级或丢弃该风险。
- Backlog 项只保留在 ledger，不在后续结论中重复展开，除非按规则重开。用户批准扩展范围时更新同一 task 的 Review Input Pack 与批准范围，不重置三轮计数。
- 每轮是一轮完整 Stage 1 + Stage 2；总计最多三轮（初审 + 两次复审）。第三轮仍未达到 `AGENTS.md` Reviewer Rubric 通过门槛、Stage 1 为 FAIL 或仍有 open blocker 时停止自动化、升级用户，ledger 保留所有未决问题且结论为不可合入。连续两轮出现 `MISSED_IN_SCOPE` 时，也要先完成当前整轮并更新 ledger，再停止自动化转人工；不得中途截断审查。

### Reviewer 输出格式

```md
## Reviewer 结论

审查状态：PASS / FAIL / HOLD
可合入：是 / 否（Stage 1 FAIL、HOLD 或存在 blocking finding 时必须为否）
Task/scope：[ID；批准范围与排除项]
Diff：[base/head；本轮 diff hash]
Repair delta：[改动文件/行块；经核验的 blast-radius；初审写 N/A]
Reviewer identity：[CCB profile / agent_name / provider / model，或本地 agent / model；未知值写 UNKNOWN]
本轮：N/3（初审 / 复审）
Stage 1 Spec 合规：PASS / FAIL
Stage 2 代码质量：PASS / FAIL；仅依赖 Stage 1 失败所推翻假设的 finding 标 `PROVISIONAL`
Reviewer Rubric：overall N/10（各维度等权平均，按 `AGENTS.md` 逐项评分）
| Dimension | Score / 10 | Evidence |
|-----------|------------|----------|
| [逐项填写 `AGENTS.md` Reviewer Rubric 的全部维度] | | |
总体评价：[说明本轮范围、结论和主要风险]

### 阻断问题
- [F-001] [origin] [discovery] [severity] [blocking] [OPEN/FIX_IN_PROGRESS/FIXED_UNVERIFIED] [CONFIRMED/PROVISIONAL] 文件:行 — 失败场景、证据、建议修复方向

### 本轮非阻断问题
- [F-002] [origin] [discovery] [MEDIUM/LOW] [non-blocking] [OPEN/BACKLOG/ACCEPTED] [CONFIRMED/PROVISIONAL] 文件:行 — 失败场景、证据、建议

### 范围外严重风险升级（无则写“无”）
- [OSR-01] [proposed severity] 文件:行 — 证据、为何超出批准范围、Ledger owner 验证和用户处置
- 仍待处置时审查结论必须为 `HOLD`；此记录不加入当前 task ledger，也不自动消耗审查轮次。

### Ledger（完整；包含旧项状态、新项与最终未决项）
| ID | Origin | Discovery | Severity | Blocking | Review state | Status | Disposition / evidence |
|----|--------|-----------|----------|----------|--------------|--------|------------------------|

### 已检查但未发现问题
- [按 Reviewer Rubric 与本次适用的审查维度列出]

### 剩余风险
- [没有则写“无”]
```

`ACCEPTED` / `BACKLOG` 项不在后续轮次重复展开；ledger 仍须保留其 ID、原始判断和处置理由。未关闭的 CRITICAL / HIGH 必须保留在「阻断问题」和 ledger 中。

---

## 五、UI 审查

仅当本次改动包含用户可见页面，且仓库**已有**可用的可视化检查手段时执行。没有 Playwright / 浏览器测试时：用仓库已有方式或手动核对关键状态，并在结论里写明未做截图自动化。**不要为审查去安装 Playwright。**

有页面改动且有工具时：

- 核对关键状态（正常、空态、错误态、加载态）
- 对照设计稿检查布局、间距、颜色、字体（项目有设计稿时）
- 交互状态、响应式、主题：项目已支持的才查

纯逻辑、API、后端、无 UI 的改动跳过本节。

---

## 六、重复问题修复要求

若复审时 ledger 中同一 finding 仍为 `OPEN` 或 `FIX_IN_PROGRESS`，Reviewer 必须保留原 ID 和历史状态；第二轮及之后必须给出**具体修复方案**：

- **页面样式问题** → 具体样式约定或结构（仅 UI 改动）
- **功能逻辑问题** → 代码修改建议或伪代码
- **拆分/架构问题** → 具体的重构方向和文件拆分建议

若出现相似但根因不同的问题，分配新 ID，并标明其 `origin` 与 `discovery`；不得用新 finding 掩盖旧项未解决。

---

## 七、通用安全检查清单

提交前确认。不适用的项标 `N/A`（无 SQL、无浏览器、无会话则不要当漏项）。

- [ ] 无硬编码密钥（API 密钥、密码、令牌）
- [ ] 来自用户或外部的输入已按本栈方式校验（无输入面则 N/A）
- [ ] 有数据库查询时：参数化 / 等价防护
- [ ] 有 HTML/DOM 渲染时：XSS 防护
- [ ] 有浏览器会话时：CSRF 防护（无 cookie 会话则 N/A）
- [ ] 有鉴权面时：认证/授权已核对
- [ ] 错误消息不泄露敏感数据
