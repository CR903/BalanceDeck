# 还原原型：并排提取 computed style，不靠目测

**遇到** 要把实现往一个 HTML 原型/设计稿上"高保真还原"，用户连续反馈"还是不一样"
**→ 停止目测截图**，在同浏览器同数据下给原型和实现各取一份 `getComputedStyle` 结构化 diff，
逐键列差异表，再按表改
**否则** 每轮只修掉最显眼的一两处，其余差异（伪元素、投影层数、DOM 骨架）永远在，来回返工

## 取证（2026-10-10，`10-10-island-fidelity` → `10-10-island-fidelity-2`）

用户三轮反馈"和原型不一样"。前两轮靠目测只修了辉光/动画/尺寸，第三轮用并排 diff 一次找全：

| 项 | 原型 | 实现 | 之前判断 |
|---|---|---|---|
| logo 边长 | 15px | 20px | 没发现 |
| 容器 gap | 10px | 12px | 没发现 |
| 展开容器阴影 | 5 层（含红晕 + 底部 inset 暗） | 3 层 | 用户说"立体感不明显"，无法定位 |
| 展开态 `::before`/`::after` | 有 | 整个丢失 | 无从知晓 |
| cell 骨架 | 单行 `[logo][环][右列]` | 两行 | "效果不一样"的真因 |
| 渐变 / glowPulse / logo ping | 一致 | 一致 | 以为不一致，**省掉一轮无效返工** |

要点：

1. **伪元素和投影层数目测不出来**，只能 `getComputedStyle(el, '::before').width`、
   `boxShadow.match(/rgba?\(/g).length` 这样量（上面两行就是这么得出的）。
2. **反向同样有价值**：证明哪些项已对齐，避免为不存在的差异写代码。
3. **参照物有开关状态时先切到同一状态**（本例 `?variant=B` 还要按「嵌套圆环开」按钮），
   拿默认态比展开态会得出错误结论。
4. 衍生纪律：同一 widget 两个状态共用的几何，抄两份字面量就会漂移 —— 收起环
   `viewBox 40/r17` 与展开环 `36/r15.5` 就是这么分叉的，现已并到 `IslandView.tsx` 的
   `RING_GEO` 单表（`.trellis/spec/frontend/quality-guidelines.md`「one home across states」）。

配套做法见 `.trellis/spec/frontend/quality-guidelines.md`：
「对版参照物 —— 并排提取 computed style」「红断言集合 = 被打断工作的交接态」。
