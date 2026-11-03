# 编码规范 — 样式（CSS / SCSS / Less）

> 改 `.css` / `.scss` / `.less`，或组件内 `<style>` / CSS Modules / CSS-in-JS 时补读。
> 通用命名、注释、质量要求见 `common.md`。
> 可访问性、响应式、交互状态审查见 `web-design-guidelines`，本文件不重复。
> 纯 JS/TS 逻辑不要读本文件。

---

## 跟仓库，不另起炉灶

- 预处理器、CSS Modules、工具类（如 Tailwind）、CSS-in-JS 跟随已有代码；不要为这一次改动引入另一种写法
- 类名约定跟随仓库（BEM、camelCase modules、工具类等）；同一模块不混两套
- 颜色、间距、字号、圆角、阴影优先用已有 token / CSS 变量 / 主题；没有时复用邻近同类值，不要发明新色板
- `z-index` 跟已有分层；禁止随手 `9999` / `99999`

---

## 选择器与层叠

- 选择器写到能唯一定位即可，不要靠堆祖先提高权重
- 禁止无说明的 `!important`；覆盖第三方样式时必须在旁注释原因
- 不要用全局标签选择器（`div`、`span`、`p`、`a` 等）污染业务样式；重置/normalize 文件除外
- 避免新增 `#id` 选择器提高权重，除非仓库已有此模式
- 不要用样式隐藏业务逻辑（例如靠 `display:none` 代替权限/路由状态）

---

## 嵌套（SCSS / Less）

- 嵌套深度 ≤ 3；超过则拆 class 或上提选择器
- 不为「看起来像 DOM」而嵌套；`&` 修饰符跟随仓库已有写法
- 变量、mixin、placeholder 复用仓库已有；不要新建一套设计系统

---

## 兼容

- 目标浏览器跟仓库（`.browserslistrc`、`package.json` 的 `browserslist`、构建配置或已有 CSS）。没有声明时跟随现有写法，不要按「最新 Chrome」写
- 新特性（`:has`、容器查询、`color-mix`、subgrid、锚点定位等）先确认目标环境都支持；不支持则给等价回退，或用 `@supports` 包起来
- 厂商前缀交给仓库已有的 Autoprefixer / PostCSS；不要手写一长串 `-webkit-`，除非现有代码就是手写且这次必须对齐
- 不要为已不在目标里的浏览器加 hack（如 IE）；目标里仍有则跟仓库已有 workaround，不要另发明一套
- 能用 CSS 回退解决的差异不要用 JS 补样式

---

## 禁止事项

- ❌ 禁止把关键布局写成大量内联 `style`（组件库 API 要求的动态值除外）
- ❌ 禁止复制大段第三方 CSS 进业务文件；覆盖用局部、更高优先级选择器或约定好的分层
- ❌ 禁止在样式里写死仅某一种主题能看清的对比（有暗色/亮色时两边都要能用）
- ❌ 禁止新增全局 `*` 或 `!important` 作为默认手段
- ❌ 禁止只用最新浏览器看过就声称样式完成（项目声明了多浏览器 / WebView 时）

动效属性、`prefers-reduced-motion` 以 `web-design-guidelines` 为准。
