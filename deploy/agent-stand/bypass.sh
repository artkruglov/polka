#!/usr/bin/env bash
# «The agent will call bash and take the token»: it may. This shows what
# the token is worth then. From the host it issues task tokens to both bots,
# and inside the VM, as the agent user under the same sandbox as a real run,
# plain curl calls Полка's API past MCP and tries to step outside the rights.
# Every attempt must be refused by the server; the allowed ones must work.
#
#   deploy/agent-stand/bypass.sh
set -euo pipefail

VM="${VM:-agent-stand}"
OUT="${OUT:-.local/agent-stand}"
tokens="$(cd "$OUT" && pwd)/tokens.json"
get() { node -e 'const t=require(process.argv[1]);process.stdout.write(String(process.argv[2].split(".").reduce((o,k)=>o?.[k],t)))' "$tokens" "$1"; }
origin=$(get origin)
mint() {
  curl -fsS -X POST "$origin/api/v1/task-token" -H "authorization: Bearer $(get "bots.$1.token")" \
    -H "content-type: application/json" -d "{\"minutes\":5,\"taskId\":\"bypass-$(date +%s)-$1\"}" |
    node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).token)'
}
reader=$(mint reader-bot)
report=$(mint report-bot)
finance_shelf=$(get shelves.finance)
finance_work=$(get financeWork)

limactl shell "$VM" -- sudo install -d -o agent -g agent -m 700 /work/bypass
limactl shell "$VM" -- sudo -u agent bash -s <<SCRIPT
cd /work/bypass
cat > probes.sh <<'PROBES'
O=http://127.0.0.1:${origin##*:}
fail=0
row() { echo "\$1 — \$2: \$3"; }
# expect <what> <allowed|refused> <curl args...>: refused means 401/403/404.
expect() {
  what=\$1; want=\$2; shift 2
  code=\$(curl -sS -o body.json -w '%{http_code}' "\$@" || echo 000)
  case "\$want:\$code" in
    allowed:2??) row "работает" "\$what" "\$code" ;;
    refused:401|refused:403|refused:404) row "отказано" "\$what" "\$code \$(msg)" ;;
    *) row "ОШИБКА" "\$what" "ждали \$want, получили \$code \$(head -c 90 body.json)"; fail=1 ;;
  esac
}
msg() { sed -n 's/.*"message":"\\([^"]*\\)".*/\\1/p' body.json; }
R="authorization: Bearer \$READER"; W="authorization: Bearer \$REPORT"
echo "Токены задачи видны агенту: READER=\${READER:0:6}… REPORT=\${REPORT:0:6}…"
expect "reader-bot: список своей полки"            allowed \$O/api/v1/works -H "\$R"
expect "reader-bot: работа с чужой полки"          refused \$O/api/v1/works/\$FINANCE_WORK -H "\$R"
expect "reader-bot: файлы работы с чужой полки"    refused \$O/api/v1/works/\$FINANCE_WORK/files -H "\$R"
curl -sS \$O/api/v1/works -H "\$R" -H "x-polka-shelf: \$FINANCE_SHELF" -o list.json
if grep -q "\$FINANCE_WORK" list.json; then row "ОШИБКА" "reader-bot: подмена полки заголовком" "чужая работа в списке"; fail=1;
else row "отказано" "reader-bot: подмена полки заголовком" "в списке только своя полка"; fi
expect "reader-bot: сохранить работу"              refused -X POST \$O/api/v1/publish -H "\$R" -H content-type:application/json -d '{"key":"00000000-0000-4000-8000-000000000001","title":"x","html":"<p>x</p>"}'
expect "reader-bot: выпустить себе новый токен"    refused -X POST \$O/api/v1/task-token -H "\$R" -H content-type:application/json -d '{"minutes":60}'
expect "reader-bot: веб-API полки"                 refused \$O/api/shelves -H "\$R"
expect "report-bot: прочитать список работ"        refused \$O/api/v1/works -H "\$W"
code=\$(curl -sS -o body.json -w '%{http_code}' -X POST \$O/api/v1/publish -H "\$W" -H content-type:application/json -d "{\"key\":\"\$(cat /proc/sys/kernel/random/uuid)\",\"title\":\"Проба обхода (демо)\",\"html\":\"<p>проба</p>\",\"expiresInDays\":30}")
if [ "\$code" = 200 ] && ! grep -q '"shareId"' body.json; then row "отказано" "report-bot: сохранить и выдать ссылку" "сохранено без ссылки: нет права share";
else row "ОШИБКА" "report-bot: сохранить и выдать ссылку" "\$code \$(head -c 120 body.json)"; fail=1; fi
expect "без токена"                                refused \$O/api/v1/works
exit \$fail
PROBES
exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/work/bypass LANG=C.UTF-8 \
  READER="$reader" REPORT="$report" FINANCE_SHELF="$finance_shelf" FINANCE_WORK="$finance_work" \
  srt --settings /etc/agent-stand/srt.json -c 'NO_PROXY= no_proxy= bash probes.sh'
SCRIPT
