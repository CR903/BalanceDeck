/**
 * docs-recall.ts — OpenCode **v1** 插件：每轮把关键词召回注入用户消息
 *
 * ⚠️ 版本前提（这条很重要，别装错）：
 *   - 本插件用的是 **v1 插件 API**（`@opencode-ai/plugin` 的 `chat.message` 钩子，见其 `dist/v1/index.d.ts`）。
 *   - OpenCode **v2**（如 v2.0.32）的插件是 Effect 注册式 API，**不认这个钩子名** —— 实测：装了也不报错、
 *     也不会被调用（静默失效）。v2 请改用 `opencode.json` 的 `instructions`（见同目录 recall-instructions.md），
 *     那是本项目**已实测生效**的注入路径。
 *   - 判断当前版本：`opencode --version`；v1/v2 都可用 `opencode debug config` 看配置来源。
 *
 * 设计要点：
 *   - 匹配逻辑不在本文件：调用 `scripts/recall-core.py`（与 Claude/Codex 钩子同源）
 *   - 全段 try/catch：插件抛错会污染会话，宁可不注入也不能弄坏宿主
 *   - 调试：`DOCS_RECALL_DEBUG=1` → 写 `.opencode/docs-recall.log`（含"插件已加载"这一行，
 *     用它区分"没加载"和"加载了但没命中"）
 */
export const DocsRecall = async ({ directory, $ }: any) => {
  const debug = process.env.DOCS_RECALL_DEBUG === "1"
  let fs: any = null
  try {
    fs = await import("node:fs")
  } catch {
    /* 无 fs 时退化为不写调试日志 */
  }
  const logPath = `${directory}/.opencode/docs-recall.log`
  const log = (line: string) => {
    if (!debug || !fs) return
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`)
    } catch {}
  }
  log("plugin loaded（opencode-v1 钩子路径；v2 上此行不会出现，属预期）")

  return {
    "chat.message": async (_input: any, output: any) => {
      log("chat.message fired")
      try {
        const parts = Array.isArray(output?.parts) ? output.parts : []
        const text = parts
          .filter((p: any) => p?.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text)
          .join("\n")
          .trim()
        log(`parts=${parts.length} textLen=${text.length}`)
        if (!text) return

        const res = await $`python3 ${directory}/scripts/recall-core.py --query ${text}`
          .quiet()
          .nothrow()
        const hint = (res?.stdout ?? "").toString().trim()
        if (!hint) {
          log("no-hit")
          return
        }
        parts.push({ type: "text", text: "\n" + hint })
        log(`injected ${hint.length} chars`)
      } catch (e: any) {
        log(`error: ${e?.message ?? e}`)
      }
    },
  }
}
