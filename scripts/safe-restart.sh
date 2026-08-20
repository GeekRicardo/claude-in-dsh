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
#   bash scripts/safe-restart.sh [--wait SECONDS] [--force]
#
#   --wait N   how long to wait for the turns to finish (default 180)
#   --force    restart anyway, reporting what is being interrupted
set -euo pipefail

WAIT=180
FORCE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --wait) WAIT="$2"; shift 2 ;;
    --force) FORCE=true; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[32m[restart]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }

busy_turns() {
  curl -s -m 5 -X POST http://127.0.0.1:8090/claude-in-dsh/rpc \
    -H 'content-type: application/json' \
    -d '{"method":"busy","args":{}}' 2>/dev/null \
    | node -e '
      let raw = ""
      process.stdin.on("data", (chunk) => { raw += chunk })
      process.stdin.on("end", () => {
        try {
          const answer = JSON.parse(raw)
          const turns = answer && answer.ok && answer.value ? (answer.value.turns || []) : []
          console.log(turns.map((t) => t.sessionId + "#" + t.turn).join(","))
        } catch (error) { console.log("") }
      })'
}

deadline=$(( $(date +%s) + WAIT ))
while :; do
  live="$(busy_turns)"
  [ -z "$live" ] && break
  if [ "$FORCE" = true ]; then
    warn "强制重启，将打断：${live}"
    break
  fi
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    warn "等待 ${WAIT}s 后仍有轮次在跑：${live}"
    warn "改用 --force 可强制重启（会在对方对话里留下 TOOL_OUTCOME_UNKNOWN）"
    exit 1
  fi
  say "有轮次在跑（${live}），等待中…"
  sleep 5
done

say "无进行中的轮次，重启 dsh-web"
pm2 restart dsh-web >/dev/null
for _ in $(seq 1 40); do
  if curl -sf -m 3 http://127.0.0.1:8090/ -o /dev/null; then say "dsh-web 已就绪"; exit 0; fi
  sleep 3
done
warn "重启后 120s 内没有就绪，检查 pm2 logs dsh-web"
exit 1
