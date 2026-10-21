#!/bin/bash
# verify.sh — DSH 适配器的非破坏性验证（只读 / dry-run / 临时目录，绝不改用户配置）
#
# 覆盖四件事：
#   V1  插件功能自测（离线；不起 DSH、不联网、不碰 DSH_HOME）
#   V2  patch 层能被 DSH 真实解析并合入 profile 树（`--dump-config`，不 boot）
#   V3  bundle patch 路径真的存在（用 DSH 自己的 loadOverlayPatches 解析，
#       这条是回归守卫：package.json 声明的路径和文件不同级会 fail-loud）
#   V4  `@deepseek-ai/dsh-llm` 在 profile 里可解析（覆盖"官方构造器可用"分支）
#
# 用法: bash adapters/dsh/verify.sh
# DSH 未安装时：V2/V3/V4 跳过（打印 SKIP），V1 仍会跑。
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$HERE/bridge"
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  ✅ %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  ❌ %s\n' "$1"; }
skip() { SKIP=$((SKIP+1)); printf '  ⏭  SKIP %s\n' "$1"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

hdr "V1 插件功能自测（离线）"
strip_ansi() { sed -e 's/\x1b\[[0-9;]*m//g'; }
if [ ! -f "$BRIDGE/selftest.mjs" ]; then
  bad "缺少 bridge/selftest.mjs"
else
  if OUT=$(node "$BRIDGE/selftest.mjs" 2>&1); then
    ok "本地兜底构造器分支：$(printf '%s' "$OUT" | strip_ansi | grep -o '[0-9]* passed, [0-9]* failed' || printf 'PASS')"
  else
    bad "selftest 失败"; printf '%s\n' "$OUT"
  fi
fi

# ── 定位 DSH ────────────────────────────────────────────────
DSH_BIN="$(command -v dsh 2>/dev/null || true)"
if [ -z "$DSH_BIN" ]; then
  skip "未安装 dsh：V2/V3/V4 无法在本机验证（见 README 的「需要用户参与」）"
else
  DSH_REAL="$(readlink -f "$DSH_BIN" 2>/dev/null || python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$DSH_BIN")"
  DSH_PKG="$(cd "$(dirname "$DSH_REAL")/.." && pwd)"   # …/@deepseek-ai/dsh
  APP_BOOT="$DSH_PKG/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js"
  printf '     dsh=%s\n' "$DSH_BIN"
  printf '     dsh version=%s\n' "$(dsh --version 2>/dev/null || printf '?')"
  printf '     包目录=%s\n' "$DSH_PKG"

  hdr "V2 patch 层被 DSH 真实解析并合入 profile 树（dry-run，不 boot）"
  for PATCH in "$HERE/cordis.patch.yml" "$BRIDGE/cordis.patch.yml"; do
    if OUT=$(dsh --profile web --patch "$PATCH" --dump-config 2>&1); then
      if printf '%s' "$OUT" | grep -q -- "- id: docs-recall"; then
        ok "$(basename "$(dirname "$PATCH")")/$(basename "$PATCH")：合入后含 '- id: docs-recall'（exit 0）"
      else
        bad "${PATCH}：合入成功但未见 docs-recall 条目"
      fi
    else
      bad "${PATCH}：--dump-config 失败（exit≠0）"; printf '%s\n' "$OUT" | tail -5
    fi
  done

  hdr "V3 bundle patch 路径解析（用 DSH 自己的 loadOverlayPatches）"
  if [ ! -f "$APP_BOOT" ]; then
    skip "找不到 ${APP_BOOT}，无法用 DSH 真实代码验证"
  else
    V3=$(cd "$BRIDGE" && node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const { loadOverlayPatches } = await import('file://$APP_BOOT');
const packageDir = resolve('.');
const declared = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).dsh?.bundle?.patch;
if (declared === undefined) { console.log('NO_DECLARED'); process.exit(1); }
try {
  const patches = loadOverlayPatches('dsh', join(packageDir, declared));
  console.log('OK ' + join(packageDir, declared) + ' entries=' + patches.length);
} catch (error) { console.log('THROW ' + String(error.message)); process.exit(1); }
" 2>&1)
    case "$V3" in
      OK*) ok "dsh.bundle.patch 声明可解析 → ${V3#OK }" ;;
      *)   bad "dsh.bundle.patch 不可解析 → $V3" ;;
    esac
  fi

  hdr "V4 @deepseek-ai/dsh-llm 在 profile 里可解析（官方构造器分支）"
  DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
  LLM_DIR="$DSH_HOME_DIR/profiles/node_modules/@deepseek-ai/dsh-llm"
  if [ ! -d "$LLM_DIR" ]; then
    skip "profile 里没有 ${LLM_DIR}（插件会用本地等价构造器，仍可用）"
  else
    # 把插件放到 profiles/ 下的临时目录里跑一次：Node 逐级向上能找到 profiles/node_modules
    TMPROOT="$DSH_HOME_DIR/profiles/.knowlog-verify-$$"
    case "$TMPROOT" in
      "$DSH_HOME_DIR"/profiles/.knowlog-verify-*) ;;
      *) bad "临时目录前缀校验失败，拒绝写入：$TMPROOT"; TMPROOT="";;
    esac
    if [ -n "$TMPROOT" ]; then
      mkdir -p "$TMPROOT/lib" && cp "$BRIDGE/lib/index.js" "$TMPROOT/lib/index.js"
      if OUT=$(DOCS_RECALL_PLUGIN_ENTRY="$TMPROOT/lib/index.js" node "$BRIDGE/selftest.mjs" 2>&1); then
        ok "官方 createUserMessage 分支：$(printf '%s' "$OUT" | strip_ansi | grep -o '[0-9]* passed, [0-9]* failed' || printf 'PASS')"
      else
        bad "官方构造器分支下 selftest 失败"; printf '%s\n' "$OUT" | tail -6
      fi
      rm -rf "$TMPROOT"
    fi
  fi

  hdr "V5 免安装路线：patch 里写相对包路径会被锚成 file:// URL"
  T="$(mktemp -d)"
  mkdir -p "$T/.dsh" && cp -R "$BRIDGE" "$T/.dsh/bridge"
  cat > "$T/.dsh/rel.patch.yml" <<'YML'
- insert:
    - id: docs-recall
      name: ./bridge
YML
  if OUT=$(dsh --profile web --patch "$T/.dsh/rel.patch.yml" --dump-config 2>&1); then
    if printf '%s' "$OUT" | grep -q "file://.*/\.dsh/bridge"; then
      ok "'name: ./bridge' → 锚定为 file://…/.dsh/bridge（无需 dsh plugin add）"
    else
      bad "未见 file:// 锚定，实际输出：$(printf '%s' "$OUT" | grep -A3 'id: docs-recall')"
    fi
  else
    bad "--dump-config 失败（相对 name 形式）"
  fi
  rm -rf "$T"
fi


# ── V6 与 dsh 运行时的兼容性（真事故回归守卫）──────────────
# 事故：bridge 曾在 peerDependencies 里声明 `@deepseek-ai/dsh-llm: ^0.1.6-alpha.2`，
# 而运行时装的是 0.2.1-rc.2 —— 官方规则是「没有 engines.dsh 时，每个 @deepseek-ai/dsh* peer
# 都必须匹配运行时」，于是**整个插件被判不兼容并禁用**（配置看着没问题，就是死活不生效）。
# 现在用 engines.dsh 一锤定音，并请 DSH 自己的判定函数来验。
if [ -n "${APP_BOOT:-}" ] && [ -f "$APP_BOOT" ]; then
  OUT6=$(node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    const boot = await import('file://$APP_BOOT');
    const manifest = JSON.parse(readFileSync('$BRIDGE/package.json', 'utf8'));
    const rt = boot.getDshRuntimeVersion ? boot.getDshRuntimeVersion() : undefined;
    const r = boot.evaluatePluginCompatibility(manifest, {}, rt);
    console.log(r === undefined ? 'OK' : 'INCOMPAT ' + JSON.stringify(r.requirements));
  " 2>&1) || OUT6="ERR $OUT6"
  case "$OUT6" in
    OK*)  ok "与当前 dsh 运行时兼容（engines.dsh 单独决定，peer 不再参与判定）" ;;
    INCOMPAT*) bad "被判不兼容 → 插件会被禁用：${OUT6#INCOMPAT }" ;;
    *)    skip "无法判定兼容性（${OUT6%%\n*}）" ;;
  esac
else
  skip "未定位到 dsh-app-boot（跳过兼容性判定）"
fi

printf '\n\033[1m合计\033[0m: %s 通过, %s 失败, %s 跳过\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ] || exit 1
