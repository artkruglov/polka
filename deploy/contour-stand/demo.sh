#!/usr/bin/env bash
# The whole show of the contour stand (deploy/contour-stand/README.md), from
# the host, with the tunnel running and the model key stored:
#
#   deploy/contour-stand/demo.sh
set -euo pipefail
cd "$(dirname "$0")"
VM="${VM:-contour}"
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
vm() { limactl shell --workdir /opt/contour "$VM" -- sudo "$@"; }

step "1. Профиль задачи, который написала ИБ"
sed -n '/^profile:/,/^journal:/p' profiles/bugfix.yaml

step "2. Иванов поручает агенту исправить баг (Диспетчер → Keycloak → LiteLLM → Полка → Squid → gVisor)"
./stand.sh run run profiles/bugfix.yaml "В репозитории contour/demo падает тест скидки. Исправь." --as ivanov | tee /tmp/contour-demo.out
id=$(grep -oE 'task-[0-9]{8}-[0-9a-f]{6}' /tmp/contour-demo.out | head -1)

step "3. Журнал задачи $id (готов к отправке в SIEM)"
vm bash -c "jq -c '{ts:.ts[11:19],layer,event} + (del(.ts,.task_id,.profile,.layer,.event))' /var/lib/contour/events/$id.jsonl"

step "4. PR в Gitea: в main агент не пишет, только ветка и запрос на слияние"
vm bash -c 'curl -fsS -u contour-admin:$(cat /etc/contour/gitea-admin) "http://127.0.0.1:3000/api/v1/repos/contour/demo/pulls?state=open" | jq -r ".[] | \"#\(.number) \(.title) ← \(.head.ref)\""'

step "5. Результат ждёт приёмки на Полке: «Аналитика (демо)», работа «$id: исправление»"
echo "Откройте http://127.0.0.1:4390 и примите или отклоните работу."

step "6. Проверки границ и отзыв"
./checks.sh
