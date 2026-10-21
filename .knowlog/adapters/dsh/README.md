# DSH（DeepSeek Harness）适配器

本机核实版本：`dsh 0.1.6-alpha.2`（安装于 npm 全局，`command -v dsh` → `<nvm>/bin/dsh`；profile 在 `$DSH_HOME/profiles/web`）。

## DSH 的机制（已核实）

- **插件 = npm 包 + patch 层**，装在 profile 里：
  ```bash
  dsh plugin --profile web add <pkg>          # pnpm 装包
  dsh --profile web --dump-config | grep <id> # 验证 patch/graph 是否生效
  ```
- profile 的层结构：`$DSH_HOME/profiles/<profile>/cordis.patch.yml`（用户层，最后应用）
- patch 层是**顶层 YAML 数组**，条目可 `insert`（插入插件行）/ 按 `id` 覆盖 config / disable：

  ```yaml
  # 摘自 dsh-context 自带 patch（真实样例）
  - insert:
      - id: dsh-context
        name: dsh-context
  ```

- `dsh --profile <p> --patch <path> --dump-config` 会**合入**这层并打印组合后的树后退出，
  **不 boot、不求值 `!!js`**（`@deepseek-ai/dsh/apps/cli` 的 `dump-config` 模块原话：
  "compose the profile's patch layers through the include plugin's patch algorithm
  without booting or evaluating `!!js`"）→ 所以它是安全的 dry-run。
- `insert` 条目里的 `name` 若以 `./` 或 `../` 开头，会被锚成**相对于该 patch 文件的 `file://` URL**
  （`@deepseek-ai/dsh-app-boot` 的 `anchorInsertedPluginNames`）——这给了我们"免安装"路线。

## 每轮注入的官方机制：`agent/pre-step` waterfall（本轮定位并落地）

> 结论：DSH 的每轮注入点是 **`agent/pre-step` 这个 waterfall 事件**。
> 不存在"某个 prompt/context 服务上调用 `.inject()`"这种 API——之前 `bridge/lib/index.js`
> 里那处 `TODO_INJECT`（探测 `ctx.get('prompt'/'context'/…).inject`）**方向是错的**，已删除。

契约来自 `@deepseek-ai/dsh-agent` 的 `lib/types/runtime-types.d.ts`（原文摘抄）：

```ts
'agent/pre-step'(this: Scoped<Agent>, payload: {
    agent: Agent;
    messages: UserMessage[];   // 本步从 inbox 领取的消息（首步就是用户这次提交的 prompt）
    turn: number;
    step: number;
    signal: AbortSignal;
}, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;

type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; ... };
```

官方文档描述（`@deepseek-ai/dsh-agent/README.md`）：**"`agent/pre-step` can reject a proposed
step or replace the messages entering it"** —— 每轮注入就是用它"替换进入该步的消息"。

正确写法（与第一方 `dsh-time-context` 逐行同形）：

```js
ctx.on("agent/pre-step", async ({ agent, messages, turn, step, signal }, next) => {
  const decision = await next();                 // ① 先委托下游（添加上下文 ≠ 否决）
  if (decision.kind !== "enter" || signal.aborted) return decision;
  return {
    ...decision,
    messages: [...decision.messages, contextMessage],   // ② 往后追一条带来源的 UserMessage
  };
}, { prepend: true });
```

注入内容**必须**是 `@deepseek-ai/dsh-llm` 的 `UserMessage`（有 `id` + `source`），不能是裸对象：

```js
import { createUserMessage } from "@deepseek-ai/dsh-llm";
createUserMessage({
  content: [{ type: "text", text: hits }],
  source: { kind: "plugin", plugin: "docs-recall", form: "snapshot",
            sections: [{ name: "docs-recall", text: hits }] },
});
```

`source.form` 的取值是一张官方表（`dsh-llm` 的 `ContextForm`）：`instructions` / `catalog` /
`snapshot` / `notice` / `relay` / `recall`（其中 `recall` 专指"从别的会话日志里搬来的材料"，
**不是**我们这种项目文档召回，故用 `snapshot`）。

### 两个真实宿主约束（本机实测踩过，必须知道）

1. **`web` profile 是常驻进程**（launchd 托管，本机 `com.dsh.doctor`），而且它的 **cwd 是 `/`**。
   两个直接后果：
   - 改完 profile 或插件代码后**必须重启**才生效（进程启动时只加载一次）：
     ```bash
     launchctl kickstart -k gui/$(id -u)/com.dsh.doctor     # 重启 DSH 服务（会断开当前会话）
     ```
   - **绝不能在 `apply()` 里用进程 cwd 定位项目**：那会是 `/`，插件在任何项目里都失效。
     正确姿势是**每一轮**问官方服务要该会话的工作目录：
     ```js
     const dir = await ctx.workingDirectory.ensure(agent, signal);   // 服务来自 @deepseek-ai/dsh-working-directory
     ```
     第一方 `dsh-tool-skill` 就是这么拿 cwd 的。本插件的兜底顺序：
     **显式绝对 `config.root` → `workingDirectory.ensure` → `agent.session.meta.cwd` → 进程 cwd**。

2. **两处日志，别找错地方**（`~/.dsh/docs-recall.log` 的「plugin loaded」**不需要调试开关**，每次宿主启动一行；其余日志需 `DOCS_RECALL_DEBUG=1`）：
   | 日志 | 位置 | 说明什么 |
   |---|---|---|
   | 加载/卸载 | `~/.dsh/docs-recall.log`（即 `$DSH_HOME`） | **插件有没有被加载** —— 没这行就说明 profile 没生效或没重启 |
   | 每轮注入 | `<项目>/.dsh/docs-recall.log` | **这一轮有没有注入**，以及注入了多少字符、用的哪个 root |

   验证时要**在会话里发一句带代码标识符的话**（召回表按标识符命中，例如 `帮我看看 codeMode 的扣减逻辑`）；
   在会话里敲 shell 命令（如 `DOCS_RECALL_DEBUG=1 dsh --profile web`）会被当成聊天内容发给模型，不会启动任何东西。

### 三个「配置看着都对、插件却不生效」的坑（本轮真机逐个踩到）

1. **peer 区间与运行时不符 → 整个插件被判不兼容并禁用**（最隐蔽的一个）。
   DSH 的规则原文（`dsh-app-boot` 的 `evaluatePluginCompatibility` 注释）：
   > An own `engines.dsh` range decides alone and **peerDependencies are ignored**;
   > otherwise **every `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` peer must match**.

   事故经过：`bridge/package.json` 曾声明 `"@deepseek-ai/dsh-llm": "^0.1.6-alpha.2"`，
   而运行时装的是 `0.2.1-rc.2` → 判定为不兼容 → **整行 `docs-recall` 被禁用**（配置里看不到任何报错，
   插件只是永远不加载）。
   修法：用 **`engines.dsh` 一锤定音**（本插件声明 `>=0.1.6-alpha.2`），并**删掉那个 peer** ——
   它本来就是 optional + 动态 import + 有本地等价实现，声明成 peer 只会误伤自己。
   回归守卫：`verify.sh` 的 **V6** 直接用 DSH 自己的判定函数验一遍。

2. **`name` 指「目录」还是指「入口文件」**：指目录会走 **manifest**（并可能连带加载它的 `dsh.bundle.patch`）——
   而本包是 bundle（其 patch 里 insert 的是**裸包名** `docs-recall-dsh`，走 bundle 安装路线时才有意义），
   在"仅用 patch 叠加"的场景下会多出一个解析不到的 insert。
   → **profile patch 里推荐指向入口文件**（本机验证通过的形态）：
   ```yaml
   - insert:
       - id: docs-recall
         name: file:///<已安装 skill>/adapters/dsh/bridge/lib/index.js
   ```
   走 bundle 安装路线（`dsh plugin add <bridge>`）时，包内 `cordis.patch.yml` 的裸包名才有意义。

3. **宿主是常驻进程 + 终端 export 传不进**：见上一节 —— 必须重启服务，且调试开关要用 `launchctl setenv`（或写进 plist）。

### 四处真实先例（本机可读，本适配器照抄其形状）

| 先例 | 位置 | 做了什么 |
|------|------|----------|
| `@deepseek-ai/dsh-time-context`（第一方） | 全局 dsh 包内 | `pre-step` + `prepend:true`，每轮往后追一条 sourced `UserMessage` |
| `@deepseek-ai/dsh-agent-instructions`（第一方） | 同上 | **首个** `pre-step` 把 `AGENTS.md` 基线折进进入批次 |
| `@deepseek-ai/dsh-tool-skill`（第一方） | 同上 | `pre-step` 里比对 skill 目录 digest，变了就交给 `enter` 决策一条新目录消息 |
| `dsh-mnemon`（第三方，用户 profile 已装） | `~/.dsh/profiles/web/node_modules/dsh-mnemon/lib/index.js` | `agent.ctx.on("agent/pre-step", …, { prepend: true })` 做**每轮记忆召回** |

另外，`Claude Code` 的 `UserPromptSubmit` 钩子在 DSH 里也是被
`@deepseek-ai/dsh-hooks-claude-code` **映射到 `agent/pre-step`** 的
（其 README："`UserPromptSubmit` … are waterfalls that can reject the incoming action
(`agent/pre-step` …)"）——这反过来印证了这个就是官方的"每轮"seam。

### 备选（更简单，但不适合本项目）

`agent.inject(userMessage)` 也能往上下文塞内容（`UserMessage` 的 `inject` 方法：
"Queue model-facing context for the next pre-step without waking the driver"）。
但它拿不到"本轮用户提交了什么文本"，只能盲注入；我们要按 prompt 做关键词召回，
所以选 `pre-step`。

## 两种落地方式

### 方式 A（推荐，零新代码）：把本仓文档挂进 DSH 的上下文

DSH 的上下文/系统提示由它自己的插件（如 `dsh-agent-instructions`、`dsh-tool-skill`）构成。
本仓的**静态约束**（日志/知识/领域/门禁）已经写在根 `AGENTS.md` 的 `KNOWLOG` 托管块里，
会被 `dsh-agent-instructions` 在**首个 `agent/pre-step`** 折进上下文（这正是上面表里的先例之一），
所以 DSH 侧只要保证工作目录是本仓即可。

**关键词召回**用命令行兜底（与其它 agent 完全同源）：

```bash
bash .knowlog/knowledge-retrieve.sh "<prompt 或代码片段>"
```

DSH **原生吃 skill**（`npx skills add <本 skill 的仓库或路径>` 装进去即可；本机已有先例：
129 个 skill 都是这么装的）——所以"让 agent 认识 knowlog"不需要任何插件。

### 方式 B：真正的 DSH 召回桥接插件（本目录 `bridge/`）

桥接包把"每轮召回"接到上面那个官方 seam 上：

```
adapters/dsh/bridge/
├── package.json          # dsh.bundle.patch: "./cordis.patch.yml"
├── cordis.patch.yml      # 包内 patch（`dsh plugin add` 路线用裸包名 docs-recall-dsh）
├── lib/index.js          # 插件本体：注册 agent/pre-step，调 .knowlog/recall-core.py
└── selftest.mjs          # 离线功能自测（16 条断言，不起 DSH）
```

两条安装路线（**都不改宿主全局配置**，固化为默认行为需要你自己动 `~/.dsh`）：

```bash
# 路线 1（免 pnpm、项目内自包含）：patch 里写相对路径，DSH 会锚成 file://…/.dsh/bridge
#   scripts/install-recall.sh --agent dsh 已经帮你落成这个形态
dsh --profile web --patch .dsh/docs-recall.patch.yml --dump-config | grep -A6 docs-recall

# 路线 2（装成包，与 dsh-context 同构）
dsh plugin --profile web add "$PWD/adapters/dsh/bridge"
# 然后 patch 里用裸包名 name: docs-recall-dsh
dsh --profile web --patch adapters/dsh/cordis.patch.yml --dump-config | grep -A6 docs-recall
```

**固化**（只改你自己的 profile，脚本不代劳）：把 patch 的 `insert` 段并进
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`。

## ⚠️ 已验证 vs 未验证（别混淆）

### 已验证（本机、非破坏性；一条命令可复现全部：`bash adapters/dsh/verify.sh`）

| 项 | 证据（命令 → 结果） |
|----|----------------------|
| DSH 已安装、版本 | `command -v dsh` → `<nvm>/bin/dsh`；`dsh --version` → `0.1.6-alpha.2` |
| `--dump-config` 是纯 dry-run（不 boot/不求值 `!!js`） | 读 `@deepseek-ai/dsh/dump-config-*.js` 源码原文 |
| patch 写法 `- insert: [{id, name, config}]` | `dsh --profile web --patch adapters/dsh/cordis.patch.yml --dump-config` → exit 0，尾部出现 `- id: docs-recall` + `config{root, core, maxChars, minQueryChars}` |
| 包内 patch（`dsh.bundle.patch` 指向的那份）同样可解析 | 同上，对 `bridge/cordis.patch.yml` 也 exit 0 |
| `dsh.bundle.patch` 声明的路径**真的存在** | 用 DSH 自己的 `loadOverlayPatches` 解析 → `OK …/bridge/cordis.patch.yml entries=1`（**回归守卫**：路径写错会 fail-loud） |
| 相对 `name: ./bridge` 被锚成 `file://` | `--dump-config` 输出 `name: file:///…/.dsh/bridge` |
| `@deepseek-ai/dsh-llm` 在 profile 里可解析 | 从 `~/.dsh/profiles/web` 侧 `import('@deepseek-ai/dsh-llm')` → 列出 `createUserMessage` 等导出 |
| 「每轮注入」= `agent/pre-step` waterfall | 读 `@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts` 的签名 + `PreStepDecision`；4 处真实实现（含用户已装的 `dsh-mnemon`）都用它 |
| 插件**功能**正确（16 条断言） | `node adapters/dsh/bridge/selftest.mjs` → `16 passed, 0 failed`（假 ctx + 合成 payload 驱动真实监听器） |
| 官方构造器分支也正确 | `verify.sh` V4 用 profile 侧解析跑同一套断言 → `16 passed, 0 failed`；缺包时走本地等价实现（与上游 `createMessage` 逐字一致） |
| 找不到 `recall-core.py` 时完全静默退出 | selftest 断言：不注册任何监听器（不会弄坏宿主） |

- ✅ **真实会话里每轮注入生效**（2026-10-19 本机实测，DSH `0.1.6-alpha.2` + `web` profile，launchd 常驻）：
  ```
  [2026-10-19T09:00:57.419Z] turn 1 step 1: 注入 338 chars（本地等价实现）root=<项目目录>
  ```
  对应会话里发的是 `帮我看看 codeMode 的扣减逻辑`，注入的正是召回表里那条「一瓶一码双轨…漏 parent 扣减致幻影 + 文档路径」。
  这条同时证明了三件事：① profile 生效（`~/.dsh/docs-recall.log` 有 `plugin loaded`）；
  ② **会话目录按每轮解析正确**（root 是项目目录而不是常驻进程的 `/`）；③ 召回真的进了模型上下文。
  > 附注：日志里的「本地等价实现」是因为本插件的安装位置（`~/.agents/skills/…`）解析不到 DSH 自己的
  > `@deepseek-ai/dsh-llm`，于是退回与上游 `createMessage` 逐字一致的本地构造；**消息形状一致、实测可用**。
  > 若将来 `UserMessage` 加了必填字段，优先改这里的构造（`userMessageCtor()`）。

### 未验证（需要你参与的一次动作）

| 项 | 为什么没验 | 怎么补 |
|----|-----------|--------|
| `./bridge` 免安装路线 | 解析层已验证（`verify.sh` V5 锚定为 `file://…`）；**尚未在真实会话里跑过** | 想验：在项目里 `dsh --profile web --patch .dsh/docs-recall.patch.yml` 起一次会话 |
| 相对 `name: ./bridge` 能被**加载**（不只是被锚定） | 只验到 `--dump-config` 的解析/锚定层，没 boot | 上面那次会话同时能覆盖；失败只影响这一行，删掉 patch 行即恢复 |
| bundle 路线在全新 profile 上的行为 | 需要 `dsh plugin add`（会写 profile + 装包） | 需要时手动跑路线 2 |

## 兜底路径（永远可用，与插件同一份召回核心）

插件只是"自动召回"的加分项；**不装插件也完全能用**：

```bash
bash .knowlog/knowledge-retrieve.sh "<prompt 或代码片段>"     # 命令行召回
git diff --cached | bash .knowlog/knowledge-retrieve.sh       # 拿暂存区当查询
```

`AGENTS.md` 的 `KNOWLOG` 托管块（静态约束）仍然是**默认必须**的那一层。

## 三档可靠性排序（选型建议）

| 方案 | 是否自动 | 可靠性 | 适合谁 |
|------|----------|--------|--------|
| `AGENTS.md` 托管块（静态约束，经 `dsh-agent-instructions` 注入） | 每个会话首个 pre-step 必读 | 高（各 agent 通用） | 所有人，默认必须 |
| 命令行召回 `knowledge-retrieve.sh` | 手动/由 agent 按规范调用 | 高（同一份 core） | 所有 agent 的兜底 |
| bridge 插件（本目录） | 自动（每轮 `pre-step` 注入命中） | 中（依赖 DSH 跨版本保持 `agent/pre-step` 契约） | 想吃到"自动召回"的 DSH 用户 |

## 维护者备注

- 机制若跨版本变了，**只有一处要改**：`bridge/lib/index.js` 里 `ctx.on("agent/pre-step", …)`
  那一个监听器（注入点已单独抽出，不再有"探测 + 记录"式的模糊代码）。
- 改了 `bridge/` 后跑 `bash adapters/dsh/verify.sh`（6 项，全部只读/dry-run/临时目录）。
- `adapters/dsh/cordis.patch.yml` 是指向 `bridge/cordis.patch.yml` 的**软链接**：
  前者给 `--patch` dry-run 用（路径短），后者是 `package.json` 里 `dsh.bundle.patch`
  真正解析的那份（DSH 用 `join(packageDir, declared)`，不同级会 fail-loud）。改一处即可。
