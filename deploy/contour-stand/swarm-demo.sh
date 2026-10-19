#!/usr/bin/env bash
# The swarm's show (deploy/contour-stand/README.md, «Рой»), from the host,
# with the tunnel running and both Полка bots stored (stand.sh polka-bot,
# stand.sh polka-bot reader-bot). Starts from an empty swarm.
#
#   deploy/contour-stand/swarm-demo.sh --account .local/local-account.json [--auto-accept] [--no-pause]
#
# Every acceptance is a person's: by default the script waits while you
# accept the work on Полка; --auto-accept accepts it with the account's
# session (deploy/agent-stand/journal.mjs), the way a person would.
set -euo pipefail
cd "$(dirname "$0")"
account="" auto=0 pause=1
while [ $# -gt 0 ]; do
  case "$1" in
    --account) account=$2; shift 2 ;;
    --auto-accept) auto=1; shift ;;
    --no-pause) pause=0; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$account" ] || { sed -n '6p' "$0" >&2; exit 2; }
ROOT=../..
c() { ./stand.sh contour "$@"; }
step() {
  printf '\n\033[1m== %s\033[0m\n' "$*"
  if [ "$pause" = 1 ]; then read -r -p "Enter — дальше " _; fi
}
# accept <goal>: the person's yes on Полка for the goal's current version.
accept() {
  local work
  work=$(c goal "$1" | sed -n 's/.*работа \([0-9a-f-]\{36\}\).*/\1/p' | tail -1)
  if [ "$auto" = 1 ]; then
    (cd "$ROOT" && node deploy/agent-stand/journal.mjs --account "$account" --accept "$work" --limit 1 | tail -1)
  else
    read -r -p "Откройте Полку http://127.0.0.1:4390, примите работу $work и нажмите Enter " _
  fi
  sleep 6 # the swarm polls Полка's events every 4 s
}
goal_of() { grep -oE 'goal-[0-9]{4}-[0-9a-f]{4}' | head -1; }

./stand.sh reset-swarm
sleep 3

step "1. Каталог процессов и маркет навыков: процессы — это файлы, навыки допущены по digest"
c processes
limactl shell --workdir /opt/contour contour -- sudo node catalog.mjs list

step "2. Новый процесс словами: Петрова описывает работу и прикладывает прошлую неделю с ручным результатом"
g=$(c new "Каждую пятницу сверяю выписку банка с таблицей счетов и пишу должникам напоминания" \
  --as petrova --example /opt/contour/samples/finance-w41 --param as_of=2026-10-16 | tee /dev/stderr | goal_of)
c inbox --as petrova

step "3. Одного должника агент пропустил: Петрова объясняет правило, черновик собирается заново"
c decide "$g" reject "частичная оплата — долг на остаток" --as petrova | tail -1
g=$(c new "Каждую пятницу сверяю выписку банка с таблицей счетов и пишу должникам напоминания" \
  --as petrova --example /opt/contour/samples/finance-w41 --param as_of=2026-10-16 --param partial=debt | tee /dev/stderr | goal_of)
accept "$g"
c processes

step "4. Регулярная работа: файлы в папке процесса, расписание «пятница 10:00» срабатывает само"
c drop finance.reconcile /opt/contour/samples/finance-w41/statement.csv /opt/contour/samples/finance-w41/invoices.csv
g=$(c tick --at 2026-10-23T10:05:00 | tee /dev/stderr | goal_of)
sleep 12
c inbox --as petrova
accept "$g"
c goal "$g" | tail -8

step "5. Цель словами: договор по КП с нетиповой неустойкой — исключение уходит владельцу"
g=$(c goal "Подготовь договор поставки с ООО «Альфа» по КП-118" --as orlova --file /opt/contour/samples/sales/kp-118.json | tee /dev/stderr | goal_of)
accept "$g"

step "6. Подпись: только подписант и только принятая версия"
c sign --as orlova || true
c sign --as director

step "7. Письмо клиента с внедрённой инструкцией: агент отвечает по базе, лишнего не делает"
c mail /opt/contour/samples/support/injection.json
sleep 15
g=$(c goals | grep support.reply | tail -1 | goal_of)
c goal "$g" | sed -n '1,12p'
accept "$g"

step "8. Метрики процесса и его карта по журналу"
c process finance.reconcile
c map sales.contract
c promote finance.reconcile --as petrova || true

step "9. Проект: план как граф поручений"
c project "Открыть продажи стеллажей в Казани к декабрю" --as ivanov || echo "(без ключа модели план не пишется: stand.sh secret)"

step "10. Границы роя"
c selftest
