# 手机实机52项 逐图视觉与源码审计

执行日期 2026-02-25。审计范围是 `web/screenshot_compare/mobile_live_full52_review/panels` 下 52 张三联图。每条都先做人工视觉读图，再回到安卓源码确认对应功能应当如何落地。

## 汇总结论

- 总项数 52。
- 已实现 24 项。
- 部分实现 3 项。
- 未实现 25 项。
- 当前最大问题不是单页样式差，而是多条步骤链路在网页侧发生状态停滞或跳页，导致截图对象与安卓目标状态错位。

## 逐项明细

### 01 学习 底部标签 学习 可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_01.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_01.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_01_panel.png`。
- 视觉读图结论 安卓与网页都能看到学习标签激活，底栏位置一致，但网页保持深色主题并带浏览器壳，视觉仍明显偏离安卓。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:58` 底部四标签定义
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:79` 底栏点击与选中状态
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:123` 学习页路由入口
- 功能实现判定 已实现。

### 02 学习 底部标签 查词 可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_02.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_02.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_02_panel.png`。
- 视觉读图结论 查词标签在两端都可见，功能点存在，但网页主画布仍是深色和浏览器上下栏，信息密度不同。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:58` 底部四标签定义
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:79` 底栏点击与选中状态
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:123` 学习页路由入口
- 功能实现判定 已实现。

### 03 学习 底部标签 词库 可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_03.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_03.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_03_panel.png`。
- 视觉读图结论 词库标签可见且可激活，位置关系与安卓接近，但网页底栏高度和图标粗细与安卓不一致。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:58` 底部四标签定义
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:79` 底栏点击与选中状态
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:123` 学习页路由入口
- 功能实现判定 已实现。

### 04 学习 底部标签 我的 可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_04.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_04.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_04_panel.png`。
- 视觉读图结论 我的标签可见且激活状态可识别，网页与安卓都存在四个底部标签。差异主要在主题和间距。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:58` 底部四标签定义
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:79` 底栏点击与选中状态
- `app/src/main/java/com/kaoyan/wordhelper/ui/navigation/AppNavigation.kt:123` 学习页路由入口
- 功能实现判定 已实现。

### 05 学习 学习页已加载

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_05.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_05.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_05_panel.png`。
- 视觉读图结论 学习页已经加载成功，但安卓为有词卡状态，网页是暂无单词状态，学习上下文不一致。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- 功能实现判定 已实现。

### 06 学习 认词模式按钮可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_06.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_06.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_06_panel.png`。
- 视觉读图结论 认词模式按钮在两端均可见，点击区域存在。网页与安卓在按钮圆角和边框样式上差异明显。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- 功能实现判定 已实现。

### 07 学习 拼写模式按钮可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_07.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_07.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_07_panel.png`。
- 视觉读图结论 拼写模式按钮可见，分段控件结构对齐，但网页页面仍停在空词态，后续链路受阻。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- 功能实现判定 已实现。

### 08 学习 当前词书信息可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_08.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_08.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_08_panel.png`。
- 视觉读图结论 安卓画面有当前词和学习卡状态信息，网页中心区域是暂无单词，当前词书信息链路缺失。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- 功能实现判定 未实现。
- 当前问题 学习队列和词书上下文没有在截图链路中被正确准备，导致当前词书信息无法稳定渲染。
- 三种可能解决方法
1. 在截图步骤前增加词书和学习队列断言，只有当当前词非空且词书名已渲染时才执行截图。
2. 在网页状态初始化中补齐与安卓一致的默认词书激活逻辑，避免落入空队列。
3. 新增端到端回归用例，先校验词书信息文本再校验词卡内容，阻断空态误截。

### 09 学习 学习进度文本可解析

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_09.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_09.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_09_panel.png`。
- 视觉读图结论 学习进度文本在两端都可读，网页为学习进度 0/0，安卓为 1/9，口径不一致。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- 功能实现判定 已实现。

### 10 学习 认词卡正面可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_10.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_10.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_10_panel.png`。
- 视觉读图结论 安卓为认词卡正面且有具体单词，网页词卡区域显示暂无单词，目标功能未达成。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- 功能实现判定 未实现。
- 当前问题 认词主卡在网页侧未拿到可学习词，认词正面状态无法出现。
- 三种可能解决方法
1. 把学习首屏改为强制装载一条可学习词，直到词卡主词渲染成功才截图。
2. 对齐安卓学习调度器在会话启动时的取词顺序，避免先进入空态。
3. 在自动化中加入 learning_word_card 可见断言，失败时自动重试取词。

### 11 学习 点击翻卡可看到背面

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_11.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_11.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_11_panel.png`。
- 视觉读图结论 安卓左侧已经翻到背面并出现释义段落，网页仍停在暂无单词态且没有翻卡结果。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- 功能实现判定 未实现。
- 当前问题 翻卡动作未在网页侧生效，或者翻卡前置词卡为空导致动作被吞掉。
- 三种可能解决方法
1. 把翻卡步骤改为先确认词卡存在再执行点击，并等待背面关键文本出现。
2. 修复词卡翻转状态机，使正反面切换与安卓同一触发条件。
3. 增加翻卡动作日志和截图前状态快照，定位是点击失败还是数据为空。

### 12 学习 翻回正面成功

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_12.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_12.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_12_panel.png`。
- 视觉读图结论 安卓在背面后又回到正面，网页未出现背面也未出现回正流程，功能链路缺失。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- 功能实现判定 未实现。
- 当前问题 回正动作依赖前一步翻背成功，当前网页链路在前置步骤已经断裂。
- 三种可能解决方法
1. 把步骤 11 和 12 绑定为同一事务，只有背面达成后才执行回正。
2. 在网页中补充翻转状态持久化，防止状态被路由或重渲染重置。
3. 新增两步联测断言，分别校验背面文案和回正主词文案。

### 13 学习 复习时间弹窗可打开

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_13.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_13.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_13_panel.png`。
- 视觉读图结论 安卓出现复习时间弹窗，网页跳到查词页并弹出输入法，目标弹窗完全未出现。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:345` 复习时间弹窗打开与关闭
- 功能实现判定 未实现。
- 当前问题 复习弹窗触发动作被错误路由打断，截图落到查词页。
- 三种可能解决方法
1. 把复习时间弹窗触发与截图绑定到学习页上下文，并禁止步骤内路由跳转。
2. 增加 review_dialog_title 可见断言，未出现时重试点击复习标签。
3. 修正截图脚本顺序，先关闭输入法和搜索焦点，再执行学习页弹窗动作。

### 14 学习 复习时间弹窗可关闭

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_14.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_14.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_14_panel.png`。
- 视觉读图结论 安卓完成复习弹窗关闭并回学习页，网页没有经历弹窗关闭动作，仍是错误链路。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:345` 复习时间弹窗打开与关闭
- 功能实现判定 未实现。
- 当前问题 步骤 14 依赖步骤 13 的弹窗状态，当前前置失败导致关闭动作无效。
- 三种可能解决方法
1. 将步骤 14 的前置条件设为弹窗已打开，否则自动回滚并重做步骤 13。
2. 在网页端实现与安卓一致的弹窗关闭回调，关闭后只回学习页不跳路由。
3. 为复习弹窗链路增加单测，覆盖 打开 关闭 回页 三段状态。

### 15 学习 认词三按钮区域可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_15.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_15.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_15_panel.png`。
- 视觉读图结论 安卓底部三按钮 不认识 模糊 认识 清晰可见，网页无对应按钮区。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- 功能实现判定 未实现。
- 当前问题 认词动作面板被空词态替换，导致核心答题按钮不显示。
- 三种可能解决方法
1. 修复 RecognitionActionPanel 的渲染前提，确保有词时始终显示三按钮。
2. 对齐安卓学习状态，在无词时不执行该截图点，先补词再继续。
3. 增加三按钮可见断言并记录按钮文本，保证动作区完整。

### 16 学习 左滑太简单快捷按钮可触发

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_16.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_16.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_16_panel.png`。
- 视觉读图结论 安卓出现左滑后反馈态，网页仍为静态暂无单词，未触发左滑快捷动作。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:644` 左滑右滑手势动作与撤销
- 功能实现判定 未实现。
- 当前问题 网页缺少可滑动词卡或手势阈值动作未达成。
- 三种可能解决方法
1. 在截图前确认 learning_word_card 可滑动，再发送与安卓一致距离的左滑手势。
2. 对齐手势阈值算法，使用与安卓同级别触发比例后再判断动作完成。
3. 动作后增加提示状态断言，例如撤销提示或词卡变化。

### 17 学习 太简单撤销可执行

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_17.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_17.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_17_panel.png`。
- 视觉读图结论 安卓展示左滑后的撤销链路结果，网页没有撤销反馈，仍停留原空态。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:644` 左滑右滑手势动作与撤销
- 功能实现判定 未实现。
- 当前问题 太简单撤销事件未入队，或者前一步左滑未成功导致撤销无对象。
- 三种可能解决方法
1. 将撤销步骤与左滑步骤串联，要求先拿到 undo token 再截图。
2. 在网页状态层补充撤销事件存储，和安卓一致维护短时撤销窗口。
3. 为撤销流程增加日志埋点，记录触发、展示、确认三节点。

### 18 学习 右滑加入生词本快捷按钮可触发

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_18.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_18.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_18_panel.png`。
- 视觉读图结论 安卓右滑加入生词本后星标状态变化可见，网页没有进入同等动作态。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:431` 认词和拼写模式 Tab
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:493` 空词态暂无单词分支
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:523` 认词卡与动作面板
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:644` 左滑右滑手势动作与撤销
- 功能实现判定 未实现。
- 当前问题 右滑加入生词本动作未触发成功，生词本状态没有回写到卡片。
- 三种可能解决方法
1. 右滑后强制校验星标状态变化，未变化则重试手势。
2. 复用安卓同名动作 onSwipeAddToNotebook 的状态回写路径。
3. 加入生词本后立即截图并冻结一帧，避免状态被后续步骤覆盖。

### 19 学习 切换到拼写模式成功

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_19.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_19.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_19_panel.png`。
- 视觉读图结论 安卓已切换到拼写模式，网页停留查词页，功能页错位。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:568` 切换拼写模式后挂载 SpellingScreen
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:152` 拼写主面板渲染
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:277` 首字母和长度提示
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:327` 三次错误进入抄写阶段
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:532` 拼写 AI 助记按钮
- 功能实现判定 未实现。
- 当前问题 学习到拼写的模式切换被路由状态覆盖，截图对象不是学习页。
- 三种可能解决方法
1. 切模式前先强制回学习页并确认学习标签激活。
2. 切换后断言拼写标题 拼写练习 出现再截图。
3. 把模式状态持久化到全局 store，避免切页后丢失。

### 20 学习 拼写面板可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_20.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_20.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_20_panel.png`。
- 视觉读图结论 安卓拼写面板完整，网页仍在查词页输入框，不是拼写界面。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:568` 切换拼写模式后挂载 SpellingScreen
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:152` 拼写主面板渲染
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:277` 首字母和长度提示
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:327` 三次错误进入抄写阶段
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:532` 拼写 AI 助记按钮
- 功能实现判定 未实现。
- 当前问题 拼写面板组件没有被挂载到当前截图页面。
- 三种可能解决方法
1. 在步骤 20 前执行模式切换成功校验，失败即中断并重跑。
2. 修复 LearningScreen 中 SPELLING 分支条件，确保 currentWord 存在时渲染 SpellingScreen。
3. 增加拼写输入框 testTag 断言，作为截图门禁。

### 21 学习 首字母提示可展开

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_21.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_21.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_21_panel.png`。
- 视觉读图结论 安卓首字母提示已展开，网页没有拼写界面，也无提示展开内容。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:568` 切换拼写模式后挂载 SpellingScreen
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:152` 拼写主面板渲染
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:277` 首字母和长度提示
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:327` 三次错误进入抄写阶段
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:532` 拼写 AI 助记按钮
- 功能实现判定 未实现。
- 当前问题 提示按钮动作执行在错误页面，导致无效。
- 三种可能解决方法
1. 先保证步骤 20 达标，再点击首字母提示按钮。
2. 对齐安卓 FilterChip 选中状态，在网页侧增加选中后的提示区域渲染。
3. 为提示功能新增独立回归脚本，校验 首字母 文本出现。

### 22 学习 长度提示可展开

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_22.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_22.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_22_panel.png`。
- 视觉读图结论 安卓长度提示展开，网页仍是查词页，长度提示不存在。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:568` 切换拼写模式后挂载 SpellingScreen
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:152` 拼写主面板渲染
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:277` 首字母和长度提示
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:327` 三次错误进入抄写阶段
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:532` 拼写 AI 助记按钮
- 功能实现判定 未实现。
- 当前问题 拼写提示链路未进入正确页面。
- 三种可能解决方法
1. 把长度提示步骤绑定拼写页上下文，若页面错位直接重置流程。
2. 实现长度提示的显式状态字段并在 UI 展示 target.length。
3. 增加长度提示可见断言，确认文本包含 长度。

### 23 学习 拼写错误提示可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_23.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_23.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_23_panel.png`。
- 视觉读图结论 安卓出现拼写错误提示和重试按钮，网页没有任何拼写错误反馈。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:568` 切换拼写模式后挂载 SpellingScreen
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:152` 拼写主面板渲染
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:277` 首字母和长度提示
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:327` 三次错误进入抄写阶段
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:532` 拼写 AI 助记按钮
- 功能实现判定 未实现。
- 当前问题 拼写提交动作没有在网页拼写界面执行。
- 三种可能解决方法
1. 在拼写输入框写入错误值并触发提交后再截图。
2. 复刻安卓拼写错误状态机，Wrong 状态展示错误文案和剩余次数。
3. 新增错误提示回归断言 spelling_retry_hint。

### 24 学习 三次错误进入抄写阶段

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_24.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_24.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_24_panel.png`。
- 视觉读图结论 安卓三次错误后进入抄写阶段，网页未进入该阶段。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:568` 切换拼写模式后挂载 SpellingScreen
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:152` 拼写主面板渲染
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:277` 首字母和长度提示
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:327` 三次错误进入抄写阶段
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:532` 拼写 AI 助记按钮
- 功能实现判定 未实现。
- 当前问题 失败次数累加逻辑未触发或被页面错位中断。
- 三种可能解决方法
1. 连续三次提交错误拼写并校验 attemptCount 达到 3。
2. 对齐安卓 CopyRequired 状态切换条件 currentAttempt>=3。
3. 截图前断言 正确拼写 文案和抄写输入框出现。

### 25 学习 抄写正确后可继续

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_25.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_25.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_25_panel.png`。
- 视觉读图结论 安卓抄写正确后可继续，网页未呈现继续按钮可用态。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:568` 切换拼写模式后挂载 SpellingScreen
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:152` 拼写主面板渲染
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:277` 首字母和长度提示
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:327` 三次错误进入抄写阶段
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:532` 拼写 AI 助记按钮
- 功能实现判定 未实现。
- 当前问题 抄写输入校验和继续动作没有完成。
- 三种可能解决方法
1. 在抄写输入框写入正确答案并等待继续按钮变为可点击。
2. 对齐安卓 onContinueAfterFailure 回调，成功后推进下一词。
3. 增加继续动作后的状态断言，确保离开抄写阶段。

### 26 学习 拼写 AI 助记按钮可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_26.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_26.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_26_panel.png`。
- 视觉读图结论 安卓在拼写失败态可见 AI 助记按钮，网页未出现对应区域。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:568` 切换拼写模式后挂载 SpellingScreen
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:152` 拼写主面板渲染
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:277` 首字母和长度提示
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:327` 三次错误进入抄写阶段
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:532` 拼写 AI 助记按钮
- 功能实现判定 未实现。
- 当前问题 拼写 AI 助记区渲染条件未满足或页面不在拼写态。
- 三种可能解决方法
1. 先进入 Wrong 或 CopyRequired，再断言 AI 助记按钮出现。
2. 同步安卓 canShowAiAssistAction 条件到网页实现。
3. 为 AI 助记按钮增加固定 test id，并纳入自动化门禁。

### 27 学习 切回认词模式成功

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_27.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_27.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_27_panel.png`。
- 视觉读图结论 安卓切回认词模式后显示认词卡，网页仍留在查词页，模式回切失败。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/LearningScreen.kt:568` 切换拼写模式后挂载 SpellingScreen
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:152` 拼写主面板渲染
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:277` 首字母和长度提示
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:327` 三次错误进入抄写阶段
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SpellingScreen.kt:532` 拼写 AI 助记按钮
- 功能实现判定 未实现。
- 当前问题 拼写到认词回切未落在学习页面。
- 三种可能解决方法
1. 切回时先导航到学习标签，再切换 RECOGNITION。
2. 切回后校验认词卡主词可见，不可见则重置学习队列。
3. 增加模式切换链路回归，从 19 到 27 一次跑通。

### 28 查词 进入查词页成功

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_28.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_28.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_28_panel.png`。
- 视觉读图结论 两端都进入查词页主界面，结构对应关系清楚，视觉风格仍有明显差异。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:193` 查词输入框与结果列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:126` 详情抽屉打开条件
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:538` 详情翻译区与 AI 助记区
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:675` 生词本按钮状态
- 功能实现判定 已实现。

### 29 查词 查词输入框可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_29.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_29.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_29_panel.png`。
- 视觉读图结论 查词输入框在两端可见，安卓和网页都可识别输入区域。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:193` 查词输入框与结果列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:126` 详情抽屉打开条件
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:538` 详情翻译区与 AI 助记区
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:675` 生词本按钮状态
- 功能实现判定 已实现。

### 30 查词 查词结果可出现

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_30.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_30.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_30_panel.png`。
- 视觉读图结论 查词结果都已经出现，主词 abandonment 在两端可见，但字体与卡片样式差异明显。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:193` 查词输入框与结果列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:126` 详情抽屉打开条件
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:538` 详情翻译区与 AI 助记区
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:675` 生词本按钮状态
- 功能实现判定 已实现。

### 31 查词 查词详情可打开

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_31.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_31.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_31_panel.png`。
- 视觉读图结论 安卓打开查词详情抽屉，网页停留在列表态并弹出键盘，详情未打开。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:193` 查词输入框与结果列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:126` 详情抽屉打开条件
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:538` 详情翻译区与 AI 助记区
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:675` 生词本按钮状态
- 功能实现判定 未实现。
- 当前问题 详情入口点击没有稳定命中，且输入焦点导致键盘遮挡。
- 三种可能解决方法
1. 点击结果项后先关闭输入法，再等待详情抽屉出现。
2. 为详情抽屉设置打开状态断言，未打开则重试点击结果卡。
3. 把搜索框失焦动作前置，避免键盘占据画面。

### 32 查词 详情翻译按钮可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_32.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_32.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_32_panel.png`。
- 视觉读图结论 安卓详情中可见 AI 中文翻译区，网页与 31 同帧重复，没有进入翻译区。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:193` 查词输入框与结果列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:126` 详情抽屉打开条件
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:538` 详情翻译区与 AI 助记区
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:675` 生词本按钮状态
- 功能实现判定 未实现。
- 当前问题 步骤 32 没有在详情抽屉内执行，流程停滞在上一状态。
- 三种可能解决方法
1. 把 32 号步骤前置条件设为详情抽屉已打开。
2. 在抽屉内滚动到 AI 中文翻译标题后再截图。
3. 增加步骤推进标记，禁止与 31 使用同一截图状态。

### 33 查词 详情 AI 助记按钮可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_33.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_33.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_33_panel.png`。
- 视觉读图结论 安卓详情中可见 AI 助记区，网页仍是列表态，功能未体现。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:193` 查词输入框与结果列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:126` 详情抽屉打开条件
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:538` 详情翻译区与 AI 助记区
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:675` 生词本按钮状态
- 功能实现判定 未实现。
- 当前问题 AI 助记区所在详情层未打开，导致按钮和文案都不可见。
- 三种可能解决方法
1. 先复用 31 的详情打开逻辑，再定位 AI 助记模块。
2. 在网页详情中实现与安卓一致的分段渲染顺序。
3. 新增 AI 助记区可见断言，未出现则截图失败。

### 34 查词 详情生词本按钮可切换

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_34.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_34.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_34_panel.png`。
- 视觉读图结论 两端都出现详情面板并看到生词本相关按钮，但网页按钮状态与安卓最终态不完全一致。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:193` 查词输入框与结果列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:126` 详情抽屉打开条件
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:538` 详情翻译区与 AI 助记区
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:675` 生词本按钮状态
- 功能实现判定 部分实现。
- 当前问题 生词本切换动作触发了详情页，但按钮文案和当前收藏状态口径不一致。
- 三种可能解决方法
1. 统一生词本按钮文案与状态来源，直接读取同一收藏字段。
2. 点击后增加状态回写等待，确保截图时状态已经刷新。
3. 补一条切换前后双截图对照，验证按钮从加入到已在生词本的变化。

### 35 查词 关闭查词详情成功

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_35.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_35.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_35_panel.png`。
- 视觉读图结论 两端都从详情返回到查词列表，关闭链路可以完成。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:193` 查词输入框与结果列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:126` 详情抽屉打开条件
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:538` 详情翻译区与 AI 助记区
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/SearchScreen.kt:675` 生词本按钮状态
- 功能实现判定 已实现。

### 36 词库 进入词库页成功

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_36.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_36.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_36_panel.png`。
- 视觉读图结论 词库页都能进入，主标题 我的词库 与列表均可见，视觉体系差异仍然明显。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:257` 词库主页与列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:146` 词书详情弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:178` 提前复习弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:202` 清空生词本确认弹窗
- 功能实现判定 已实现。

### 37 词库 词库卡片列表可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_37.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_37.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_37_panel.png`。
- 视觉读图结论 词库卡片列表在两端都可见，功能点成立。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:257` 词库主页与列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:146` 词书详情弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:178` 提前复习弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:202` 清空生词本确认弹窗
- 功能实现判定 已实现。

### 38 词库 词书详情弹窗可打开

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_38.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_38.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_38_panel.png`。
- 视觉读图结论 词书详情弹窗在两端都能打开，安卓为浅色全宽抽屉，网页为深色抽屉，样式差异较大。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:257` 词库主页与列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:146` 词书详情弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:178` 提前复习弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:202` 清空生词本确认弹窗
- 功能实现判定 已实现。

### 39 词库 词书详情弹窗可关闭

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_39.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_39.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_39_panel.png`。
- 视觉读图结论 词书详情关闭后都回到词库列表，回退链路成立。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:257` 词库主页与列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:146` 词书详情弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:178` 提前复习弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:202` 清空生词本确认弹窗
- 功能实现判定 已实现。

### 40 词库 提前复习弹窗可打开

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_40.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_40.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_40_panel.png`。
- 视觉读图结论 提前复习弹窗在两端都能打开，功能点成立，但网页弹窗尺寸和层级与安卓不同。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:257` 词库主页与列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:146` 词书详情弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:178` 提前复习弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:202` 清空生词本确认弹窗
- 功能实现判定 已实现。

### 41 词库 提前复习全选按钮可点击

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_41.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_41.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_41_panel.png`。
- 视觉读图结论 全选按钮动作在两端都触发，但安卓显示已选 14 词，网页显示已选 20863 词，数据口径明显不一致。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:257` 词库主页与列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:146` 词书详情弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:178` 提前复习弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:202` 清空生词本确认弹窗
- 功能实现判定 部分实现。
- 当前问题 网页全选逻辑按全词库计数，安卓按候选集计数，导致选择数量失真。
- 三种可能解决方法
1. 将网页全选目标改为当前候选列表而不是全量词库。
2. 把候选集过滤条件对齐安卓，包括已学习和可提前复习约束。
3. 增加全选后数量断言，要求与候选条目数严格一致。

### 42 词库 提前复习清空按钮可点击

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_42.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_42.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_42_panel.png`。
- 视觉读图结论 清空按钮可触发，已选数量回落为 0，功能点成立。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:257` 词库主页与列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:146` 词书详情弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:178` 提前复习弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:202` 清空生词本确认弹窗
- 功能实现判定 已实现。

### 43 词库 提前复习确认后关闭

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_43.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_43.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_43_panel.png`。
- 视觉读图结论 确认后弹窗关闭并回到词库列表，两端流程一致。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:257` 词库主页与列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:146` 词书详情弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:178` 提前复习弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:202` 清空生词本确认弹窗
- 功能实现判定 已实现。

### 44 词库 清空生词本确认弹窗可打开

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_44.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_44.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_44_panel.png`。
- 视觉读图结论 清空生词本确认弹窗两端都能打开，标题和双按钮都可见。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:257` 词库主页与列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:146` 词书详情弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:178` 提前复习弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:202` 清空生词本确认弹窗
- 功能实现判定 已实现。

### 45 词库 清空生词本确认弹窗可取消

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_45.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_45.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_45_panel.png`。
- 视觉读图结论 取消后都返回词库列表，取消链路成立。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:257` 词库主页与列表
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:146` 词书详情弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:178` 提前复习弹层
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:202` 清空生词本确认弹窗
- 功能实现判定 已实现。

### 46 词库 词书教程页可打开

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_46.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_46.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_46_panel.png`。
- 视觉读图结论 词书教程页两端都打开成功，内容段落存在，网页仍有明显视觉风格差。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:266` 教程入口按钮
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookBuildGuideScreen.kt:26` 词书教程页面与返回
- 功能实现判定 已实现。

### 47 词库 词书教程页可返回

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_47.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_47.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_47_panel.png`。
- 视觉读图结论 教程返回后都回到词库页，回退路径成立。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookManageScreen.kt:266` 教程入口按钮
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/BookBuildGuideScreen.kt:26` 词书教程页面与返回
- 功能实现判定 已实现。

### 48 我的 我的页热力图可见

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_48.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_48.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_48_panel.png`。
- 视觉读图结论 我的页热力图在两端都可见，功能点成立，但统计数据和图线形态差异较大。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/ProfileScreen.kt:235` 学习统计卡与热力图
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/ProfileScreen.kt:279` 热力图组件渲染
- 功能实现判定 已实现。

### 49 我的 学习数据页切换功能可用

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_49.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_49.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_49_panel.png`。
- 视觉读图结论 安卓在学习数据页正常展示，网页被浏览器标签菜单遮挡，页面虽在后台但用户态不可用。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/ProfileScreen.kt:283` 查看学习数据入口
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/StatsScreen.kt:85` 学习数据页主入口
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/StatsScreen.kt:170` 历史和未来模式切换
- 功能实现判定 未实现。
- 当前问题 截图时系统浏览器菜单被误触发，覆盖了学习数据页面交互。
- 三种可能解决方法
1. 截图流程中锁定全屏模式并禁用浏览器手势菜单。
2. 执行截图前清理所有系统弹层和菜单，再校验 stats_content 可见。
3. 改用可控的内置壳或 PWA 全屏采集，避免浏览器 UI 污染截图。

### 50 我的 数据恢复确认弹窗可打开并取消

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_50.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_50.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_50_panel.png`。
- 视觉读图结论 安卓应触发数据恢复确认弹窗，网页停留在我的页统计卡，没有出现恢复确认弹窗。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/ProfileScreen.kt:121` 数据恢复确认弹窗
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/ProfileScreen.kt:327` 数据管理卡中的恢复入口
- 功能实现判定 未实现。
- 当前问题 数据恢复入口动作未触发确认对话框，功能验证缺失。
- 三种可能解决方法
1. 在点击 数据恢复 后强制等待恢复弹窗标题出现。
2. 修复网页恢复流程，将文件选择后的确认弹窗设为必经步骤。
3. 补充恢复流程端到端用例，覆盖打开与取消两动作。

### 51 词库 今日新词页可进入并确认

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_51.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_51.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_51_panel.png`。
- 视觉读图结论 两端都进入今日新词选择页，但已选数量和候选状态不同，确认动作等效性尚未证明。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/TodayNewWordsSelectScreen.kt:67` 今日新词选择页入口与结构
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/TodayNewWordsSelectScreen.kt:110` 随机选取 清空选择 确认使用
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/TodayNewWordsSelectScreen.kt:176` 候选词列表与勾选状态
- 功能实现判定 部分实现。
- 当前问题 网页今日新词初始选择集与安卓口径不一致，导致页面状态偏差。
- 三种可能解决方法
1. 按安卓规则重建今日新词候选与默认已选集合。
2. 确认按钮前增加已选数量与每日上限一致性校验。
3. 增加进入页即刻快照断言，确保初始状态与安卓同口径。

### 52 我的 实验室成本与隐私弹窗可打开

- 截图路径 安卓图 `web/screenshot_compare/android_visible52/visible_52.png`。
- 截图路径 网页图 `web/screenshot_compare/mobile_web_visible52/visible_52.png`。
- 截图路径 三联图 `web/screenshot_compare/mobile_live_full52_review/panels/visible_52_panel.png`。
- 视觉读图结论 安卓在实验室页，网页却停在查词列表，没有打开实验室更没有出现成本与隐私弹窗。
- 安卓源码依据
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/AILabScreen.kt:78` 成本提示与隐私弹窗
- `app/src/main/java/com/kaoyan/wordhelper/ui/screen/AILabScreen.kt:317` 弹窗入口按钮 查看成本提示 查看隐私说明
- 功能实现判定 未实现。
- 当前问题 我的页到实验室的路由未执行到位，后续弹窗入口自然不可达。
- 三种可能解决方法
1. 先校验进入实验室页标题，再执行 查看成本提示 和 查看隐私说明 两步。
2. 修复实验室入口动作链路，避免被查词页状态残留覆盖。
3. 把两个弹窗入口分别做独立断言，任一失败直接标记该点未通过。

## 审计后优先修复顺序

1. 先修学习链路 08 到 27，目标是让网页截图与安卓处于同一学习状态。
2. 再修查词详情链路 31 到 33 和 34，目标是详情打开与按钮状态完全一致。
3. 最后修我的链路 49 50 52，并补齐 51 的状态口径。

TLDR：本轮 52 项中已实现 24 项，部分实现 3 项，未实现 25 项，主阻塞在学习链路错页和弹窗链路未触发，文档已逐条给出源码依据与三种修复方法。

## 2026-02-25 第二轮网页重构后复核

本节是本轮真实执行结果，覆盖当前最新代码与截图。

### 本轮执行记录

- 网页52点功能回归命令 `npm run -s screenshot:web:visible52`，结果 52 项全部 PASS。
- 三联图生成命令 `npm run -s screenshot:compare:visible52`，结果 52 张全部已生成。
- 人工视觉复核文件目录 `web/screenshot_compare/report/panels_visible52`。

### 本轮代码改动

- `web/src/App.tsx`
- 重构 `SpellingPanel` 页面结构，改为状态卡、释义卡、提示卡、底部输入操作区四段布局。
- 增加拼写状态文案与进度计算，按状态切换颜色与交互禁用。
- 把 AI 助记区域放入底部输入区，并在错误态和抄写态显示。

- `web/src/index.css`
- 新增拼写页完整样式体系，包含 `spelling-status-card`、`spelling-question-card`、`spelling-hint-tools`、`spelling-input-dock` 等。
- 新增安卓视觉模式下拼写页的圆角、字号、留白收敛样式。
- 调整弹窗安卓视觉样式，包含遮罩透明度、默认弹窗宽度、确认弹窗宽度、标题与正文层级。
- 调整查词详情安卓视觉样式，回收标题字号、音标字号、释义字号、AI分区标题字号与按钮尺寸。

### 关键截图人工视觉复核

- `visible_13_panel.png` 学习页复习时间弹窗
- 结论 中差。
- 现状与安卓已经同为白底圆角弹窗、遮罩和按钮位置一致，剩余差异主要是标题字重仍略重、正文行宽略短。

- `visible_19_panel.png` 拼写模式初始态
- 结论 中低差。
- 页面结构已经对齐安卓四段布局，底部提交按钮的禁用灰态已对齐，剩余差异主要是释义卡字号和分区高度仍有轻微偏差。

- `visible_23_panel.png` 拼写错误态
- 结论 中差。
- 错误态输入区、纠错提示、重试按钮、AI助记入口均已存在，剩余差异是提示工具区域在该截图中仍保持展开，导致与安卓参考图状态不完全同帧。

- `visible_24_panel.png` 拼写抄写态
- 结论 中高差。
- 抄写输入、继续按钮和 AI 助记入口均已实现，剩余差异主要来自同帧状态顺序不一致，网页图保留了提示展开状态并压缩了底部区域。

- `visible_31_panel.png` 查词详情弹层
- 结论 中低差。
- 主词、音标、释义、例句、AI翻译、AI助记与生词本按钮均对齐，剩余差异集中在标题与正文字重细节。

- `visible_44_panel.png` 清空生词本确认弹窗
- 结论 低差。
- 弹窗结构、按钮文案、按钮顺序已和安卓一致，剩余差异是弹窗正文两端留白有少量差距。

- `visible_52_panel.png` 实验室页面
- 结论 中差。
- 开关、服务商预设、Base URL、模型与密钥、测试与保存按钮均已实现，剩余差异是卡片间距与字段标题位置还未完全贴合安卓。

### 当前剩余问题清单

- 拼写态 `visible_23`、`visible_24` 仍有同帧状态错位，主要是提示工具展开状态与安卓参考图不一致。
- 学习弹窗 `visible_13` 与实验室页 `visible_52` 仍有字号和间距的小幅偏差。
- 词库弹窗 `visible_44` 已进入低差，但正文留白还可继续压缩。

### 下一轮执行目标

- 把拼写截图流程改为和安卓参考图同帧状态，先复位提示工具再进入错误与抄写截图。
- 继续细调 `visible_13` 与 `visible_52` 的字号、间距和卡片高度，压到低差。
- 每轮调整后继续执行 52 项回归与人工视觉复核。

### 2026-02-25 第三次增量修复补记

- 本次把拼写流程截图脚本在 `visible_23` 前增加提示工具复位。
- 同时把网页 `SpellingPanel` 改为错误态与抄写态自动收起提示工具，仅在初始拼写态显示。
- 复核 `visible_23_panel.png` 与 `visible_24_panel.png` 后确认，页面同帧状态更接近安卓，原先由提示区残留导致的大块偏差已明显收敛。

## 2026-02-25 当日线上复核补记

### 本轮结论
- 本轮以线上域名 `fastnglish.com` 为准重新验证。
- 网页 52 项功能回归结果已恢复到 52 通过 0 失败。
- 学习页关键三项人工视觉复核对象为 `visible_05`、`visible_19`、`visible_20`，结论均为可用且已明显接近安卓。

### 本轮关键修复
1. 学习队列新增双重兜底，避免长期落入暂无单词。
2. 学习页分段控件改为全宽拉伸，修复手机端半宽显示。
3. 认词卡内层边框移除，修复双层框视觉差。
4. 学习页纵向占屏和进度区位置重调，压缩拼写页异常留白。
5. 底部导航我的图标改为人像图标，与安卓一致。

### 本轮线上发布校验
- 线上真实发布目录 `/proc/222261/root/data/english_app_web`。
- 发布完成时间 2026-02-25 12:21。
- 线上资源哈希已更新为
- `assets/index-69-HSF5j.js`
- `assets/index-CeU0usbl.css`
