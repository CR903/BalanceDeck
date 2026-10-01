# Research: 需要用户确认的问题

- **Query**: 实现前必须由用户拍板、agent 无法自行决定的事项
- **Date**: 2026-10-01

按「阻塞程度」排序。Q1–Q3 阻塞 PRD 的 AC 写法。

---

## Q1（阻塞）对外到底承诺哪一种口径？

「默认形态不加载 three.js」这句现在是**假的**。有三条路：

| 选项 | 做法 | 代价 |
|---|---|---|
| **A. 改代码兑现** | 先做候选 #2（`PetBall.tsx:11` 改动态 import + `manualChunks`），让这句话变成真的再写进 README | 首屏 JS 从 1.70 MB 降到 ~514 kB 是好事，但改的是共享文件 `PetBall.tsx` + `electron.vite.config.ts`，且要处理 WebGL 失败兜底 |
| **B. 改文案降级** | README 改成「默认形态不建 WebGL 上下文、不下载任何 3D 素材」（两句都为真），把 three.js 这句删掉 | 零风险，但少了一张牌 |
| **C. 先改文案、代码排队** | 同 B，同时把 A 记进 Roadmap | 最小风险，但文案短期内保守 |

**我的观察（不代替决策）**：B 和 A 不冲突，B 是 A 未落地时的**唯一安全表述**。若选 A，顺序必须是「先代码 → 复测 → 再写文案」。

**需要你定**：A / B / C？

---

## Q2（阻塞）`.tga` 与 `reyna-pilot/` 用哪种方式排除？

| 选项 | 改哪 | 影响面 |
|---|---|---|
| A | 只改 `electron-builder.yml` 的 `extraResources` filter | 打包产物干净；磁盘上 `resources/` 仍留 221 MB（该目录本来就 gitignored） |
| B | 改 `scripts/fetch-human-pets.mjs`，转完 PNG 后删源 `.tga` | 磁盘也干净，但**动了采集脚本**（有 `.trellis/spec/adapters/` 之外的隐式契约：`fetch:humans` 是 `predist:mac` / `predist:win` 的钩子，`package.json:43-44`） |
| C | 两者都做 | 最彻底 |

**另外需要确认**：`reyna-pilot/` 是不是有意保留的实验素材？
- 它**不在** `scripts/fetch-human-pets.mjs` 的 `PETS` 里（`:26-44` 只有 aria/ray），所以 `npm run fetch:humans` **不会重新生成它** —— 删了就没了，只能从别处恢复。
- 全仓库零引用，`MIME` 表也没有 `.glb`。
- `README.md:208` 的 Roadmap 还留着「外部 GLB 模型加载」。

**我倾向 A（只动打包配置）** —— 但这是「删掉别人可能还想用的实验素材」的决定，得你点头。

---

## Q3（阻塞）PRD 里的「FAQ」要新建吗？

**仓库里没有 FAQ**：
```
$ find . -iname "*faq*" -not -path "./node_modules/*" -not -path "./.git/*"   → 无结果
$ grep -rn -i "FAQ\|常见问题" README.md docs/                                     → 无结果（只有一张 PNG 二进制误匹配）
```

需要定：
1. 放 `README.md` 末尾一节？还是独立 `docs/faq.md`？
2. **文档布局**：已核 `.trellis/spec/frontend/directory-structure.md` —— 它只在 `:52` / `:312` 提到 `docs/adr/`（3 篇 ADR，tracked），**没有规定其它文档的位置**。所以新建 `docs/faq.md` 不违反 spec；放在 README 里也不算违规。**没有约束。**
3. FAQ 的内容范围：只放「Electron / 体积 / 3D 素材」这一组，还是把整个 README 的 Q&A 都搬过去？

---

## Q4 是否接受「不修 README 那句错的，只在新文档里说清楚」？

`README.md:45-46` 是唯一的事实性错误。如果决定**先不动 README**（比如等候选 #2 落地一起改），需要接受一段时间的对外表述与实测不符。

**注意**：`README.md:13` 主动亮了 Electron 徽章，`README.md:179` 还专门解释了为什么钉在 37.x —— 这个项目**本来就在正面面对技术栈质疑**，所以「明知有句不准的话还留着」的代价，比看起来大。

---

## Q5 候选 #5 的 `App.tsx:6` 要不要动？

`App.tsx:6` 的 `import { presetConfig } from './VoiceReminderSection'` —— **只为了一个函数**，就把 41 kB 的 `VoiceReminderSection.tsx`（入口 chunk 自有代码的 11.1 %）拽进首屏。

改法是把 `presetConfig` 挪进 `src/shared/tts-preset.ts`（**该文件已经在包里**，归因 1,248 B）。

**但这会碰 `src/shared/`。** 本任务的其余候选都刻意避开了 shared 层（那里是契约层，有自己的 spec）。需要你定：
- 允许为这一条单独开 shared 的口子吗？
- 还是整条候选 #5 都往后放？

---

## Q6 要不要顺手修 spec 的行号漂移？

`.trellis/spec/frontend/hook-guidelines.md:137-152` 的定时器表**每一行的行号都是错的**（`CardView.tsx:217` 实际在 `:296`、`App.tsx:609` 实际在 `:872` ……详见 `02-optimization-candidates.md` 末尾的对照表）。

**如果候选 #4（合并两条 90 ms 轮询）由别人按这份 spec 去做，会改错行。**

选项：
- A. 本任务内一并修 spec（推荐 —— 成本低，且是本任务的直接输入）
- B. 单独开一个 task 修 spec
- C. 不修，但在这份 research 里留记录（已留）

---

## Q7 数字对外要用哪个口径？

本任务的实测有三个口径，差异很大：

| 口径 | 球形态 | 说明 |
|---|---|---|
| `sum-of-RSS`（`ps -o rss` 相加） | **558 MB** | **不能用** —— 把 4 个进程共享的 Framework 页计了 4 次 |
| `phys_footprint`（`footprint -p` 求和） | **335 – 382 MB** | ✅ 诚实口径 |
| V8 堆（CDP `Runtime.getHeapUsage`） | 5.4 MB | 只算渲染层 JS，对 Electron 应用会严重低估 |

**需要你定对外用哪个。** 我建议 `phys_footprint`，并且**必须同时说明「Electron 是 4 进程共享 Framework 的架构」**，否则 378 MB 这个数字单独看仍然会输给 6 MB 的 Tauri。

另外 `phys_footprint` 的 run-to-run 方差实测达 **47 MB**（主进程 242 ↔ 283 MB），**对外必须给区间并注明测了几次**。

---

## Q8 需不需要为 Windows 测一遍？

本轮只测了 macOS 12.7.6 x86_64。`package.json:41-42` 有 `dist:win`（nsis + zip），`README.md` 同时宣传 macOS + Windows。

差异点：
- **nsis 安装包体积**与 macOS `--dir` 不可比（nsis 会压缩）
- **进程模型不同**：Windows 没有 Mach rendezvous、没有 `footprint` 命令 → `phys_footprint` 这套口径**在 Windows 上跑不了**（只能用 `Get-Process WorkingSet` 或 PowerShell 的 `PrivateMemorySize`，都不是同一个口径）
- **托盘 / 通知路径**本来就不同

**需要你定**：这一轮只交 macOS 数字（并标注），还是要求补 Windows？
若要补，**口径怎么统一**需要先定 —— 否则两套数字放在一起反而更容易被误读。