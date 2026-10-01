# 改动前基线（HEAD = 6c81361，src/ 与 scripts/ 无本地改动）

采集方式：`node scripts/test-<name>.mjs > out 2>&1`，断言数 = 输出中 `✓` 的行数。
每条 summary 行原样记录。

| # | 套件 | 脚本 | 断言数 | summary 行（改动前） |
|---|---|---|---|---|
| 1 | percent | test-percent.mjs | 21 | 结果：21 通过 / 0 失败 |
| 2 | ssr | test-ssr-parser.mjs | 72 | 结果：72 通过 / 0 失败 |
| 3 | quality | test-quality.mjs | 32 | 结果：32 通过 / 0 失败 |
| 4 | tray | test-tray.mjs | 98 | 结果：98 通过 / 0 失败 |
| 5 | pet | test-pet.mjs | 43 | 结果：43 通过 / 0 失败 |
| 6 | gesture | test-gesture.mjs | 58 | gesture: 58 通过 / 0 失败 |
| 7 | adapters | test-adapters.mjs | 166 | 通过 166 项，失败 0 项 |
| 8 | structure | test-structure.mjs | 85 | 通过 85 项，失败 0 项 |
| 9 | read-model | test-read-model.mjs | 118 | 通过 118 项，失败 0 项 |
| 10 | voice | test-voice.mjs | 49 | 通过 49 项，失败 0 项 |
| 11 | speech-out | test-speech-out.mjs | 197 | 通过 197 项，失败 0 项 |
| 12 | trigger-engine | test-trigger-engine.mjs | 146 | 通过 146 项，失败 0 项 |
| 13 | alert-orchestration | test-alert-orchestration.mjs | 240 | 通过 240 项，失败 0 项 |
| 14 | system-notify | test-system-notify.mjs | 73 | 通过 73 · 失败 0 |
| 15 | usage-predict | test-usage-predict.mjs | 104 | 通过 104 · 失败 0 |
| 16 | usage-store | test-usage-store.mjs | 42 | 通过 42 · 失败 0 |
| 17 | usage-history | test-usage-history.mjs | 72 | 通过 72 · 失败 0 |
| 18 | cli-export | test-cli-export.mjs | 107 | 通过 107 · 失败 0 |
| | **合计** | | **1723** | 18 套件全绿，18/18 exit=0 |

`test-structure.mjs` 断言「目录清单 / 关闭集合」等静态事实，本任务不新增 `src/main/qa/` 文件，
故 85 是它的稳定基线；`adapters` 段断言 `PROTOCOLS` 为 8 条，本任务不碰 protocols.ts，故 166 是稳定基线。
