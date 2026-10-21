#!/usr/bin/env bash
# The finance stand's show (deploy/finance-stand/README.md): a quarter's
# tails from the first reconciliation to what is left after two weeks of the
# agents' work. From the host, with the contour VM up, the tunnel running
# and both Полка bots stored (deploy/contour-stand/stand.sh polka-bot,
# stand.sh polka-bot reader-bot).
#
#   deploy/finance-stand/finance-demo.sh --account .local/local-account.json [--auto-accept] [--no-pause]
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
[ -n "$account" ] || { sed -n '8p' "$0" >&2; exit 2; }
ROOT=../..
f() { ./fin.sh "$@"; }
step() {
  printf '\n\033[1m== %s\033[0m\n' "$*"
  if [ "$pause" = 1 ]; then read -r -p "Enter — дальше " _; fi
}
# run <fin command...>: a goal of the swarm; a result waiting for a person is accepted.
run() {
  local out work
  out=$(f "$@" 2>&1) || { printf '%s\n' "$out"; return 1; }
  printf '%s\n' "$out" | grep -E "проверки|политика|ждёт|готово|новых писем" | sed 's/^ *//' | cut -c1-160
  grep -q "ждёт приёмки на Полке" <<<"$out" || return 0
  work=$(printf '%s' "$out" | sed -n 's/.*работа \([0-9a-f-]\{36\}\).*/\1/p' | tail -1)
  if [ "$auto" = 1 ]; then
    (cd "$ROOT" && node deploy/agent-stand/journal.mjs --account "$account" --accept "$work" --limit 1 | tail -1)
  else
    read -r -p "Откройте Полку http://127.0.0.1:4390, примите работу $work и нажмите Enter " _
  fi
  sleep 10 # the swarm reads Полка's events every 8 s
}

step "1. Новый квартал: синтетическая фирма, два банка, ЭДО, учёт, 30 контрагентов"
f reset --seed 41
f status

step "2. Аудит хвостов: сверка через рой — песочница без сети, проверки, политика, Полка, журнал"
run match
f tails --limit 12
f score

step "3. Запросы первички поставщикам и напоминания должникам — приёмка одним «да» на Полке"
run chase
run remind

step "4. Три дня у контрагентов: УПД приходят, клиенты платят, одно письмо о «новых реквизитах», одно — с инъекцией"
f advance 3
run inbox
run match
f tails --limit 40

step "5. Реквизиты из письма не меняются: исключение на Полке, человек принимает решение"
run exceptions --number П-0116

step "6. Ещё три дня: второй круг запросов — молчавшим поставщикам; не чаще раза в три дня"
f advance 3
run chase
f advance 3
run inbox
run match

step "7. Акты сверки к концу квартала: черновики в ЭДО, подписывает только подписант"
run recon
f sign --as orlova || true
f sign --as director
f advance 2

step "8. Что осталось и что это стоило"
f tails --limit 40
f rebuild
f contract || true
