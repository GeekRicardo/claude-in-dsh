#!/usr/bin/env bash
# =============================================================================
# claude-in-dsh 一键安装脚本（macOS / Linux / Windows Git Bash）
#
# 包只在 GitHub、不发 npm，因此本脚本把 github 依赖写进 profile 的
# package.json（dependencies + dsh.profile.bundles），再 pnpm install 拉取。
# 下次启动 DSH 时 profile boot 会读取包内 cordis.patch.yml 自动挂载插件行。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/GeekRicardo/claude-in-dsh/main/install.sh | bash
#   或本地：bash install.sh [--dry-run] [--restart] [--link /path/to/checkout]
#
#   --dry-run   只打印将要执行的操作，不写任何文件。
#   --restart   装完后尝试重启 DSH web（pm2 托管时自动，否则提示手动）。
#   --link DIR  用本地目录（link:DIR）而不是 GitHub 依赖，便于本地开发。
#
# 前置：本机已安装 Claude Code CLI（`claude`，需 2.1.x），dsh web 至少启动过一次。
# 环境变量（可省略）：DSH_HOME（默认 ~/.dsh）
# =============================================================================
set -euo pipefail

DSH_HOME="${DSH_HOME:-${HOME:-${USERPROFILE:-}}/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
PKG_JSON="$PROFILE_DIR/package.json"
PKG="claude-in-dsh"
DEP="github:GeekRicardo/claude-in-dsh"

DRY_RUN=false
RESTART=false
EXPECT_LINK=false
for arg in "$@"; do
  if [ "$EXPECT_LINK" = true ]; then DEP="link:${arg}"; EXPECT_LINK=false; continue; fi
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --restart) RESTART=true ;;
    --link) EXPECT_LINK=true ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: ${arg}（用 -h 查看用法）" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "未找到 node（DSH 需要 Node.js ≥ 20）"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm"
command -v claude >/dev/null 2>&1 || warn "未找到 claude CLI —— 插件装上后要驱动会话仍需要它"
[ -d "$PROFILE_DIR" ] || die "找不到 profile 目录：${PROFILE_DIR}（请先安装并运行过一次 dsh web）"
[ -f "$PKG_JSON" ] || die "找不到 ${PKG_JSON}"

if [ "$DRY_RUN" = true ]; then
  say "[dry-run] 1) 在 ${PKG_JSON} 写 dependencies[\"${PKG}\"]=\"${DEP}\""
  say "[dry-run] 2) 在 dsh.profile.bundles 追加 \"${PKG}\""
  say "[dry-run] 3) cd ${PROFILE_DIR} && pnpm install"
  say "[dry-run] 4) 校验 bundles 含 ${PKG}"
  exit 0
fi

say "目标 profile：${PROFILE_DIR}（依赖：${DEP}）"

UPDATE_RESULT="$(node -e '
const fs = require("fs");
const [p, dep, pkg] = process.argv.slice(1);
const json = JSON.parse(fs.readFileSync(p, "utf8"));
let changed = false;
json.dependencies = json.dependencies || {};
if (json.dependencies[pkg] !== dep) { json.dependencies[pkg] = dep; changed = true; }
json.dsh = json.dsh || {};
json.dsh.profile = json.dsh.profile || {};
json.dsh.profile.bundles = Array.isArray(json.dsh.profile.bundles) ? json.dsh.profile.bundles : [];
if (!json.dsh.profile.bundles.includes(pkg)) { json.dsh.profile.bundles.push(pkg); changed = true; }
if (changed) { fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n"); console.log("updated"); }
else console.log("unchanged");
' "$PKG_JSON" "$DEP" "$PKG")"
[ "$UPDATE_RESULT" = "updated" ] && say "已写入 dependencies + dsh.profile.bundles" || say "依赖与 bundles 已就绪，跳过"

say "执行 pnpm install ..."
( cd "$PROFILE_DIR" && pnpm install )

node -e '
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.exit((p.dsh?.profile?.bundles ?? []).includes(process.argv[2]) ? 0 : 1);
' "$PKG_JSON" "$PKG" || die "${PKG} 未出现在 dsh.profile.bundles，请检查 pnpm install 输出"
say "bundle 已注册（下次启动自动挂载）"

if [ "$RESTART" = true ]; then
  if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q "dsh"; then
    say "pm2 重启 dsh-web ..."
    pm2 restart dsh-web || warn "pm2 restart 失败，请手动重启"
  else
    warn "未检测到 pm2 托管的 dsh，请手动重启 dsh web"
  fi
else
  say "下一步：重启 DSH web 并硬刷新（Cmd/Ctrl+Shift+R）。"
fi
say "安装完成：${PKG}"
