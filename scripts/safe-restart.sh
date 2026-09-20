#!/usr/bin/env bash
# Restart dsh-web only when no Claude turn is in flight.
#
# Restarting dsh kills the turn its own conversations are running: dsh's crash
# recovery then closes the turn and settles the open tool call as
# TOOL_OUTCOME_UNKNOWN — the red card. The Claude process itself survives (the
# broker holds it) and the plugin drains the tail afterwards, but the
# interrupted turn is still a scar in someone's conversation. This waits for a
# quiet moment instead. Especially important when more than one agent works on
# this machine: whoever restarts blindly interrupts the other.
#
# THE CALLER IS ALSO A TURN. When Claude runs inside dsh, this script is a
# child of that Claude, which is a child of its broker — so `busy` always lists
# the very turn that is waiting, and a plain wait can never succeed. It used to
# burn the whole --wait and exit non-zero (observed: 900s spent, deploy never
# shipped, the tool card sat at "等待输出…" the entire time). So when the caller
# is itself a dsh Claude turn, the wait is handed to a detached watcher that
# outlives this turn: the tool call returns at once, the turn finishes clean,
# and the restart happens in the quiet moment right after.
#
#   bash scripts/safe-restart.sh [--wait SECONDS] [--force] [--sync] [--dry-run]
#
#   --wait N   how long to wait for the turns to finish (default 180)
#   --force    restart anyway, reporting what is being interrupted
#   --sync     wait here even when called from inside a turn (deadlocks unless
#              combined with --force; kept for use outside dsh)
#   --dry-run  report what would happen, restart nothing
set -euo pipefail

WAIT=180
FORCE=false
SYNC=false
DRY=false
DETACHED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    --sync) SYNC=true; shift ;;
    --dry-run) DRY=true; shift ;;
    --detached-for) DETACHED="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

# dsh 的端口两台机器不一样（这里 8090，那台 3080），所以从 pm2 托管的那个进程
# 实际监听的端口上拿，而不是在脚本里写一个数字然后在另一台机器上静默失败——
# 探测不出来时才退回默认值。
PM2_NAME="${PM2_NAME:-dsh-web}"
if [ -z "${DSH_PORT:-}" ]; then
  # pm2 会把「In-memory PM2 is out-of-date」这类告示也打到 stdout 上，
  # 所以只认纯数字那一行；探测不出来不算错，下面还有默认值兜着。
  _pid="$(pm2 pid "$PM2_NAME" 2>/dev/null | awk '/^[0-9]+$/{p=$1} END{print p}' || true)"
  if [ -n "$_pid" ]; then
    DSH_PORT="$(lsof -nP -iTCP -sTCP:LISTEN -a -p "$_pid" 2>/dev/null \
      | awk 'NR>1{n=split($9,a,":"); print a[n]; exit}' || true)"
  fi
fi
DSH_PORT="${DSH_PORT:-8090}"
DSH_BASE="http://127.0.0.1:${DSH_PORT}"

say() { printf '\033[32m[restart]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }

# Walk up the process tree looking for the broker that owns this Claude. Its
# argv carries the session directory, and that directory's basename is exactly
# the session id `busy` reports.
self_session() {
  local pid="$$" cmd ppid
  while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ]; do
    # `ps` and not /proc/$pid/cmdline: this script says it runs on macOS, and
    # macOS has no /proc — the whole walk silently found nothing there, so a
    # Claude turn restarting dsh never recognised itself and waited on itself.
    cmd="$(ps -ww -o command= -p "$pid" 2>/dev/null || true)"
    case "$cmd" in
      *broker.mjs*)
        printf '%s\n' "$cmd" | grep -oE '/tmp/ccmode/session-[0-9a-fA-F-]+' | head -1 | sed 's|.*/||'
        return ;;
    esac
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    [ "$ppid" = "$pid" ] && break
    pid="$ppid"
  done
}

busy_turns() {
  local skip="${1:-}"
  curl -s -m 5 -X POST "$DSH_BASE"/claude-in-dsh/rpc \
    -H 'content-type: application/json' \
    -d '{"method":"busy","args":{}}' 2>/dev/null \
    | SKIP="$skip" node -e '
      let raw = ""
      process.stdin.on("data", (chunk) => { raw += chunk })
      process.stdin.on("end", () => {
        try {
          const answer = JSON.parse(raw)
          const turns = answer && answer.ok && answer.value ? (answer.value.turns || []) : []
          const skip = process.env.SKIP || ""
          console.log(turns
            .filter((t) => skip === "" || t.sessionId !== skip)
            .map((t) => t.sessionId + "#" + t.turn).join(","))
        } catch (error) { console.log("") }
      })'
}

do_restart() {
  if [ "$DRY" = true ]; then say "dry-run：这里会执行 pm2 restart ${PM2_NAME}（端口 ${DSH_PORT}）"; return 0; fi
  pm2 restart "$PM2_NAME" >/dev/null
  for _ in $(seq 1 40); do
    # 「有 HTTP 响应」就算起来了，不要求 2xx：这台机器的 dsh 在 / 上就是 404，
    # 而 `curl -f` 把 404 当失败——脚本因此在一个早就就绪的 dsh 上空等了两分钟。
    code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "$DSH_BASE"/ || true)"
    if [ -n "$code" ] && [ "$code" != "000" ]; then say "${PM2_NAME} 已就绪（端口 ${DSH_PORT}）"; return 0; fi
    sleep 3
  done
  warn "重启后 120s 内没有就绪，检查 pm2 logs $PM2_NAME"
  return 1
}

# --- the wait loop, shared by the inline and the detached path ---------------
wait_then_restart() {
  local skip="$1" deadline
  deadline=$(( $(date +%s) + WAIT ))
  while :; do
    live="$(busy_turns "$skip")"
    [ -z "$live" ] && break
    if [ "$FORCE" = true ]; then warn "强制重启，将打断：${live}"; break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      warn "等待 ${WAIT}s 后仍有轮次在跑：${live}"
      warn "改用 --force 可强制重启（会在对方对话里留下 TOOL_OUTCOME_UNKNOWN）"
      return 1
    fi
    say "有轮次在跑（${live}），等待中…"
    sleep 5
  done
  say "无进行中的轮次，重启 $PM2_NAME"
  do_restart
}

# The detached watcher: counts every turn, its caller's included.
if [ -n "$DETACHED" ]; then
  wait_then_restart ""
  exit $?
fi

SELF="$(self_session || true)"

if [ -n "$SELF" ] && [ "$SYNC" != true ] && [ "$FORCE" != true ]; then
  others="$(busy_turns "$SELF")"
  [ -n "$others" ] && say "另有轮次在跑（${others}），排队的看门狗会一并等它们"
  say "本次调用来自 dsh 里的 ${SELF}，等待自己结束是死锁"
  if [ "$DRY" = true ]; then say "dry-run：这里会派出看门狗，本轮结束后重启"; exit 0; fi
  LOG=/tmp/ccmode/safe-restart.log
  mkdir -p "$(dirname "$LOG")"
  # macOS 没有 setsid。子 shell 里 nohup 出去同样能活过这一轮。
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup bash "$0" --wait "$WAIT" --detached-for "$SELF" >>"$LOG" 2>&1 < /dev/null &
  else
    ( nohup bash "$0" --wait "$WAIT" --detached-for "$SELF" >>"$LOG" 2>&1 < /dev/null & )
  fi
  say "已排队：本轮结束后重启 ${PM2_NAME}（日志 ${LOG}）"
  exit 0
fi

[ -n "$SELF" ] && [ "$SYNC" = true ] && [ "$FORCE" != true ] && \
  warn "--sync 且调用者本身是轮次 ${SELF}：这一定会等满 ${WAIT}s"

wait_then_restart "$([ "$SYNC" = true ] && echo "" || echo "$SELF")"
