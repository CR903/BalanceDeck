# 2026-10-04 R4返工：雨滴天气泡沫余额水 + 原地变柱（10-04-rain-weather-column）

## 交付

用户 6 点返工一次落地：
1. 雨滴倒水（7 滴固定落位，中间滴溅 splash、近壁滴转 trickle 沿内壁汇入底部）
2. 溢出修复（::after inset:1px + 稳态 goo circle 裁剪，圆外剩 AA）
3. 泡沫带（waveBand 泡沫帽，白线压带上，B/C 冒头盖住）
4. 五皮天气（春雨/海啸/平静/暴雨/雾雨：雨滴数 3/4/5/6/7 + 水花 + 荡漾幅度/时长）
5. 贴边原地变柱（窗口不再滑出，原地立起 12px 温度计柱，屏边常驻）
6. 余额满水满柱（accent 实色实例，色值待用户看效果再定）

## 改动

- 渲染层：POUR_DROPS 表（skin-waves.ts）+ waveBand + pourSurfaceY（余额钳 24）+
  showWaves/fluidLvl/water 余额分支 + pill 12px 贴边侧 + --dx/--dy 翻转 + 液头 12px 圆 +
  天气变量 5 皮 + nth-child 藏雨滴/splash + slosh 变量化
- shared：COLUMN_W=12（dock-hide）替代 PEEK；hiddenBounds 原地返回；peekHitbox 屏边 12px 条；
  waterColumn 委托 peekHitbox；删除 pillBox/PILL_LEN/PEEK（水渍时代残留）
- 主进程：dockHide 删 animateTo/animTimer/位移动画（隐藏全程零 setPosition）；
  morph 相位照常经过（0ms 跳等待）；删 isEdgeSupported（上沿同权）；overlay 删注入
- 测试：dock-hide 用例全量更新（155 项）+ fluid 用例 3/4/6 + accent 用例 +
  结构门 K4/K4d/K7e2/K7h/K9g/K9h/K9i/K9j/K10 + uitest 余额三分支 + dock 新口径

## 验证

- `test:fluid` 114/114，`test:dock-hide` 155/155，`test:structure` 204/204，
  `typecheck` 干净，`npm test` 全绿，`npm run build` 通过
- 实机：5l 雨区均色≈水绿；5-ball/5l 圆外=8；5n 左侧 12px 橙水柱（fillH 39.2px=70%）；
  5i 拉丝 aspect 2.0（方向已翻）；5c-wave 极差≈2A
- e2e 流体+贴边键全绿（petWater*/dockFluid*/dockHide/dockEdges/dockPeekSize/dockPassby/dockReveal/dockRehide）；
  剩余 6 项为基线已知失败（drag/grp，HEAD 已对照）

## 真 bug（修了 3 个实现期的）

1. 雨滴 DOM 全对但像素无色：pour-clip 在 goo 容器内，3px 滴被 blur 吃掉 →
   移出 goo（crisp 覆盖层）+ K7h 配平门（上次只调顺序没移出来，教训：注释与代码不符时信代码）。
2. uitest waterColorWhy 传裸键导致锚点恒 null（沿用旧教训：单测 pin getter 口径）。
3. 用例 9 正则撞拆分后的皮肤块 → 只认裸皮肤块。

## 坑位（可沉淀）

1. freeze 强制开 goo 滤镜会污染取证像素（5l 上半球被 blur 压暗）—— 小元素取证看 DOM 探针，
   大色块看像素；freeze 帧的像素只看形状位移，不看颜色。
2. 绿色阈值检测器对橙水/低饱和全盲 —— 按期望色分类像素（5n 沿用）。
3. K 编号：K4/K7/K9 后缀已满，新门从 K10 起；test-fluid 用例号删除后重排（3/4/5/6/7/8/9）。
4. PEEK/PILL 删除后，I2/I2b/I2c/K4 注释里的旧名同步改，否则后人按注释找不到符号。
