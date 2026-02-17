# 前端 UI 审计台账（2026-02-06）

审计范围：全站用户页（自学、家长、analytics）

审计人：Codex

## 1. 问题台账

| ID | 严重级别 | 问题 | 证据 | 修复动作 | 状态 |
|---|---|---|---|---|---|
| U-001 | P0 | analytics 学习区手机端被反向覆盖为三列 | `app/static/app.css:1129`, `app/static/app.css:1153` | 将三列规则限定到 `@media (min-width: 1025px)`，`<=1024` 保持单列 | 已修复 |
| U-002 | P0 | 复习评分按钮手机端仍 4 列 | `app/static/app.css:877`, `app/templates/review.html:99`, `app/templates/simulation_retest.html:50` | 手机断点改为 `repeat(2, minmax(0,1fr))` | 已修复 |
| U-003 | P0 | 全局手机负边距误伤嵌套卡片 | `app/static/app.css:805`, `app/static/app.css:806`, `app/static/app.css:807` | full-bleed 仅作用于顶层卡片（`.container` 直接子级） | 已修复 |
| U-004 | P1 | loading overlay 层级低于 topbar | `app/static/app.css:61`, `app/static/app.css:537` | overlay 提升到 `z-index: 1100` | 已修复 |
| U-005 | P1 | review 计划输入框手机端宽度不一致 | `app/static/app.css:338`, `app/static/app.css:859`, `app/templates/review.html:32` | 新增 `review-count-input`：桌面限宽，手机取消限宽 | 已修复 |
| U-006 | P1 | analytics 页面热度图左边距固定过大 | `app/static/analytics_dashboard.js:666`, `app/static/analytics_dashboard.js:669` | 改为 `pageChartLeft` 按视口自适应（86/104/120） | 已修复 |
| U-007 | P1 | 风格冲突（大圆角/玻璃态 vs 小R角扁平） | `app/static/app.css:200`, `app/static/app.css:201`, `app/static/app.css:938` | 全站收敛到 `--radius-sm`，移除玻璃态和模糊背景 | 已修复 |
| U-008 | P1 | analytics 标题与分区含 emoji | `app/templates/analytics.html:7`, `app/templates/analytics.html:77`, `app/templates/analytics.html:81` | 标题改为纯文本；指标卡去 icon 前缀 | 已修复 |
| U-009 | P2 | 内联样式过多，难维护 | 改造前 111 处；改造后 8 处 | 全量迁移固定样式到类，保留动态白名单 | 已修复 |
| U-010 | P2 | 样式债务：遗留未使用类 | `review-topbar`/`rating-buttons`/`library-item` 在 CSS 存在且无模板引用 | 清理未使用选择器 | 已修复 |
| U-011 | P2 | `body` 内联色值绕过 token | `app/templates/base.html:17` | 删除 `body style=...`，统一走 CSS token | 已修复 |
| U-012 | P2 | `h2` 重复定义 | `app/static/app.css:152`（保留单一定义） | 移除重复 `h2` 规则 | 已修复 |

## 2. 内联样式白名单（仅数据驱动动态值）

当前仅保留 8 处：

1. `app/templates/analytics.html:113` `width: {{ u.bar }}%`
2. `app/templates/analytics.html:184` `--w: {{ r.width }}`
3. `app/templates/analytics.html:225` `--heat: {{ ... }}`
4. `app/templates/analytics.html:228` `--heat: {{ ... }}`
5. `app/templates/analytics.html:231` `--heat: {{ ... }}`
6. `app/templates/analytics.html:234` `--heat: {{ ... }}`
7. `app/templates/analytics.html:237` `--heat: {{ ... }}`
8. `app/templates/dashboard.html:38` `height: {{ pct|round(0) }}%`

说明：以上均为运行时数据映射，属于白名单保留项。

## 3. 回归检查

已执行静态检查：

- `style=` 数量检查：通过（8 处白名单）
- `backdrop-filter` 检查：通过（0 处）
- 固定像素圆角检查：通过（0 处 `border-radius: Npx`）
- 关键规则存在性：通过（评分 2 列、overlay 层级、analytics 学习区断点）

未执行项：

- 浏览器真机截图比对（本次为代码级与静态规则级回归）
- 自动化 UI E2E（仓库暂无现成前端 E2E 用例）

## 4. 后续建议

1. 将 `style=` 白名单校验加入 CI（超过白名单阈值即失败）。
2. 增加 Playwright 手机断点快照回归（`360/375/390/414/640`）。
3. 把 UI 规范链接到 `AGENTS.md` 与 PR 模板，要求改样式必须引用规范。
