#!/usr/bin/env bash
# The check kit of the contour stand (deploy/contour-stand/README.md): what
# the security team runs to see that a profile's lines hold. From the host:
#
#   deploy/contour-stand/checks.sh
#
# 1. A sandbox of profiles/probe.yaml, with exactly what an agent gets, tries
#    to step out (agent/probe.sh): internet, the control plane, the git
#    token, protected main, the budget, Полка's limits.
# 2. Outside, where the real values are known, the sandbox's environment is
#    searched for every secret of the stand.
# 3. A user without the profile's role is refused.
# 4. A running task is revoked: process, model key and network, timed.
# 5. The swarm's boundaries (swarm.mjs selftest): the gateway, the policy,
#    signature, acceptance on Полка, the skill catalog.
# 6. The finance stand's boundaries (deploy/finance-stand, fin.mjs selftest),
#    when it is installed: tokens, no payment effect, the journal's rules.
# Exit code 0 only if every line is «ok».
set -euo pipefail
cd "$(dirname "$0")"
VM="${VM:-contour}"
vm() { limactl shell --workdir /opt/contour "$VM" -- sudo "$@"; }
fail=0
line() { printf '%-4s %-22s %s\n' "$1" "$2" "$3"; [ "$1" = ok ] || fail=1; }

echo "== 1. Пробы изнутри песочницы (профиль probe)"
id=$(./stand.sh run start profiles/probe.yaml "Проверки границ" --as ivanov | tail -1)
./stand.sh run wait "$id" >/dev/null
log=$(vm cat "/var/lib/contour/work/$id/container.log")
probes=$(printf '%s\n' "$log" | sed '/^--- env$/,$d' | grep -E '^(ok|fail) ')
while read -r verdict name _ detail; do line "$verdict" "$name" "$detail"; done <<<"$probes"
[ -n "$probes" ] || line fail probes "no output: $(printf '%s' "$log" | tail -3)"

echo "== 2. Секреты в окружении песочницы"
envdump=$(printf '%s\n' "$log" | sed -n '/^--- env$/,$p')
# The VM checks for each real value without printing any of them.
found=$(printf '%s' "$envdump" | vm bash -c '
  dump=$(cat); bao=$(jq -r .root_token /etc/contour/bao-init.json)
  get() { curl -fsS "http://127.0.0.1:8200/v1/contour/data/$1" -H "x-vault-token: $bao" 2>/dev/null | jq -r ".data.data.$2" 2>/dev/null; }
  for pair in "upstream api_key" "litellm master_key" "git/agent-bot token" "polka/report-bot token" "users/ivanov password"; do
    set -- $pair; v=$(get "$1" "$2"); [ -n "$v" ] && [ "$v" != null ] || { echo "$1:absent"; continue; }
    case "$dump" in *"$v"*) echo "$1:LEAKED" ;; *) echo "$1:clean" ;; esac
  done; grep -q "$bao" <<<"$dump" && echo "openbao-root:LEAKED" || echo "openbao-root:clean"')
while IFS=: read -r name state; do
  case "$state" in clean) line ok "secret:$name" "нет в окружении" ;; absent) line ok "secret:$name" "не задан на стенде" ;; *) line fail "secret:$name" "найден в окружении" ;; esac
done <<<"$found"

echo "== 3. Поручить без роли"
if out=$(./stand.sh run start profiles/probe.yaml "Проверки границ" --as petrov 2>&1); then
  line fail delegate-without-role "задача запущена"
else
  line ok delegate-without-role "$(printf '%s' "$out" | tail -1 | sed 's/^dispatcher: //')"
fi

echo "== 4. Отзыв работающей задачи"
id=$(./stand.sh run start profiles/probe.yaml "Отзыв" --as ivanov --command "sleep 600" | tail -1)
revoked=$(./stand.sh run revoke "$id")
times=$(vm bash -c "grep '\"event\":\"revoked\"' /var/lib/contour/events/$id.jsonl | jq -c '{process_killed_ms,model_key_deleted_ms,network_closed_ms}'")
running=$(vm docker ps -q --filter "label=contour.task=$id")
acl=$(vm grep -c "$id" /etc/squid/contour-tasks.conf || true)
if [ -z "$running" ] && [ "${acl:-0}" = 0 ] && grep -q revoked <<<"$revoked"; then line ok revoke "$times"; else line fail revoke "container=${running:-none} acl=$acl"; fi

echo "== 5. Рой: шлюз действий, политика, подпись, каталог навыков"
while read -r verdict name detail; do line "$verdict" "$name" "$detail"; done < <(./stand.sh contour selftest || true)

if vm test -f /opt/contour/finance/fin.mjs; then
  echo "== 6. Финансовый стенд: токены, платежей нет, правила журнала"
  while read -r verdict name detail; do line "$verdict" "$name" "$detail"; done < <(vm node /opt/contour/finance/fin.mjs selftest || true)
fi

exit $fail
