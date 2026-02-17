# 前端组件使用规范（小R角基线）

版本：v1.0
更新时间：2026-02-06

## 1. 卡片 Card

推荐：

```html
<div class="card mt-12">
  <div class="card-k">标题</div>
  <div class="card-v">数值</div>
  <div class="muted mt-6">说明</div>
</div>
```

禁止：

```html
<div class="card" style="margin-top: 12px; border-radius: 12px;">
```

说明：

- 外间距使用工具类 `mt-*`。
- 不允许单独把卡片圆角改为 `8/10/12/16`。

## 2. 表单 Form

推荐：

```html
<form class="stack mt-10">
  <label>标题
    <input />
  </label>
</form>
```

```html
<input class="review-count-input" type="number" />
```

禁止：

```html
<form class="stack" style="margin-top: 10px;">
<input style="max-width: 120px;">
```

## 3. 按钮 Button

推荐：

```html
<div class="actions mt-12">
  <button class="btn primary">保存</button>
  <a class="btn" href="#">取消</a>
</div>
```

规则：

- 手机端按钮最小触控高度 44px。
- 评分按钮使用 `.review-rating-grid`，手机端固定 2 列。

## 4. 表格 Table

推荐：

```html
<table class="worksheet-table">
  <thead>
    <tr>
      <th class="table-col-44">#</th>
      <th class="table-col-28">单词</th>
      <th>释义</th>
    </tr>
  </thead>
</table>
```

禁止：

```html
<th style="width: 44px;">
```

## 5. Overlay / Loading

推荐：

```html
<div class="overlay hidden" id="loadingOverlay">
  <div class="card overlay-card overlay-foreground">
    <div class="row m-0">
      <div class="spinner"></div>
      <div>
        <div class="big overlay-title">生成中...</div>
      </div>
    </div>
  </div>
</div>
```

规则：

- 遮罩层 z-index 必须高于 topbar。
- 不允许 `backdrop-filter`。

## 6. 图表容器 Analytics

推荐：

```html
<section class="analytics-panel">
  <header class="analytics-panel-h">活跃趋势</header>
  <div class="analytics-chart" data-chart="trend"></div>
</section>
```

仅允许动态内联样式：

```html
<div class="analytics-rank-bar-fill" style="width: {{ u.bar }}%"></div>
<td class="analytics-heat-cell" style="--heat: {{ heat }}"></td>
```

禁止：

- 在标题中使用 emoji。
- 固定布局参数写死在模板内（应转到 CSS/JS 断点逻辑）。

## 7. 文本展示块

推荐：

```html
<div class="muted answer-chapter">章节：...</div>
<div class="example answer-example">例句...</div>
<div class="muted answer-meta">正确/错误：...</div>
```

## 8. 响应式注意事项

- 顶层卡片 full-bleed 仅作用于 `.container` 直接子级。
- 嵌套卡片（如 `details`、白纸容器内）禁止使用全局负边距规则。
- 图表页面在手机端要降低左侧标签预留宽度（由 JS 自适应处理）。

## 9. 可复用检查命令

```powershell
rg -n "style=" app/templates --glob "*.html"
rg -n "backdrop-filter" app/static/app.css
rg -n "review-rating-grid \{ gap: 8px" app/static/app.css
rg -n "analytics-grid\.three\.analytics-learning-grid" app/static/app.css
```
