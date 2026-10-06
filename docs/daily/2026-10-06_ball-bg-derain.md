# 2026-10-06 球盘底色还原 + 去雨效（P6-demo 一比一）

## 起因

用户对照 `prototype/skin-applied.html` 发现 App 里五款皮肤"都没有这些效果"。
定位结论：**主因不是立体度，是球盘底色** —— demo 四款全在暗盘上（V1 深棕 / V3 深绿 /
V5 深橄榄 / V6 深蓝），辉光环靠暗底衬托；App 里 candy（浅紫盘）、minimal（近白盘）
是浅盘，同一套环观感完全不同。

## 改动一：球盘底色还原

- dark / candy / minimal 的 `--ball-bg` 按 demo 逐值抄暗色 radial-gradient，
  `--ball-rim` 同步翻成浅色（深盘配浅缘，alpha ≥ 0.12，D3c）。
- candy 与 minimal 由浅盘改暗盘，是与原浅色盘定位相反的**视觉变更**（用户拍板）。
- aero / ink 底色不动：aero 跟随系统亮暗是既有契约，ink 保纸色；只给两皮的
  `::after` 加全 inset 立体层。
- 门禁：D3b（三环皮 ball-bg 必须是 radial-gradient）/ D3c（rim 方向），先红后绿。
- 已知不可还原差异（写进注释与本日志）：demo 的外投影 `0 8px 22px` 做不到 ——
  56×56 窗口会把外投影裁成方框（D6 纪律，历史 bug 判词）；水体皮亮暗跟随是契约不是缺陷。

## 改动二：去掉下雨与两侧流水

- 删：`.pour-drop` / `.pour-splash` / `.pour-trickle` / `.pour-clip`（JSX+CSS+keyframes）、
  `POUR_DROPS` 表 + `PourDrop` 类型、`pourSurfaceY`、`--drop-w/--drop-speed/--splash-s`
  （:root + 五皮）、K7c/K7d/K7e/K7e2/K7e3/K7e3b/K7f、test-fluid 用例 9、K9h/K9j、
  5l 取帧 + 雨探针。
- 留：slosh 荡漾（`.slosh`/`pour-slosh`/`--slosh-amp/--slosh-dur`）、冲顶 `pour-top`、
  闪峰 `pour-flash`。K7 门重写为"有 slosh+overshoot+flash、无雨滴/花/壁流"。
- 注意 `fluid-peek-drop`（P4 悬停预览落雨，另一功能）不动。
- 倒水入场现在只剩：荡漾 + 冲顶 + 闪峰。

## 改动三：截图对比

- `--shots` 实拍 `5c-ball-{dark,candy,minimal,aero,ink}`；demo V1/V3/V5/V6 按 112px 截 PNG；
  并排对比存 `prototype/p6-compare.png`。
- 结论：dark 基本一样（Δ9）；minimal 基本一样（Δ8）；candy 盘色/半径对、
  顶部高光偏强（`fluid-disc` 0.85 白斑是水体时代遗留，demo 只有 0.38，不影响语义）；
  aero 不一样但刻意（亮色跟随系统）。
- App 弧色是连续 `waterColor(40%)`（黄绿），demo 是阶梯 ok 绿 —— 既有语义，本轮不动。
- 读数首字豆腐块：mark/文字路径本轮零改动，既有现象非回归（headless 缺字体）。

## 门禁

- test:structure 302→304/0（+D3b/D3c，本轮又 +2 D6 皮肤级 ::after 条目）
- test:fluid 119/0（用例 9 已删）· test:dock-hide 155/0 · typecheck 双工程干净
- `npm test` 全链 EXIT:0 · `npm run build` 通过 · `--shots` 全程跑完（无 5l，有 5m）

## 坑位

1. 注释与生效值不一致（minimal 注释抄成 candy 的 `#07180f`，生效 `#0b0f07`）——
   复制粘贴残留，check 抓出。以后"逐值抄"必须三方比对（原型/注释/生效值）。
2. D6 `ruleBody` 整选择器匹配会跳过 `[data-skin…]` 前缀规则 —— 名单类门禁判据若用
   整选择器相等，必须显式列出带前缀变体，否则就是名单缺口。
