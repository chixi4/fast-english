# 实战短文 v2：自动选词 + 更长短文 + 更稳的题目质量（实现计划书）

> 背景：当前 `/mistakes` → 勾选错词 → `/simulations/generate` 的流程需要用户手动挑词；当词数过多或词之间语义不相关时，AI 生成短文会变得“硬塞词/套路化/短且泛”。本计划书以“考试迁移 + 可持续练习”为目标，给出一套**自动选词（可调用AI）**与**长度/题量自适应**的实现方案，并兼顾成本、稳定性与可解释性。

---

## 1. 目标与非目标

### 1.1 目标（必须）
1) **无需手动选词**：用户点一次“自动生成”，系统自动从错词池中挑出一组更适合写成同主题短文的词。
2) **控制约束强度**：避免“选太多词导致文章只能写那几种套路”。默认限制目标词数量，并能在不相关时自动降级（减少词数/分组）。
3) **短文更长、更像真题**：不同难度对应更合理的篇幅与题量，并且“目标词出现”要有上下文线索，而不是点名。
4) **可解释**：用户能看到系统为什么选这些词（主题/理由），并允许一键微调（删掉某个词再生成）。
5) **稳**：AI 输出不稳定时有可控的 fallback（不影响用户继续练习）。

### 1.2 非目标（暂不做）
- 不做账号、多端同步、云端词库。
- 不做真正的“真题级判题器/阅卷器”（先保证生成质量与练习闭环）。
- 不引入大型向量检索/embedding 基础设施（可作为后续优化）。

---

## 2. 第一性原理：为什么“词数多 + 不相关”会让效果变差

### 2.1 约束强度与可读性是此消彼长
生成短文等价于同时满足：
- 目标词必须出现（硬约束）
- 语义连贯、体裁合理、可出题（软约束）

当目标词数量 K 上升、且彼此无共同主题时，模型为了“塞进去”会被迫使用：
- 列表式罗列 / 跳跃式换话题
- 抽象且泛化的“万能模板段落”
- 低信息密度（为了容纳词而牺牲逻辑）

### 2.2 每个目标词需要“上下文预算”
要训练“在语境中解题”，目标词不是出现一次就够了，而应当在附近提供：
- 同义改写/反义对照
- 例证/因果/转折
- 代词指代与信息链

经验上可以把它当作一个预算问题：**每个目标词至少需要 ~25–40 个词的上下文空间**来提供线索并保持自然。
因此短文长度 L 与目标词数量 K 应满足：
- `L ≳ K * 30`（粗略经验式）

结论：**想写更长、更像真题的短文，不是无限加词，而是让 K 与 L 成比例，并优先挑“能写成同一主题”的词**。

---

## 3. 默认参数建议（先给出可用的“产品默认值”）

> 关键是让用户“默认就好用”，同时允许高级用户调参。

### 3.1 每次练习选多少个目标词（K）
建议默认（可在设置页调整）：
- `junior`: 8
- `senior`: 9
- `cet4`: 10
- `cet6`: 10
- `kaoyan`: 12（上限更高但默认仍保守）

建议硬上限：
- `K_max = 12~14`（超过就提示“会变硬塞词”，默认自动拆分为多篇或自动减少）

> 参考：一些“带指定词生成阅读材料”的产品会把“挑战词”限制在 10 个以内（作为体验与可读性的折中）。

### 3.2 短文长度（L）与题量（Q）
建议把长度作为“目标范围”，并让系统按 K 自适应：
- `L_target = max(L_level_min, K * 30)`
- `L_range = [L_target - 10%, L_target + 15%]`

建议起步的 `L_level_min`（比当前更长）：
- `junior`: 220
- `senior`: 300
- `cet4`: 360
- `cet6`: 480
- `kaoyan`: 600

题量 Q 建议：
- `Q = clamp(6, 10, round(L_target / 60))`
- 题型比例（MVP）：
  - 50%：vocab_in_context / cloze（但不要求每个词都出题）
  - 50%：main_idea / detail / inference

> 参考：TOEFL 阅读通常为约 700 词、每篇 10 题；CET4 的阅读材料在一些研究统计中约 333–367 词区间（不同卷/不同研究口径会有差异）。

---

## 4. 自动选词：系统应该怎么“帮你挑一组更好写的词”

### 4.1 候选池（Candidate Pool）
默认从“错词池”取，按“对学习最有价值”排序并去重：
- 最近 N 条 Mistake（例如 N=200），按 word_id 去重，只保留每个词最近一次错误时间
- 每个候选词附带特征：
  - `term`
  - `definition`（作为语义线索）
  - `wrong_count / correct_count`
  - `last_mistake_at`（可从 Mistake 推）
  - `tags / deck`（如有）
  - `recently_used_in_simulation`（防重复）

### 4.2 选词要解决的 2 个目标
1) **学习收益最大**：优先挑“更常错/更近期错”的词
2) **生成质量更高**：尽量挑“能写成同主题”的一组词

这两者会冲突，因此推荐采用 **Hybrid：先用规则缩小候选，再用AI做主题一致性选择**。

---

## 5. 选词算法（MVP 可落地）

### 5.1 阶段 A：规则筛选（不调用AI，便宜且稳定）
1) 去重：按 term 大小写不敏感去重
2) 排序打分（示例）：
   - `score = 0.55 * recency + 0.35 * wrongness + 0.10 * novelty`
   - `recency`：距离最近错误越近越高（指数衰减）
   - `wrongness`：wrong_count 越高越高（log/归一化）
   - `novelty`：最近 X 次 simulation 用过则扣分
3) 取 Top M（M=40~80）作为 AI 候选输入

> 这一步的意义：减少 token 开销，同时提高AI“挑出可写同主题词组”的成功率。

### 5.2 阶段 B：AI 选词（调用一次AI）
让AI做一件事：**从候选池里挑 K 个，并给出主题与理由**（只输出 JSON）。

建议输出 schema：
```json
{
  "topic": "string",
  "genre": "news|narrative|science|opinion|email",
  "target_count": 10,
  "selected": [
    {"word_id": 123, "term": "vocabulary", "reason": "..." }
  ],
  "notes": "string"
}
```

选词提示词要包含硬约束：
- 必须只从提供的候选里选
- 尽量选语义相关、可写成同主题
- 优先高错词（给出“为什么选它”的一句话理由）
- 如果无法凑够 K 个“同主题”词：允许返回更小的 `target_count`

### 5.3 阶段 C：生成短文与出题（调用一次AI）
把 selector 输出的 `topic/genre/selected terms` 作为 writer 的强引导：
- 体裁/话题从“自动”变成“可控”，能显著减少“万能模板”
- 让 writer 根据 `L_target` 生成更长短文，并要求每个目标词的附近出现语境线索

---

## 6. 失败策略（必须做，否则体验崩）

### 6.1 AI 选词失败（selector 失败）
Fallback 顺序：
1) 不调用 selector：直接用 Top-K（按规则打分）生成
2) 若仍失败：降低 K（例如 K→K-2，最低到 6）再生成
3) 仍失败：提示用户“词过于不相关/太生僻”，建议换难度或减少词数

### 6.2 生成短文失败（writer 漏词/JSON坏）
当前已有：
- JSON 解析校验
- 漏词检查与重试
- 最后兜底：把漏词补到 passage 末尾（保证用户可继续）

建议新增：
- 若连续失败：自动降低 K 或改 genre（news→narrative 等）再试

---

## 7. 交互设计（新手友好 + 可控）

### 7.1 `/mistakes` 页面（错词强化）
新增“自动生成”模式，保留“手动勾选”：
- 默认选项：`自动选词（推荐）`
- 控件（尽量少）：
  - 难度 level（已有）
  - 本次目标词数量 K（默认跟随难度）
  - 生成长度：标准/更长（可选，默认标准）
- 生成按钮：
  - `自动选词并生成`
  -（可选）`先自动选词（预览）` → 展示系统选了哪些词，允许删掉 1~2 个再生成

### 7.2 `/simulations/{id}` 页面
展示“这次练习的配置”：
- 主题/体裁（如果有）
- 目标词列表（已存在）
- 长度与题量（可选展示）
- 一键操作：
  - `换一篇同主题（保留词）`
  - `减少词数重来`
  - `换体裁重来`

---

## 8. 技术落地：后端接口与数据

### 8.1 API 改造建议
1) 扩展 `/simulations/generate`
- 允许 `word_ids` 为空（走自动模式）
- 新增参数：
  - `mode = manual|auto`（默认 auto）
  - `target_count`（可选）
  - `length_mode = standard|long`（可选）

2) 可选新增 `/simulations/auto_select`
- 仅做“选词”，返回 JSON，用于前端预览（HTMX/Fetch）

### 8.2 数据存储（最小可用）
当前 `Simulation` 已有 `target_terms_json / passage / questions_json`。
建议新增一个可选字段（或新增表）用于 debug 与复盘：
- `Simulation.meta_json`（JSON，存 selector 输出、L_target、K、Q、genre、topic、模型名等）

> 这样你能解释“为什么选了这些词”，也能复现实验与排查失败。

---

## 9. Prompt 设计要点（让文章变长且更像真题）

### 9.1 Writer Prompt 的关键改造
新增硬约束：
- 明确 `word_count` 目标区间（按 L_range）
- 明确 `paragraph_count`（例如 4~7 段）
- 明确“每个目标词周围要提供语境线索”（举例说明 1~2 个）
- 引入 `topic/genre`（来自 selector）
- 题目分布：vocab/cloze 与阅读理解比例

### 9.2 让输出不那么“千篇一律”
给 writer 一个“可切换模板库”（无需复杂）：
- news report
- science explainer
- opinion short essay
- narrative story
- email / notice

selector 输出 `genre`，writer 按 genre 选择对应模板（或在 prompt 里直接指定）。

---

## 10. 分阶段实施（PR 拆分）

### PR-1（1~2天）：自动选词（规则版）+ 解除必须手动勾选
- `/simulations/generate` 支持 `word_ids` 为空
- 后端：用“Top-K 最近/常错错词”自动挑词
- 前端：`mistakes.html` 增加 `mode=auto`、`target_count`，默认自动

验收：
- 不勾选也能生成
- 默认 K 有上限、不会一次塞 30 个词

### PR-2（2~4天）：AI 选词（主题一致性）+ 选词预览
- 新增 selector prompt（一次AI调用）
- 可选新增 `/simulations/auto_select`（预览）
- 生成时把 selector 的 `topic/genre` 传给 writer
- Simulation 存 `meta_json`（可选）

验收：
- 套路化明显降低，“短文更像围绕一个主题”
- 失败可 fallback 到规则版

### PR-3（1~2天）：长度与题量自适应 + 文章更长
- 更新 `LEVEL_GUIDE` 与 writer prompt：引入 L_target/Q 逻辑
- 题量 Q 不再写死 6
- UI 增加“标准/更长”（可选）

验收：
- CET4/CET6/考研短文明显更长
- 题量随长度变化但不过载（6~10）

### PR-4（可选）：多篇拆分（当词太多/太不相关）
- 当用户要求 K>12 或 selector 返回“无法同主题凑够”
- 自动拆分 2 篇短文（同一批次），并在 UI 里表现为“练习套组”

---

## 11. 测试与质量评估（MVP 可做的）

### 11.1 自动检查（必须）
- 目标词覆盖检查（已有）
- JSON schema 校验（已有）
- 题目字段完整性（choices=4、answer_index 范围等）

### 11.2 体验指标（建议记录到 meta_json）
- selector 是否启用、耗时
- writer 是否重试、最终长度（词数）
- 覆盖失败次数、fallback 次数
- 用户练习完成率（可先不做埋点，仅日志）

---

## 12. 参考与链接（用于校准参数）

> 用于校准“阅读材料篇幅/题量”与“挑战词数量上限”的现实约束；不同考试/不同版本会有差异，本项目以“可用且可解释”为准。

- ETS（TOEFL Reading）：每篇阅读约 700 词、通常 10 题  
  https://www.ets.org/toefl/test-takers/ibt/about/content/reading.html
- Microsoft Learn（Reading Progress：练习材料生成，Practice words 最多 10 个）  
  https://learn.microsoft.com/en-us/education/teams/assignments/reading-progress-passage-generator
- 关于 CET4 阅读材料词数的统计研究（示例）  
  https://www.researchgate.net/publication/383653365_A_Research_on_Content_Validity_of_CET-4_Reading_Comprehension_---_Based_on_Test_Task_Characteristics_Framework
