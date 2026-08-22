#!/bin/bash
# bte seal countdown in the macOS menu bar (SwiftBar / xbar plugin).
#
# setup:
#   1. brew install swiftbar   (or xbar)
#   2. copy this file into your plugin folder, keep the .30s.sh suffix
#      (the suffix is the refresh interval)
#   3. paste a seal link into the watch file:
#        mkdir -p ~/.config/bte
#        echo 'https://peal.network/#/s/<code>' > ~/.config/bte/watch
#      (the long form .../#/s/<condition>/<cthash> still works too)
#
# the menu bar then shows the live countdown; when the seal reveals, the
# icon flips to open and clicking it opens the link.
set -u

CONF="$HOME/.config/bte/watch"

if [ ! -s "$CONF" ]; then
  echo "🔒 peal"
  echo "---"
  echo "no seal configured | color=gray"
  echo "paste a seal link into ~/.config/bte/watch"
  exit 0
fi

LINK=$(head -1 "$CONF" | tr -d '[:space:]')
ORIGIN=${LINK%%/#*}
REST=${LINK#*#/s/}
FIRST=${REST%%/*}

if [ -z "$ORIGIN" ] || [ "$REST" = "$LINK" ]; then
  echo "🔒 peal ?"
  echo "---"
  echo "watch file is not a seal link (expected .../#/s/<code>) | color=red"
  exit 0
fi

# Long form carries the condition id up front. Short form carries an 11-char
# share code that the coordinator resolves for us.
case "$FIRST" in
  cond_*) COND=$FIRST ;;
  *)
    COND=$(curl -fsS -m 10 "$ORIGIN/v0/seals/$FIRST" 2>/dev/null \
      | sed -n 's/.*"condition_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    if [ -z "$COND" ]; then
      echo "🔒 peal ?"
      echo "---"
      echo "could not resolve this seal link | color=red"
      echo "open the seal | href=$LINK"
      exit 0
    fi
    ;;
esac

JSON=$(curl -fsS -m 10 "$ORIGIN/v0/conditions/$COND" 2>/dev/null)
if [ -z "$JSON" ]; then
  echo "🔒 peal ?"
  echo "---"
  echo "coordinator unreachable at $ORIGIN | color=gray"
  echo "open the seal | href=$LINK"
  exit 0
fi

printf '%s' "$JSON" | python3 - "$LINK" <<'PY'
import json, sys, time

d = json.load(sys.stdin)
link = sys.argv[1]
status = d.get("status", "")
fires = d.get("fires_at")
now = int(time.time())

def short(secs: int) -> str:
    dd, rem = divmod(secs, 86400)
    hh, rem = divmod(rem, 3600)
    mm, ss = divmod(rem, 60)
    if dd: return f"{dd}d {hh}h"
    if hh: return f"{hh}h {mm}m"
    if mm: return f"{mm}m"
    return f"{ss}s"

if status == "revealed":
    print("🔓 revealed")
elif status == "frozen":
    print("🔓 opening…")
elif status == "stalled":
    print("🔒 stalled")
elif fires is not None:
    left = fires - now
    print(f"🔒 {short(left)}" if left > 0 else "🔒 firing now")
else:
    print("🔒 at block")

print("---")
if fires is not None:
    print(f"unlocks {time.strftime('%a %d %b, %H:%M', time.localtime(fires))}")
print(f"open the seal | href={link}")
sealed = d.get("real_count")
if sealed is not None:
    print(f"{sealed} sealed in this round | color=gray")
PY
