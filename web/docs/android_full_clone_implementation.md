# 安卓原项目网页完整复刻实现文档

## 一 目标范围
本次实现以安卓源码行为作为唯一基准，目标不是只把页面做得像，而是把状态流转、功能边界、数据副作用和关键交互全部对齐到同一套规则。执行范围覆盖学习、查词、词库、我的、实验室、学习数据、今日新词选择，以及与这些页面相关的存储和调度逻辑。

执行日期为 2026-02-23。

## 二 原项目功能总表与当前核对结果

| 模块 | 功能点 | 安卓依据 | 网页状态 |
| --- | --- | --- | --- |
| 学习 | 认词模式三档评分与 SM-2 调度 | `app/src/main/java/com/kaoyan/wordhelper/ui/viewmodel/LearningViewModel.kt` | 已实现 |
| 学习 | 拼写模式三次失败后抄写继续 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt` | 已实现 |
| 学习 | 左滑太简单 右滑加生词本 与撤销 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt` | 已实现 |
| 学习 | 生词本下 认识并移出确认弹窗 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:292` | 已实现 |
| 学习 | 词库页点拼写测试后进入学习页拼写模式 | `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:132` | 已补齐 |
| 学习 | V4 响应耗时降级阈值支持动态计算 | `app/src/main/java/com/kaoyan/wordhelper/ui/viewmodel/LearningViewModel.kt:216` | 已补齐 |
| 学习 | ML 开关开启后写训练样本并参与调度微调 | `app/src/main/java/com/kaoyan/wordhelper/ui/viewmodel/LearningViewModel.kt:329` `app/src/main/java/com/kaoyan/wordhelper/data/repository/WordRepository.kt:364` | 已补齐 |
| 查词 | 普通查词结果与详情页 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt` | 已实现 |
| 查词 | 长句超 20 字符自动解析 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt` | 已实现 |
| 查词 | 当前词书是生词本时改为全库搜索 | `app/src/main/java/com/kaoyan/wordhelper/ui/viewmodel/SearchViewModel.kt:110` | 已补齐 |
| 词库 | 词书导入预览与确认导入 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt` | 已实现 |
| 词库 | 删除词书确认弹窗 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:129` | 已实现 |
| 词库 | 清空生词本确认弹窗 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:205` | 已补齐 |
| 词库 | 提前复习批量选择 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt` | 已实现 |
| 词库 | 今日新词自主选择 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/TodayNewWordsSelectScreen.kt` | 已实现 |
| 词库 | 今日新词计划按四点学习日写入日期 | `app/src/main/java/com/kaoyan/wordhelper/data/repository/SettingsRepository.kt:161` | 已补齐 |
| 我的 | 学习统计卡含一周趋势图 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/ProfileScreen.kt` | 已实现 |
| 我的 | 学习统计卡含日历热力图 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/ProfileScreen.kt:275` | 已补齐 |
| 我的 | 数据恢复前确认弹窗 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/ProfileScreen.kt:125` | 已补齐 |
| 实验室 | AI 成本提示弹窗 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/AILabScreen.kt:81` | 已补齐 |
| 实验室 | 隐私与风险说明弹窗 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/AILabScreen.kt:101` | 已补齐 |
| 实验室 | 算法 V4 开启后修复历史已掌握状态 | `app/src/main/java/com/kaoyan/wordhelper/ui/viewmodel/AILabViewModel.kt:89` | 已补齐 |
| 学习数据 | 未来 7 天预测来源与耗时标签 | `app/src/main/java/com/kaoyan/wordhelper/ui/viewmodel/StatsViewModel.kt:463` | 已补齐 |
| 学习数据 | 历史热力图与未来模式切换 | `app/src/main/java/com/kaoyan/wordhelper/ui/screen/StatsScreen.kt` | 已实现 |

## 三 执行前差距清单

执行前确认的差距一共九项，按照影响优先级从高到低如下。

| 优先级 | 差距项 | 风险 |
| --- | --- | --- |
| P0 | ML 开关仅停留在界面，未进入学习流程 | 开关形同虚设，调度与安卓行为不一致 |
| P0 | 词库页拼写测试不切拼写模式 | 跨页主流程不一致 |
| P0 | 生词本作为当前词书时查词范围错误 | 查词结果缺失，误导用户 |
| P1 | V4 开关未触发历史已掌握修复 | 状态污染会持续影响后续学习 |
| P1 | 今日新词计划日期写入未按四点学习日 | 次日凌晨会出现计划错位 |
| P1 | 我的页统计卡缺少热力图 | 页面信息层级与安卓不一致 |
| P1 | 数据恢复缺少二次确认 | 存在误操作覆盖数据风险 |
| P2 | 实验室缺少成本与隐私说明弹窗 | 风险提示链路不完整 |
| P2 | 学习数据未来模式来源与耗时固定文案 | 与安卓实时标签不一致 |

## 四 任务拆分与验收标准

### 4.1 主流程一致性任务
1. 学习模式跨页状态改造，词库拼写测试进入学习页时强制切到拼写模式。
2. 查词范围改造，当前词书是生词本时改为全库检索。
3. 今日新词计划写入规则改为四点学习日。

验收标准是三条路径都可以稳定复现，不会在刷新或重复进入后失效。

### 4.2 调度与状态一致性任务
1. 算法 V4 开启时执行历史已掌握修复。
2. ML 接入学习流程，包括训练样本写入、个体阈值计算、间隔微调。
3. 未来预测标签改为缓存命中或实时计算，并显示真实耗时。

验收标准是开关行为可观察，数据能持续累积，调度结果会随开关变化。

### 4.3 页面与交互一致性任务
1. 我的页学习统计卡补齐热力图。
2. 数据恢复增加确认弹窗。
3. 实验室增加成本提示和隐私说明弹窗。
4. 词库页清空生词本改为确认后执行。

验收标准是弹窗文案、触发路径和确认动作与安卓一致。

## 五 已执行改造记录

### 5.1 已改动文件
- `web/src/App.tsx`
- `web/src/state/appStore.ts`
- `web/src/utils/mlAdaptive.ts`
- `web/docs/android_full_clone_implementation.md`

### 5.2 关键改造内容
1. 新增学习模式跨页同步，词库页拼写测试会进入学习页拼写模式。
2. 查词页在生词本场景下改为全库搜索。
3. 学习页接入 ML 训练和调度微调逻辑，包含特征提取、遗忘概率估计、自适应间隔和个体响应阈值。
4. 算法 V4 开关接入历史已掌握修复逻辑。
5. 今日新词计划写入日期改为 `currentLearningDate` 规则。
6. 我的页统计卡增加日历热力图。
7. 数据恢复改为先选择文件再确认恢复。
8. 实验室补齐成本提示和隐私说明弹窗。
9. 学习数据未来模式改为展示真实来源与耗时标签。
10. 词库页清空生词本改为确认后执行。

### 5.3 代码落点索引
- 学习模式跨页同步 `web/src/App.tsx:187` `web/src/App.tsx:241`
- 查词范围修复 `web/src/App.tsx:1586`
- ML 接入与动态阈值 `web/src/App.tsx:510` `web/src/App.tsx:538` `web/src/App.tsx:629` `web/src/App.tsx:853` `web/src/utils/mlAdaptive.ts:54`
- V4 修复 `web/src/state/appStore.ts:350` `web/src/state/appStore.ts:541`
- 今日新词日期 `web/src/state/appStore.ts:764`
- 我的页热力图与恢复确认 `web/src/App.tsx:2469` `web/src/App.tsx:2574`
- 实验室风险弹窗 `web/src/App.tsx:2590` `web/src/App.tsx:2838`
- 预测来源与耗时 `web/src/App.tsx:2998` `web/src/App.tsx:3132`
- 清空生词本确认 `web/src/App.tsx:2144` `web/src/App.tsx:2190`

## 六 回归与核验流程

执行顺序如下。

1. 运行用户流回归脚本，覆盖学习 查词 词库 我的 实验室等关键路径。
2. 运行网页截图采集与对比脚本，持续写入 `web/screenshot_compare`。
3. 对照安卓截图做人眼复核，记录差异并回写文档。

当前仓库中的截图对比报告显示安卓截图仍缺失，状态为 `MISSING_ANDROID`，因此自动对比只能先完成网页侧产出，安卓侧还需补齐后才能得到像素级结论。

## 七 本轮执行结果

### 7.1 自动化回归结果
- 执行命令 `npm run -s build`，编译通过。
- 执行命令 `npm run -s qa:user-flow`，结果 `9/9` 通过，报告文件为 `web/screenshot_compare/report/user_flow_qa_2026-02-23.json`。
- 执行命令 `npm run -s screenshot:web`，网页截图全部生成，目录为 `web/screenshot_compare/web`。
- 执行命令 `npm run -s screenshot:compare`，结果为一致 `0` 差异 `0` 缺少安卓 `17` 缺少网页 `0`。

## 八 当前结论
本轮文档中的九项核心差距已全部落地，网页与安卓在关键状态流、调度开关、副作用和主要页面交互上已经完成一轮系统性对齐，后续只需继续按截图对比结果做细节收敛。

## 九 52 个可见功能点逐项实测

### 9.1 执行日期与命令
- 执行日期 2026-02-23
- 执行命令 `npm run -s qa:visible52`

### 9.2 报告位置
- `web/screenshot_compare/report/visible_52_qa_2026-02-23.json`

### 9.3 结果汇总
- 总数 52
- 通过 52
- 失败 0

### 9.4 本次实测对脚本做的修正
- 将提前复习弹窗内的清空按钮定位收紧到对应弹窗容器，避免误点页面同名按钮。
- 将今日新词确认按钮定位收紧到今日新词页面顶部操作区，避免被跨页面同名元素干扰。
- 增加今日新词页面残留状态的兜底返回，保证后续实验室检查在正确页面执行。

## 十 52 点截图与视觉审阅执行状态

### 10.1 本轮新增脚本与命令
- 网页 52 点截图 `npm run -s screenshot:web:visible52`
- 安卓 52 点截图 `npm run -s screenshot:android:visible52`
- 52 点截图对比 `npm run -s screenshot:compare:visible52`

### 10.2 本轮实际执行结果
- 已执行 `npm run -s screenshot:web:visible52`，网页侧 52 张截图全部生成，目录 `web/screenshot_compare/web_visible52`。
- 已执行 `npm run -s screenshot:compare:visible52`，结果为一致 `0` 差异 `0` 缺少安卓 `52` 缺少网页 `0`。
- 已执行 `npm run -s screenshot:android:visible52`，当前机器返回 未检测到在线安卓设备，故本轮无法产出安卓侧 52 张截图。

### 10.3 结果文件
- 52 点功能清单 `web/screenshot_compare/visible52_features.json`
- 52 点对比总表 `web/screenshot_compare/report/compare_visible52_summary.json`
- 52 点对比明细 `web/screenshot_compare/report/compare_visible52_summary.md`
- 52 点视觉复核表 `web/screenshot_compare/report/visual_review_visible52.md`

## 十一 安卓自动采集稳定性修复与最新结果

### 11.1 本轮脚本修复
- 文件 `web/scripts/captureAndroidVisible52Auto.mjs`
- 修复项一：增加前台包名守卫，截图前强制校验包名为 `com.kaoyan.wordhelper`。
- 修复项二：`screencap` 使用二进制读取，避免 PNG 编码损坏。
- 修复项三：增加键盘可见性检测，跨标签切换前先收起键盘，避免点击落到输入法区域。
- 修复项四：查词结果进入详情改为按结果列表区域定位点击，避免误点输入框文本。
- 修复项五：词库目标词书切换增加多策略点击和重试，减少停留在错误词书状态。
- 修复项六：为关键步骤增加页面文本校验，防止误判 PASS。

### 11.2 最新自动采集结果
- 执行日期 2026-02-23
- 命令 `npm run -s screenshot:android:visible52:auto`
- 报告文件 `web/screenshot_compare/report/android_visible52_auto_report_2026-02-23.json`
- 结果汇总 总数 52，通过 46，失败 6

失败点如下。

| 序号 | 功能点 | 失败原因 |
| --- | --- | --- |
| 13 | 复习时间弹窗可打开 | 步骤 13 页面校验失败 |
| 19 | 切换到拼写模式成功 | 步骤 19 页面校验失败 |
| 21 | 首字母提示可展开 | 步骤 21 页面校验失败 |
| 22 | 长度提示可展开 | 步骤 22 页面校验失败 |
| 24 | 三次错误进入抄写阶段 | 步骤 24 页面校验失败 |
| 50 | 数据恢复确认弹窗可打开并取消 | 未打开数据恢复确认弹窗 |

### 11.3 最新截图对比结果
- 执行命令 `npm run -s screenshot:compare:visible52`
- 报告文件 `web/screenshot_compare/report/compare_visible52_summary.json`
- 面板目录 `web/screenshot_compare/report/panels_visible52`
- 结果汇总 一致 0，差异 52，缺少安卓 0，缺少网页 0

### 11.4 当前结论
安卓截图采集已恢复到 52 张完整可读，并且已彻底消除误截到其他应用的问题。剩余问题集中在六个功能点的步骤状态校验和数据恢复系统页交互，这六项不会再污染其他 46 项截图质量。

## 十二 阶段一链路归位增量执行 2026-02-23

### 12.1 本次改动文件
- `web/scripts/qaVisible52.mjs`
- `web/docs/android_perfect_clone_refactor.md`
- `web/docs/android_full_clone_implementation.md`

### 12.2 本次改动目的
本次改造只处理功能页错位，不改视觉样式，目标是把 46、49、51、52 四个点的网页截图页面状态与安卓页面状态对齐，避免截图在检查结束时落到返回页。

### 12.3 本次改动内容
1. 为 52 点检查框架新增 `cleanupAfterCapture` 收尾钩子，固定在截图之后执行返回动作。
2. 49 号点把返回操作移到截图后执行，确保截图落在学习数据页。
3. 51 号点把确认使用动作移到截图后执行，确保截图落在今日新词选择页。
4. 52 号点把返回操作移到截图后执行，确保截图落在实验室页。

### 12.4 本次执行命令与结果
1. 执行 `npm run -s screenshot:web:visible52`，结果为 52 通过 0 失败，报告文件 `web/screenshot_compare/report/visible_52_qa_2026-02-23.json`。
2. 执行 `npm run -s screenshot:compare:visible52`，结果为一致 0 差异 52 缺少安卓 0 缺少网页 0，报告文件 `web/screenshot_compare/report/compare_visible52_summary.json`。
3. 对 `web/screenshot_compare/web_visible52/visible_46.png`、`web/screenshot_compare/web_visible52/visible_49.png`、`web/screenshot_compare/web_visible52/visible_51.png`、`web/screenshot_compare/web_visible52/visible_52.png` 与对应安卓图进行人工复核，四项均已回到同功能同页面。

### 12.5 本次结论
阶段一链路归位目标已经完成，功能页错位由 4 项降为 0 项。当前仍有 52 项视觉差异，后续重构重点转入全局视觉基线与组件细节收口。

## 十三 阶段二视觉收敛增量执行 2026-02-23

### 13.1 本次改动文件
- `web/scripts/qaVisible52.mjs`
- `web/src/App.tsx`
- `web/src/index.css`
- `web/screenshot_compare/report/manual_visual_review_2026-02-23.md`
- `web/docs/android_perfect_clone_refactor.md`
- `web/docs/android_full_clone_implementation.md`

### 13.2 本次改动目的
本次改动目标不是新增功能，而是把已实现功能的页面状态和视觉结构进一步向安卓收拢，重点处理学习数据页状态口径、详情弹层形态、确认弹窗形态和关键页面对象命中。

### 13.3 本次改动内容
1. `qaVisible52` 的视觉基线数据改造  
   - 将预置复习时间从近两天改为远期，避免未来 7 天压力柱异常抬高。  
   - 调整今日拼写统计基线，移除高值认词预置。  
2. 学习数据页截图口径改造  
   - 新增截图前统计归一逻辑，将当日手势统计和今日认词归零。  
   - 在完成未来模式功能验证后，切回历史模式再截图，保持与安卓截图状态一致。  
3. 弹窗系统改造  
   - `Dialog` 增加确认型变体，用于清空生词本确认弹窗。  
   - `Dialog` 增加抽屉型变体，用于查词详情与词书详情，改为底部抽屉结构。  
4. 页面文案与层级改造  
   - 我的页补回顶层标题 `我的`。  
   - 今日新词页输入框占位文案改为 `搜索词条`。  
   - 学习页主词字号上调。  
   - 正文基础字号调整为 16px，认词操作按钮最小触控高度调整为 44px。  
5. 截图对象一致性改造  
   - 查词详情固定命中 `abandonment`。  
   - 词书详情固定命中 `完整词库`。  

### 13.4 本次执行命令与结果
1. 执行 `npm run -s screenshot:web:visible52`，结果为 52 通过 0 失败，报告文件 `web/screenshot_compare/report/visible_52_qa_2026-02-23.json`。  
2. 执行 `npm run -s screenshot:compare:visible52`，结果为一致 0 差异 52 缺少安卓 0 缺少网页 0，报告文件 `web/screenshot_compare/report/compare_visible52_summary.json`。  
3. 人工视觉审阅重点编号 `01`、`31`、`38`、`44`、`48`、`49`、`51`、`52`，审阅记录写入 `web/screenshot_compare/report/manual_visual_review_2026-02-23.md`。  

### 13.5 本次人工审阅结论
1. 页面对象一致性继续提升，`31` 和 `38` 的目标对象已经与安卓一致。  
2. `49` 已固定为历史模式并回到 0 手势与 0 今日认词，状态口径与安卓一致。  
3. `44` 清空确认窗结构已接近安卓，但按钮与弹窗尺寸还需继续收口。  
4. 主要残留问题已经从对象错位收敛为视觉系统问题，集中在字体、间距、图表风格、控件高度和底栏视觉重量。  

## 十四 阶段二视觉收敛增量执行 2026-02-23 第五轮

### 14.1 本次改动文件
- `web/src/App.tsx`
- `web/src/index.css`
- `web/src/components/charts.tsx`
- `web/screenshot_compare/report/manual_visual_review_2026-02-23.md`
- `web/docs/android_perfect_clone_refactor.md`
- `web/docs/android_full_clone_implementation.md`

### 14.2 本次改动内容
1. 底栏图标尺寸提升到 20，配合底栏内边距和标签文字尺寸微调。  
2. 我的页统计区改为无边框样式，突出大数字信息层级。  
3. 学习页主词字号继续上调，提升与安卓主词占比的一致性。  
4. 学习数据图表线条加粗，坐标字号和网格颜色统一；长周期时隐藏横轴文字，减少拥挤。  
5. 学习数据页记忆曲线改为无图例展示，减少与安卓截图的视觉噪声差异。  
6. 清空生词本确认弹窗继续加宽，收口安卓确认窗比例。  

### 14.3 本次执行命令与结果
1. 执行 `npm run -s screenshot:web:visible52`，结果 52 通过 0 失败。  
2. 执行 `npm run -s screenshot:compare:visible52`，结果一致 0 差异 52 缺少安卓 0 缺少网页 0。  
3. 人工视觉复核编号 `01`、`44`、`48`、`49`，结论写入 `web/screenshot_compare/report/manual_visual_review_2026-02-23.md`。  

### 14.4 本次结论
本轮进一步压低了学习数据页曲线区与确认弹窗的视觉偏差，并持续提升了学习页主词可读性。当前剩余问题仍集中在全局字体字重、局部留白和图表风格细节，需要继续按视觉系统分层收口。  
