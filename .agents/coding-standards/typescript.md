# 编码规范 — TypeScript 特定

> 本文件定义 TypeScript / JavaScript 项目的特定约束。
> 通用命名、注释、质量要求见 `common.md`。

---

## 命名

| 类型 | 命名方式 | 示例 |
|------|---------|------|
| 文件（工具/模块） | camelCase | `useMyFeature.ts` |
| 文件（组件/类） | PascalCase | `MyComponent.tsx` |
| 变量/函数 | camelCase | `activeTool`、`handleAction` |
| 常量 | UPPER_SNAKE_CASE | `DEFAULT_LIMIT` |
| 接口/类型 | PascalCase | `ToolDefinition` |
| 枚举 | PascalCase | `Status.Active` |

- ❌ 变量名禁止包含下划线（解构忽略参数 `_` 除外）

| 前缀 | 场景 | 示例 |
|------|---------|------|
| `handle` | 事件处理 | `handleClick` |
| `toggle` | 状态切换 | `toggleVisible` |
| `set` | 状态设置 | `setColor` |
| `get` / `fetch` | 获取数据 | `getUserInfo` |
| `init` | 初始化 | `initApp` |
| `reset` | 重置 | `resetForm` |
| `use` | 组合式函数 / Hook | `useDebounce` |

---

## 类型系统

- 函数参数和返回值**必须标注类型**
- ❌ 禁止 `any`（第三方库无法避免除外）
- ❌ 禁止 `var`，禁止 `==`（必须用 `===`）
- ❌ 禁止在业务代码中保留 `console.log`
- 不直接修改对象 / 数组，用展开运算符创建新副本
- 复杂结构用 `interface`，简单联合类型用 `type`
- 可空值用 `T | null`，不用 `T | undefined`（函数可选参数除外）
- **优先具名导出**，仅单例实例允许默认导出
- 工具函数文件通过 `index.ts` 统一 re-export

---

## 错误处理

- 异步失败必须被记录或向上传递，禁止空 `catch`
- 跟随仓库已有的错误处理写法（`try/catch`、Result、统一包装函数等），不要另引入本仓库不存在的工具函数

公共工具函数、导出的 Hooks / 可复用模块必须写 JSDoc；简单事件处理用行内注释 `//`。

标签：`@name`、`@description`（中文）、`@param {类型} 参数名 说明`、`@return {类型} 说明`、`@example`（复杂函数必须）、`@deprecated`

```typescript
/**
 * @name clamp
 * @description 将数值限制在闭区间 [min, max] 内
 * @param {number} value 待限制的值
 * @param {number} min 下限
 * @param {number} max 上限
 * @return {number} 限制后的值
 * @example
 * clamp(12, 0, 10) // 10
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
```

---

## Vue / React 组件特定

仅在项目使用对应框架时适用。

### Vue（Composition API）

- 使用 `<script setup lang="ts">`
- 组件名 PascalCase，文件名与组件名一致
- Props 用 `defineProps<{}>()` 带类型
- Emits 用 `defineEmits<{}>()` 带类型
- 逻辑提取为 Composable，不在组件内写过长逻辑

### React

- 函数组件 + Hooks，不用 Class 组件
- Props 类型用 `interface`，命名 `{ComponentName}Props`
- 自定义 Hook 以 `use` 开头，返回数组或对象需标注类型

---

## 异步处理

- 优先 `async/await`，避免回调地狱
- 并行请求用 `Promise.all`，错误统一处理
- 取消逻辑：组件卸载时取消未完成的请求

```typescript
// ✅ 并行请求 + 统一错误
const [users, orders] = await Promise.all([
  fetchUsers().catch(handleError),
  fetchOrders().catch(handleError),
])

// ❌ 串行请求（无依赖时不必要）
const users = await fetchUsers()
const orders = await fetchOrders()
```

---

## 类型定义组织

- 全局类型放 `types/` 或 `src/types/`
- 模块内类型与实现放同一文件（或同目录 `.types.ts`）
- 避免在组件文件内写过长类型定义

---

## 导入规范

- 按来源分组：内置 → 第三方 → 别名路径 → 相对路径
- 每组之间空一行
- 禁止循环依赖

```typescript
// ✅
import { readFile } from 'node:fs/promises'
import axios from 'axios'

import { useUserStore } from '@/stores/user'
import { formatDate } from './utils'
```
