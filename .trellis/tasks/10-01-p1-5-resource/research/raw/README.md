# raw/ —— 测量原始输出

每一份都是**命令的逐字 stdout**，未编辑。文件名对应 `01-baseline-measurements.md` 的引用。

| 文件 | 产生命令 | 环境 |
|---|---|---|
| `01-memory-ball-60s.txt` | `node research/measure-memory.mjs ball 60 1` | macOS 12.7.6 x86_64 / Electron 37.10.3 |
| `02-memory-figure-60s.txt` | `node research/measure-memory.mjs figure 60 1` | 同上 |
| `03-memory-ball-160s-3-collect-rounds.txt` | `node research/measure-memory.mjs ball 160 1` | 同上（3 轮采集，看逐轮泄漏） |
| `04-probe-ball-cdp.txt` | `node research/probe-renderer.mjs ball 70` | 同上（CDP 取证 + UI 切形态） |
| `05-probe-figure-cdp.txt` | `node research/probe-renderer.mjs figure 70` | 同上 |
| `06-probe-ball-threesplit-build.txt` | `node research/probe-renderer.mjs ball 45`（**在「three 拆成独立 chunk」的一次性构建下跑**，用来证明「只拆 chunk 不省内存」） | 同上 |
| `07-bundle-sizes-baseline.txt` | `ls -la out/renderer/assets/` | 当前构建产物清单 |
| `08-bundle-split-experiment.txt` | 一次性 vite 配置（写在仓库外，`outDir` 指向临时目录）把 `node_modules/three` / `src/main/qa/` / `src/renderer/src/pet3d/` 拆成独立 chunk，再 `python3 research/sourcemap-attrib.py` 按 sourcemap 归因 | 同上 |
| `09-cpu-wakeups-3-modes.txt` | 三次 `measure-memory.mjs <ball\|figure> 60 <1\|0>` 的 A0（CPU）段 | 同上 |
| `10-packaged-app-measurements.txt` | `npx electron-builder --mac --dir` → `du -sh .app` → `npx asar extract` → 逐目录 `du` | 同上（macOS x86_64，`identity: null` 未签名） |

## 复现前的准备

```bash
npm run build          # out/ 必须是最新的；两个脚本都直接跑 out/ 里的产物
```

`probe-renderer.mjs` 与 `measure-memory.mjs` 会自建一次性 `BD_USER_DATA`
（`/private/var/folders/.../T/opencode/bd-{mem,probe}-<mode>`），跑完自动 `rmSync`。
本轮实测结束时临时目录已清空，`dist/mac`（520 MB 测量产物）也已删除。

## 两条被排除的取证路径（别再试）

| 方法 | 为什么不行 |
|---|---|
| `--log-net-log=<file>` | `file://` 的模块脚本加载**不进** netlog（0 条 `file://` URL）；人物形态下还会把 network service 搞崩重启 |
| `performance.getEntriesByType('resource')` | `file://` 的 `<script type=module>` 不产生 Resource Timing 条目，实测返回空数组 |

可用的替代是 `--remote-debugging-port=0` + CDP（`Network.enable` + `Page.reload` 抓冷加载，
以及 UI 驱动切形态抓增量加载）。