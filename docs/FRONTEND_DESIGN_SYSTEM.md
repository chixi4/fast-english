# 前端设计系统规范（小R角基线）

版本：v1.0
更新时间：2026-02-06
适用范围：`app/templates/*.html`、`app/static/app.css`、`app/static/analytics_dashboard.js`

## 1. 目标与原则

本规范用于统一全站用户页（自学、家长、analytics）视觉风格，控制样式可维护性，消除移动端错位。

核心原则：

1. 扁平优先：不使用玻璃态和模糊背景。
2. 小R角统一：常规圆角仅使用 `0` 与 `4px`。
3. 响应式优先：手机端默认单列，避免横向滚动。
4. 组件复用：模板中避免重复内联样式，统一走 CSS 类。

## 2. 设计 Token

定义位置：`app/static/app.css:1`

- 颜色 Token
  - `--bg`: 页面底色
  - `--panel`: 面板底色
  - `--text`: 主文本
  - `--muted`: 次文本
  - `--border`: 边框
  - `--divider`: 分隔条
  - `--primary`, `--danger`, `--ok`, `--warn`, `--easy`
- 圆角 Token
  - `--radius-sm`: 常规圆角（4px）
  - `--radius-pill`: 胶囊圆角（999px）

## 3. 圆角与面板约束

- 常规组件（卡片、输入、按钮、表格块）使用 `var(--radius-sm)`。
- 胶囊组件（徽标点、进度条端点）使用 `var(--radius-pill)`。
- 禁止新增 `border-radius > 4px`（`999px` 胶囊例外）。
- 禁止新增 `backdrop-filter` / `-webkit-backdrop-filter`。

## 4. 布局与断点

断点：

- 手机：`<=640`
- 平板：`641-1024`
- 桌面：`>=1025`

手机端规则：

- 卡片单列。
- 顶层卡片允许 full-bleed；嵌套卡片禁止被负边距拉出容器。
- 评分按钮网格为 2 列，触控区域不少于 44px 高。

## 5. 文案与视觉语气

- 页面主标题、模块标题不使用 emoji。
- 指标卡标题不拼接图标字段，使用纯文本 label。
- 警告/错误信息由颜色和文案表达，不用装饰性符号前缀。

## 6. 内联样式策略

允许场景（白名单）：

- 仅数据驱动且无法类化的动态值，例如：
  - 柱状高度
  - 进度宽度
  - 热力值变量

禁止场景：

- 固定间距、固定字号、固定宽度、display 切换等可由类承载的样式。

## 7. 组件与工具类最小集

通用工具类（定义在 `app/static/app.css` 顶部）：

- 间距：`m-0`, `mt-4`, `mt-6`, `mt-8`, `mt-10`, `mt-12`, `mt-14`, `mt-16`, `mb-16`
- 宽度：`w-full`
- 字号：`fs-12`
- 可见性：`hidden`

语义类：

- `review-count-input`
- `overlay-title`
- `answer-chapter`, `answer-example`, `answer-meta`
- `table-col-44`, `table-col-28`, `table-col-48`
- `analytics-chart-fallback`

## 8. 代码审查检查单

每次样式改动需通过以下检查：

1. `rg -n "style=" app/templates --glob "*.html"` 仅剩白名单场景。
2. `rg -n "backdrop-filter" app/static/app.css` 结果为空。
3. `rg -n "border-radius:\s*[0-9]+px" app/static/app.css` 不出现 >4 的固定值。
4. 手机视口 `640/414/390/375/360` 下无页面级横向滚动。
5. `/review` 与 `/simulations/{id}/retest` 评分按钮在手机端为 2 列。

## 9. 兼容性声明

- 不改后端 API、路由、数据结构。
- 不引入新前端框架，保留 HTMX + Jinja 架构。
- analytics 数据逻辑不变，仅调整呈现层样式和响应式策略。
