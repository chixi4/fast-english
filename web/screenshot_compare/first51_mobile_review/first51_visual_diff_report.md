# 前51项真实手机截图差异文档

## 一 目标与范围
本轮只覆盖前51项，基于现存安卓截图目录和网页真实手机截图目录做一一视觉核对，输出逐项差异和修复目标。

- 安卓目录 `web/screenshot_compare/android_visible52`
- 网页目录 `web/screenshot_compare/mobile_web_visible52`
- 核对时间 2026-02-24T03:17:10.232Z

## 二 总体结论
- 前51项一致 0 项，差异 51 项。
- 高差异 7 项，中差异 18 项，低差异 26 项。
- 高差异主要集中在弹窗流程错位、详情页未进入、学习数据页未进入、浏览器菜单遮挡。

## 三 逐项差异表
| 编号 | 场景ID | 模块 | 差异率 | 优先级 | 视觉差异 | 修复目标 | 面板 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | visible_01 | 学习 | 7.3895% | P2 | 安卓为学习卡有词态，网页为暂无单词并带浏览器壳。 | 修学习队列准备，首屏必须有词。 | `screenshot_compare/first51_mobile_review/panels/visible_01_panel.png` |
| 2 | visible_02 | 学习 | 7.3901% | P2 | 安卓学习页有词卡与按钮，网页停在暂无单词态。 | 统一学习页截图前置状态到有词卡。 | `screenshot_compare/first51_mobile_review/panels/visible_02_panel.png` |
| 3 | visible_03 | 学习 | 7.3912% | P2 | 安卓学习页正常，网页有顶部地址栏与底部工具栏侵入。 | 去除浏览器壳对截图的干扰。 | `screenshot_compare/first51_mobile_review/panels/visible_03_panel.png` |
| 4 | visible_04 | 学习 | 7.7119% | P2 | 底栏图标位置接近，但网页整体内容仍是无词态。 | 底栏和内容区统一到安卓布局。 | `screenshot_compare/first51_mobile_review/panels/visible_04_panel.png` |
| 5 | visible_05 | 学习 | 7.4077% | P2 | 安卓已完成学习页加载并有词，网页加载后仍显示暂无单词。 | 初始化后注入可学习词条。 | `screenshot_compare/first51_mobile_review/panels/visible_05_panel.png` |
| 6 | visible_06 | 学习 | 7.4055% | P2 | 模式切换区结构相近，但网页缺少目标词面区域。 | 认词模式切换后校验当前词存在。 | `screenshot_compare/first51_mobile_review/panels/visible_06_panel.png` |
| 7 | visible_07 | 学习 | 7.3933% | P2 | 拼写模式标签存在，网页仍未进入有词学习流。 | 拼写模式切换前保证队列不空。 | `screenshot_compare/first51_mobile_review/panels/visible_07_panel.png` |
| 8 | visible_08 | 学习 | 7.4056% | P2 | 当前词书和进度在安卓有真实数据，网页多为零值。 | 对齐默认词书与统计种子数据。 | `screenshot_compare/first51_mobile_review/panels/visible_08_panel.png` |
| 9 | visible_09 | 学习 | 7.723% | P2 | 学习进度文本位置近似，但数值和状态不一致。 | 学习进度采用安卓同口径。 | `screenshot_compare/first51_mobile_review/panels/visible_09_panel.png` |
| 10 | visible_10 | 学习 | 7.7212% | P2 | 安卓是认词卡正面，网页是空队列面板。 | 首张学习卡锁定非空词。 | `screenshot_compare/first51_mobile_review/panels/visible_10_panel.png` |
| 11 | visible_11 | 学习 | 8.6039% | P2 | 安卓翻卡背面详情已展示，网页未进入同态。 | 翻卡动作后强制留在背面截图。 | `screenshot_compare/first51_mobile_review/panels/visible_11_panel.png` |
| 12 | visible_12 | 学习 | 7.3389% | P2 | 安卓翻回正面成功，网页依旧空学习态。 | 翻回动作后强制留在正面截图。 | `screenshot_compare/first51_mobile_review/panels/visible_12_panel.png` |
| 13 | visible_13 | 学习 | 69.5408% | P0 | 安卓显示复习时间弹窗，网页实际停在查词页并弹出键盘。 | 步骤13强制打开复习时间弹窗再截图。 | `screenshot_compare/first51_mobile_review/panels/visible_13_panel.png` |
| 14 | visible_14 | 学习 | 7.3771% | P2 | 关闭后安卓回学习页，网页仍偏离到查词流。 | 步骤14先关闭弹窗再回学习页截图。 | `screenshot_compare/first51_mobile_review/panels/visible_14_panel.png` |
| 15 | visible_15 | 学习 | 7.3839% | P2 | 安卓三按钮完整可见，网页按钮状态和文案不一致。 | 三按钮区域按安卓尺寸和顺序渲染。 | `screenshot_compare/first51_mobile_review/panels/visible_15_panel.png` |
| 16 | visible_16 | 学习 | 8.1298% | P2 | 安卓出现左滑快捷反馈，网页未拍到同反馈态。 | 左滑动作后截图等待反馈动画完成。 | `screenshot_compare/first51_mobile_review/panels/visible_16_panel.png` |
| 17 | visible_17 | 学习 | 9.3193% | P2 | 安卓有太简单撤销反馈，网页反馈弱或缺失。 | 撤销动作增加状态确认。 | `screenshot_compare/first51_mobile_review/panels/visible_17_panel.png` |
| 18 | visible_18 | 学习 | 8.0696% | P2 | 安卓右滑加入生词本反馈明确，网页未稳定呈现。 | 右滑加生词本后校验提示出现。 | `screenshot_compare/first51_mobile_review/panels/visible_18_panel.png` |
| 19 | visible_19 | 学习 | 9.6777% | P2 | 安卓切入拼写流程，网页多次停在无词状态。 | 拼写入口改为可重试并校验输入框。 | `screenshot_compare/first51_mobile_review/panels/visible_19_panel.png` |
| 20 | visible_20 | 学习 | 9.6905% | P2 | 拼写输入面板在安卓稳定可见，网页态不稳定。 | 拼写面板截图前清键盘遮挡。 | `screenshot_compare/first51_mobile_review/panels/visible_20_panel.png` |
| 21 | visible_21 | 学习 | 9.6866% | P2 | 首字母提示在安卓准确，网页提示层级和位置偏移。 | 首字母提示按钮和面板对齐安卓。 | `screenshot_compare/first51_mobile_review/panels/visible_21_panel.png` |
| 22 | visible_22 | 学习 | 9.651% | P2 | 长度提示在安卓准确，网页提示区域不一致。 | 长度提示按钮和面板对齐安卓。 | `screenshot_compare/first51_mobile_review/panels/visible_22_panel.png` |
| 23 | visible_23 | 学习 | 14.3249% | P1 | 安卓错误提示与输入区对应，网页提示位置和配色差异明显。 | 错误提示文案与位置对齐安卓。 | `screenshot_compare/first51_mobile_review/panels/visible_23_panel.png` |
| 24 | visible_24 | 学习 | 11.1126% | P1 | 安卓进入抄写阶段，网页抄写态控件布局偏差。 | 抄写阶段控件层级与间距对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_24_panel.png` |
| 25 | visible_25 | 学习 | 11.1108% | P1 | 安卓抄写后继续态正确，网页继续按钮和状态不同步。 | 继续按钮触发后停留正确态。 | `screenshot_compare/first51_mobile_review/panels/visible_25_panel.png` |
| 26 | visible_26 | 学习 | 11.1187% | P1 | 安卓拼写AI助记按钮在目标位置，网页按钮尺寸与层级偏差。 | AI助记按钮样式和位置对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_26_panel.png` |
| 27 | visible_27 | 学习 | 8.1938% | P2 | 安卓切回认词稳定，网页状态切回不稳定。 | 切回认词后复位学习卡状态。 | `screenshot_compare/first51_mobile_review/panels/visible_27_panel.png` |
| 28 | visible_28 | 查词 | 6.6798% | P2 | 查词页框架接近，但网页受浏览器壳挤压。 | 查词页顶区和底栏尺寸统一。 | `screenshot_compare/first51_mobile_review/panels/visible_28_panel.png` |
| 29 | visible_29 | 查词 | 6.6929% | P2 | 输入框存在，但网页输入焦点经常触发系统键盘遮挡。 | 输入焦点时自动收键盘再截图。 | `screenshot_compare/first51_mobile_review/panels/visible_29_panel.png` |
| 30 | visible_30 | 查词 | 7.0961% | P2 | 安卓查词结果卡片正常，网页结果状态和样式不一致。 | 查词结果卡结构和图标对齐安卓。 | `screenshot_compare/first51_mobile_review/panels/visible_30_panel.png` |
| 31 | visible_31 | 查词 | 22.2662% | P0 | 安卓已打开查词详情抽屉，网页留在输入态并拉起键盘。 | 详情页打开步骤增加状态断言。 | `screenshot_compare/first51_mobile_review/panels/visible_31_panel.png` |
| 32 | visible_32 | 查词 | 22.2803% | P0 | 安卓详情翻译区可见，网页未进入同一详情层。 | 翻译区字段与按钮层级对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_32_panel.png` |
| 33 | visible_33 | 查词 | 22.2874% | P0 | 安卓AI助记区可见，网页仍在列表页。 | AI助记区字段与按钮层级对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_33_panel.png` |
| 34 | visible_34 | 查词 | 27.591% | P0 | 安卓详情底部生词本按钮完整，网页显示层级和按钮区严重偏差。 | 底部生词本按钮固定到底并对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_34_panel.png` |
| 35 | visible_35 | 查词 | 6.6872% | P2 | 安卓关闭详情后回查词页，网页回退链路不稳定。 | 详情关闭后明确回到查词页。 | `screenshot_compare/first51_mobile_review/panels/visible_35_panel.png` |
| 36 | visible_36 | 词库 | 14.1873% | P1 | 词库页结构存在，但安卓和网页数据密度差异大。 | 词库页统计和卡片样式对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_36_panel.png` |
| 37 | visible_37 | 词库 | 14.1946% | P1 | 词库卡片都可见，但网页统计和卡片文案不一致。 | 词库列表行高字体间距对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_37_panel.png` |
| 38 | visible_38 | 词库 | 18.6135% | P1 | 安卓打开词书详情后内容丰富，网页弹层信息不足。 | 词书详情弹层字段完整对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_38_panel.png` |
| 39 | visible_39 | 词库 | 14.239% | P1 | 安卓关闭详情回词库，网页在局部会跳异常页。 | 关闭详情后禁止跳启动页。 | `screenshot_compare/first51_mobile_review/panels/visible_39_panel.png` |
| 40 | visible_40 | 词库 | 62.8877% | P0 | 安卓提前复习弹窗完整打开，网页弹窗状态错位。 | 提前复习弹窗入口与标题对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_40_panel.png` |
| 41 | visible_41 | 词库 | 63.0086% | P0 | 安卓全选后勾选状态正确，网页未进入同一弹窗状态。 | 全选状态回写到列表并截图。 | `screenshot_compare/first51_mobile_review/panels/visible_41_panel.png` |
| 42 | visible_42 | 词库 | 62.8232% | P0 | 安卓清空动作后状态正确，网页仍停留错误层。 | 清空动作回写状态并截图。 | `screenshot_compare/first51_mobile_review/panels/visible_42_panel.png` |
| 43 | visible_43 | 词库 | 14.2264% | P1 | 安卓确认后关闭回列表，网页仍处详情或弹层错位。 | 确认后关闭并回词库页。 | `screenshot_compare/first51_mobile_review/panels/visible_43_panel.png` |
| 44 | visible_44 | 词库 | 86.1869% | P0 | 安卓清空生词本确认窗布局正确，网页弹窗样式与层级差异极大。 | 清空生词本确认窗尺寸样式对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_44_panel.png` |
| 45 | visible_45 | 词库 | 13.8469% | P1 | 安卓取消后回列表，网页可回但样式仍显著偏差。 | 取消后恢复卡片焦点和滚动位。 | `screenshot_compare/first51_mobile_review/panels/visible_45_panel.png` |
| 46 | visible_46 | 词库 | 16.3128% | P1 | 教程页可打开，但网页页面结构和字体布局不同。 | 教程页头部和正文样式对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_46_panel.png` |
| 47 | visible_47 | 词库 | 13.8475% | P1 | 安卓教程返回到词库，网页常返回到浏览器页面或错误层。 | 教程返回路径锁到词库。 | `screenshot_compare/first51_mobile_review/panels/visible_47_panel.png` |
| 48 | visible_48 | 我的 | 12.3324% | P1 | 我的页热力图都存在，但网页图表样式与统计值偏差大。 | 学习数据卡和热力图样式对齐。 | `screenshot_compare/first51_mobile_review/panels/visible_48_panel.png` |
| 49 | visible_49 | 我的 | 58.148% | P0 | 安卓已进入学习数据页，网页停在我的页且被浏览器菜单遮挡。 | 学习数据入口强制进入并屏蔽菜单遮挡。 | `screenshot_compare/first51_mobile_review/panels/visible_49_panel.png` |
| 50 | visible_50 | 我的 | 12.3463% | P1 | 安卓数据恢复弹窗流程正确，网页多为错误弹层或未触发系统选择器。 | 数据恢复流程改为网页内确认弹窗稳定触发。 | `screenshot_compare/first51_mobile_review/panels/visible_50_panel.png` |
| 51 | visible_51 | 词库 | 15.7378% | P0 | 安卓进入今日新词选择页并展示词条，网页虽进入页面但控件和内容状态差异明显。 | 今日新词页按钮区和词项区对齐安卓。 | `screenshot_compare/first51_mobile_review/panels/visible_51_panel.png` |

## 四 关键根因
- 第一类是状态链路错位，截图触发点没有停留在安卓同功能页面。
- 第二类是学习队列和统计数据种子不一致，导致暂无单词和零值页面频繁出现。
- 第三类是网页被浏览器地址栏和工具栏包裹，和安卓应用无遮挡截图存在系统性偏差。
- 第四类是弹窗层级和按钮样式没有贴齐安卓，尤其在提前复习、清空生词本、学习数据链路上。

TLDR：前51项当前全部有差异，优先修13、31到34、40到42、44、49、51，核心是先修截图步骤状态，再修学习数据和弹窗样式，最后做全量视觉收口。