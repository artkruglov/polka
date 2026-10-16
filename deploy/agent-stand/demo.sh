#!/usr/bin/env bash
# The six-minute show for a security lead (deploy/agent-stand/README.md).
# Each step waits for Enter unless --no-pause; --auto-accept accepts the
# report through the API instead of waiting for a person in the browser.
#
#   deploy/agent-stand/demo.sh --account .local/local-account.json [--no-pause] [--auto-accept]
set -euo pipefail
cd "$(dirname "$0")/../.."

account=""
pause=1
auto_accept=0
while [ $# -gt 0 ]; do
  case "$1" in
    --account) account="$2"; shift 2 ;;
    --no-pause) pause=0; shift ;;
    --auto-accept) auto_accept=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$account" ] || { echo "--account <file> is required" >&2; exit 2; }
VM="${VM:-agent-stand}"
OUT="${OUT:-.local/agent-stand}"
S=deploy/agent-stand
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; [ "$pause" = 0 ] || read -r -p "Enter — дальше" _; }
json() { node -e "const t=require('$(pwd)/$OUT/tokens.json'); console.log($1)"; }

step "1. Границы: ВМ без папок владельца, два бота со своими правами"
limactl shell "$VM" -- sudo bash -c 'echo "Смонтировано с Mac: $(grep -c -E "virtiofs|9p|sshfs|fuse" /proc/mounts) папок"; echo "sudo у агента: $(sudo -l -U agent 2>/dev/null | grep -c "may run" || true)"'
json 'Object.entries(t.bots).map(([n,b])=>`${n}: ${b.scopes.join(", ")}`).join("\n")'
echo "Длинные токены ботов — только на этом компьютере; в ВМ уходит токен задачи на 15 минут."

step "2. report-bot собирает отчёт и сохраняет его на Полку"
$S/run-task.sh report-bot "В папке есть sales.csv — синтетические продажи по регионам за три месяца. Сделай короткий отчёт в одну HTML-страницу: итоги по месяцам и регионам, рост, лидер. Сохрани его на Полку инструментом polka_publish с названием «Продажи: июль–сентябрь». В конце напиши artifactId и revisionId." --input "$OUT/input/sales.csv" || true

step "3. Журнал на сервере: кто сохранил, по какой задаче, кто отвечает"
node $S/journal.mjs --account "$account" --limit 8

work=$(node -e '
const fs=require("fs"),p=require("path");const dir=process.argv[1];
const runs=fs.readdirSync(dir).filter(f=>f.includes("report-bot")).sort();
const last=JSON.parse(fs.readFileSync(p.join(dir,runs.at(-1)),"utf8")).lastMessage||"";
const m=last.match(/artifactId\W+([0-9a-f-]{36})/i);process.stdout.write(m?m[1]:"")' "$OUT/runs")
step "4. Человек принимает версию"
if [ -z "$work" ]; then echo "Агент не назвал artifactId — примите версию вручную в интерфейсе."; fi
if [ "$auto_accept" = 1 ] && [ -n "$work" ]; then node $S/journal.mjs --account "$account" --accept "$work";
else echo "Откройте http://127.0.0.1:4390/works/$work и нажмите «Принять версию»."; [ "$pause" = 0 ] || read -r -p "Приняли? Enter" _; fi

step "5. report-bot делает вторую версию — она не принята"
$S/run-task.sh report-bot "На Полке есть работа «Продажи: июль–сентябрь» (artifactId $work). Добавь в неё раздел «Выводы» из трёх пунктов и сохрани новую версию той же работы через polka_revise. Ссылку не выдавай." --input "$OUT/input/sales.csv" || true

step "6. reader-bot берёт принятую версию, а не последнюю"
$S/run-task.sh reader-bot "Найди на Полке работу «Продажи: июль–сентябрь». Возьми ПРИНЯТУЮ версию (acceptedRevisionId из polka_list), а не последнюю, прочитай её через polka_read_source и напиши выжимку для руководства в пяти пунктах. Укажи номер прочитанной версии и номер последней." || true
node $S/journal.mjs --account "$account" --limit 6

step "7. Агент в bash с токеном в руках: что он может"
$S/bypass.sh

step "8. Песочница: приманки, окружение, сеть"
limactl copy scripts/polka-sandbox-check.mjs "$VM:/tmp/polka-sandbox-check.mjs"
limactl shell "$VM" -- sudo install -m 644 /tmp/polka-sandbox-check.mjs /opt/agent-stand/polka-sandbox-check.mjs
limactl shell "$VM" -- sudo -u agent bash -c 'install -d /work/check && echo work-ok > /work/check/ok.txt && cd /work/check && node /opt/agent-stand/polka-sandbox-check.mjs \
  --runner "env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work/check srt --settings /etc/agent-stand/srt.json -c" \
  --canary /home/agent/.ssh/id_canary --canary /home/agent/.aws/credentials --canary /opt/agent-stand/canary/secret \
  --allowed-read /work/check/ok.txt --work /work/check \
  --allowed-url http://127.0.0.1:4390/api/health --blocked-url https://example.com \
  --settings-file /etc/agent-stand/srt.json --json /work/check/report.json' || true

step "9. Отключаем сервисный доступ посреди работы"
node $S/revoke.mjs --account "$account"

step "Готово. Ограничения: права не шире прав ответственного; модель на стенде — западная; разрешённые адреса остаются каналом передачи данных."
