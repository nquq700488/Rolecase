---
name: writing-skill
description: >
  新增、修改或优化项目 Skill 时使用。当需要把一类高频工作流固化为
  .agents/skills/{name}/SKILL.md、改写已有 skill、评估 skill 是否有效、
  优化 description 触发准确性，或为 skill 同步 .claude/commands 路由和
  .agents/skills.md 索引时使用。
---

# Writing Skill（写 Skill 的 Skill）

> 写 skill 不是写散文,是**对流程做测试驱动开发**:针对 Agent 真实的失败模式调校措辞,
> 写完要验证它真能改变行为。
> Skill 与领域规范的关系、注册流程见 `skills.md`;进化触发见 `continuous-learning.md`。

## 铁律

```text
没有失败基线、重复工作证据或明确触发需求,就不要写这个 skill。
```

凭感觉写的 skill 往往在解决不存在的问题,或用错了措辞形态。先看见失败、
重复劳动或触发缺口,再写规则。

## 必读规范

1. `AGENTS.md`
2. `.agents/skills.md`
3. `.agents/spec-governance.md`
4. `.agents/continuous-learning.md`（进化来源场景）

---

## 把写 Skill 当 TDD

### 先捕获意图

开始写之前先从当前对话提取已知信息,缺口再问用户。至少确认:

1. 这个 skill 要让 Agent 做什么?
2. 什么用户表达、文件路径或任务上下文应该触发它?
3. 期望输出是什么形状?
4. 是否需要测试用例验证它真的改变行为?

如果是改已有 skill,先保留原 `name` 和目录名,不要因为改版而改名。

| 阶段 | 动作 | 产出 |
|------|------|------|
| **RED** | 新增 skill: 在没有该 skill 的前提下跑施压场景,或记录多个任务里的重复工作;修改已有 skill: 跑当前 skill 仍会失败的场景。**逐字记录错误行为、重复步骤和合理化借口** | 失败基线 / 重复工作证据 |
| **GREEN** | 针对记录到的失败,写最小够用的 skill —— 只解决真实出现过的问题 | SKILL.md |
| **EVAL** | 写 2-3 个真实用户会说的测试提示;能客观判断的场景补 expected_output 或检查点 | eval 提示 |
| **REFACTOR** | 跑测试提示或人工走读,补上仍会漏的漏洞;删掉没人会犯的"假想错误" | 收敛后的 skill |

施压场景类型(从真实失败里取材):时间压力("紧急,先跳过")、沉没成本("已经写了很多,删了可惜")、权威("用户/reviewer 说必须这样")、疲劳(长任务末尾松懈)。

---

## Match the Form to the Failure（按失败类型选措辞形态）

**最关键的一节。** 不同失败类型要用不同措辞形态,用错形态会适得其反:

| 失败类型 | 表现 | 该用的形态 | 反例 |
|---------|------|-----------|------|
| **违规型** | 知道规则,但压力下跳过 | 铁律 + 红牌 + 借口反驳表 | 只写"建议遵守"太软 |
| **输出形状错误** | 照做了,但输出臃肿 / 结论被埋 / 啰嗦 | **正向配方 / 契约**(说清"输出应该长这样") | ❌ 用禁令——禁令会让它产出更多不想要的内容 |
| **遗漏必填项** | 忘了带某字段 / 某步骤 | 结构化的 REQUIRED 字段清单 | 散文描述容易被漏 |
| **行为应随条件变化** | 一刀切,不分情况 | 可观测谓词的条件句("当 X 时做 A,否则 B") | 绝对禁令丢失灵活性 |

经验规则:**禁令适合"违规型"失败,对"输出形状"问题反而有害。** 不确定时先判断失败属于哪一类,再选形态。

补充措辞纪律:

- 不把"除非……""一般情况下……"写成模糊逃生通道;必要例外必须写成可观测条件 + 明确处理动作
- 高频 skill 正文尽量短(触发越频繁越要省 token)

---

## description 只写触发条件,不概括流程

```text
description = "何时用",不是 "怎么做"。
```

- ✅ `description: 当遇到 bug、测试失败、构建失败时使用;尤其时间压力大想跳过调查时`
- ❌ `description: 强制执行 调查→分析→验证→修复 四阶段流程`

原因(上游 superpowers 实测):description 一旦概括了流程,Agent 会**照 description 行事而跳过正文**,导致正文里的完整流程被忽略。触发条件写得越准、流程留在正文,skill 才会被正确执行。

description 要同时包含:

- skill 做什么
- 什么时候必须触发
- 常见用户说法、文件类型、路径或上下文信号
- 相邻 skill 的边界,尤其容易误触发的近邻场景

如果发现 skill 经常漏触发,生成 8-10 个 should-trigger 和 8-10 个 should-not-trigger 查询做触发评估。负例优先选近邻场景,不要只写明显无关的简单句。

---

## SKILL.md 标准结构

```text
---
name: kebab-case 名称
description: 只写触发条件(见上)
---

# 标题
> 一句话定位 + 与相邻规范的边界引用

## 铁律            ← 纪律型 skill 必备;模式型可省
## 必读规范        ← 链接,不复制正文
## 使用边界        ← 何时用 / 何时不用
## 流程 / 执行骨架  ← 核心步骤,按需配红牌、借口反驳表
## 输出契约 / 交付模板 ← 当 skill 会影响最终回复形状时必备
## 必守红线        ← 收尾的硬约束清单

## 相关文档
```

支持材料原则:概念 / 原则 / 短示例内联;高频 skill 正文优先短,长示例放相关规范或 reference 文件。引用其他 skill / 规范用链接,不复制正文(遵守 `spec-governance.md` 单一信息源)。

---

## 新增 / 修改 Skill 的收尾(索引同步)

按 `skills.md` 与 `spec-governance.md`「修改规范时检查」执行:

1. `.agents/skills/{name}/SKILL.md` 落盘
2. `.claude/commands/{name}.md` 薄路由(需含 `skills/{name}/SKILL.md` 路径)
3. `.agents/skills.md` 索引表加一行「何时用」（不复制执行步骤）
4. 评估 `AGENTS.md` 规范导航是否需补引用
5. 检查通用性:框架绑定、过时路径、重复规则、与相邻 skill 的边界
6. 跑本地一致性检查:
   - `rg -n "{name}|旧名称|旧路径" .agents .claude AGENTS.md`
   - `test -f .claude/commands/{name}.md`
   - 确认 frontmatter 只有 `name` 和 `description`
   - 确认目录名、frontmatter name、命令文件名一致

---

## 轻量验证方式

没有专用 eval 工具时,至少做以下验证:

1. 写 2-3 个真实测试提示,覆盖常规触发、边界触发、近邻不触发。
2. 对新增 skill,用“没有该 skill 时会怎么做”的基线或过往失败记录对照。
3. 对修改 skill,保留修改前版本的关键行为作为基线。
4. 检查新 skill 是否让 Agent 少走弯路,而不是只增加阅读负担。
5. 如果多个测试提示都让 Agent 重复写同一段脚本或模板,把它沉淀到 `scripts/`、`references/` 或 `assets/`。

资源选择:

- `scripts/`: 重复、脆弱、需要确定性的操作。
- `references/`: 只有部分场景需要的大块知识,从 SKILL.md 明确指路。
- `assets/`: 输出要复用的模板、图片、样例文件。

---

## 必守红线

- 先有失败基线、重复工作证据或明确触发需求再写 skill;新增 skill 看无规则时的失败或重复步骤,修改 skill 看当前规则仍会失败的场景。
- 按失败类型选措辞形态:违规型用禁令,输出形状错误用正向配方。
- description 只写触发条件,严禁概括流程。
- 必要例外必须写成可观测条件 + 明确处理动作,不能写成模糊豁免。
- 不复制其他规范正文,只引用链接。
- 新增 / 改名 skill 必须同步 skills.md 索引和薄路由文件。

---

## 相关文档

- [skills.md](../../skills.md) — Skill 组织、触发边界、注册流程
- [continuous-learning.md](../../continuous-learning.md) — 何时把重复信号升级为 Skill（须用户确认）
- [spec-governance.md](../../spec-governance.md) — 索引一致性与单一信息源
