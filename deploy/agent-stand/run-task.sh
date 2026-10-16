#!/usr/bin/env bash
# Runs one agent task on the stand (deploy/agent-stand/README.md), from the host:
#
#   deploy/agent-stand/run-task.sh <bot> "<task>" [--minutes N] [--input file]...
#
# 1. Issues a task token for the bot (POST /api/v1/task-token) with the bot's
#    long token, which stays on the host.
# 2. Copies the inputs into /work/<taskId> in the VM.
# 3. Runs Codex there as the agent user inside sandbox-runtime, with an
#    empty environment except the task token. If srt cannot start, nothing
#    runs: there is no unsandboxed fallback.
# 4. Writes <out>/runs/<taskId>.json and prints the agent's last message.
set -euo pipefail

VM="${VM:-agent-stand}"
OUT="${OUT:-.local/agent-stand}"
bot="${1:?bot name}"
task="${2:?task text}"
shift 2
minutes=15
inputs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --minutes) minutes="$2"; shift 2 ;;
    --input) inputs+=("$2"); shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

tokens="$OUT/tokens.json"
field() { node -e 'const t=require(process.argv[1]);const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],t);if(v===undefined)process.exit(3);process.stdout.write(String(v))' "$(cd "$(dirname "$tokens")" && pwd)/$(basename "$tokens")" "$1"; }
origin=$(field origin)
long=$(field "bots.$bot.token") || { echo "no bot $bot in $tokens (run seed.mjs)" >&2; exit 2; }

task_id="run-$(date +%Y%m%d-%H%M%S)-$bot"
issued=$(curl -fsS -X POST "$origin/api/v1/task-token" \
  -H "authorization: Bearer $long" -H "content-type: application/json" \
  -d "{\"minutes\":$minutes,\"taskId\":\"$task_id\"}")
task_token=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).token)' "$issued")
scopes=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).scopes.join(" "))' "$issued")

work="/work/$task_id"
limactl shell "$VM" -- sudo install -d -o agent -g agent -m 700 "$work"
for file in "${inputs[@]}"; do
  limactl copy "$file" "$VM:/tmp/$(basename "$file")"
  limactl shell "$VM" -- sudo install -o agent -g agent -m 600 "/tmp/$(basename "$file")" "$work/$(basename "$file")"
  limactl shell "$VM" -- rm -f "/tmp/$(basename "$file")"
done
printf '%s\n' "$task" >"$OUT/.task-$task_id.md"
limactl copy "$OUT/.task-$task_id.md" "$VM:/tmp/TASK.md"
rm -f "$OUT/.task-$task_id.md"
limactl shell "$VM" -- sudo install -o agent -g agent -m 600 /tmp/TASK.md "$work/TASK.md"

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
set +e
# The token goes through stdin, not argv. NO_PROXY is cleared so the
# request to Полка (127.0.0.1) goes through srt's proxy, the only way out.
limactl shell "$VM" -- sudo -u agent bash -s <<SCRIPT
set -e
cd "$work"
exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$work" LANG=C.UTF-8 \
  CODEX_HOME=/opt/agent-stand/codex POLKA_MCP_TOKEN="$task_token" \
  srt --settings /etc/agent-stand/srt.json -c 'NO_PROXY= no_proxy= codex exec \
    --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral \
    -C "$work" -o "$work/LAST.md" "\$(cat TASK.md)"'
SCRIPT
code=$?
set -e
finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
last=$(limactl shell "$VM" -- sudo cat "$work/LAST.md" 2>/dev/null || true)

mkdir -p "$OUT/runs"
node -e '
const [file, taskId, bot, scopes, minutes, started, finished, code, last] = process.argv.slice(1);
require("node:fs").writeFileSync(file, JSON.stringify({ taskId, bot, scopes: scopes.split(" "), minutes: +minutes, started, finished, exitCode: +code, lastMessage: last }, null, 2) + "\n");
' "$OUT/runs/$task_id.json" "$task_id" "$bot" "$scopes" "$minutes" "$started" "$finished" "$code" "$last"
echo "== $task_id ($bot: $scopes, ${minutes} min) exit $code"
printf '%s\n' "$last"
exit "$code"
