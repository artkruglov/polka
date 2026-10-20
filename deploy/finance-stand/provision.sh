#!/usr/bin/env bash
# The finance stand inside the contour VM (deploy/finance-stand/README.md).
# Run as root from /opt/contour/finance; fin.sh does it. Idempotent.
#
#   provision.sh             tokens, extensions, policy, the firm, the systems unit
#   provision.sh tbank-ca    install the Russian Trusted Root CA (PEM on stdin) for the bank adapter only
#   provision.sh connectors  a company «demo» to connect to (M7): its T-API bank and 1C OData on
#                            127.0.0.1:7072, its documents box on a real IMAP server (dovecot,
#                            127.0.0.1:143), the credentials in OpenBao, the sync timer template
set -euo pipefail
cd /opt/contour/finance
ETC=/etc/contour
BAO=http://127.0.0.1:8200
bao_token() { jq -r .root_token "$ETC/bao-init.json"; }
bao_put() { curl -fsS -o /dev/null -X POST "$BAO/v1/contour/data/$1" -H "x-vault-token: $(bao_token)" -d "{\"data\":$2}"; }

if [ "${1:-}" = tbank-ca ]; then
  pem=$(cat)
  subject=$(printf '%s\n' "$pem" | openssl x509 -noout -subject -nameopt RFC2253)
  case "$subject" in
    *"CN=Russian Trusted Root CA"*) ;;
    *) echo "not the Russian Trusted Root CA: $subject" >&2; exit 1 ;;
  esac
  printf '%s\n' "$pem" | openssl x509 -noout -ext basicConstraints | grep -q "CA:TRUE" || { echo "not a CA certificate" >&2; exit 1; }
  install -d -m 755 /etc/finance
  printf '%s\n' "$pem" >/etc/finance/russian-trusted-root.pem
  chmod 644 /etc/finance/russian-trusted-root.pem
  printf '%s\n' "$pem" | openssl x509 -noout -subject -fingerprint -sha256 -enddate
  exit 0
fi

if [ "${1:-}" = connectors ]; then
  # The company's side: what it would give the connectors, generated here,
  # stored in OpenBao and never printed.
  install -d -m 755 /etc/finance /etc/finance/companies
  secret() { openssl rand -hex 18; }
  if [ ! -s /etc/finance/company-apis.json ]; then
    (umask 077 && jq -n --arg t "$(secret)" --arg p "$(secret)" --arg m "$(secret)" \
      '{tbank:{token:$t}, "1c":{user:"Аудит",password:$p}, mail:{user:"docs",password:$m}}' >/etc/finance/company-apis.json)
  fi
  s=/etc/finance/company-apis.json
  bao_put finance/companies/demo/tbank "$(jq -c .tbank $s)"
  bao_put finance/companies/demo/1c "$(jq -c '.["1c"]' $s)"
  bao_put finance/companies/demo/mail "$(jq -c .mail $s)"

  # The documents box: dovecot with its own config and unit, nothing of the
  # distribution's dovecot.service; one user, a Maildir of the firm's letters.
  if ! command -v dovecot >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq dovecot-imapd >/dev/null
    systemctl disable --now dovecot.service >/dev/null 2>&1 || true
  fi
  id finmail >/dev/null 2>&1 || useradd --system --home-dir /var/lib/finance-mail --shell /usr/sbin/nologin finmail
  if [ ! -d /var/lib/finance-mail/docs/Maildir/cur ]; then
    node company/exports.mjs --maildir /var/lib/finance-mail/docs/Maildir
    chown -R finmail:finmail /var/lib/finance-mail
    chmod -R go-rwx /var/lib/finance-mail
  fi
  (umask 077 && printf 'docs:{SHA512-CRYPT}%s\n' "$(jq -r .mail.password $s | openssl passwd -6 -stdin)" >/etc/finance/imap.passwd)
  chown root:dovecot /etc/finance/imap.passwd && chmod 640 /etc/finance/imap.passwd
  cat >/etc/finance/dovecot.conf <<CONF
# The demo company's documents box (deploy/finance-stand, M7): loopback only.
protocols = imap
listen = 127.0.0.1
base_dir = /run/finance-dovecot
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login
mail_location = maildir:/var/lib/finance-mail/%n/Maildir
first_valid_uid = $(id -u finmail)
log_path = syslog
passdb {
  driver = passwd-file
  args = scheme=SHA512-CRYPT username_format=%n /etc/finance/imap.passwd
}
userdb {
  driver = static
  args = uid=finmail gid=finmail home=/var/lib/finance-mail/%n
}
service imap-login {
  inet_listener imap {
    address = 127.0.0.1
    port = 143
  }
  inet_listener imaps {
    port = 0
  }
}
service stats {
  unix_listener stats-writer {
    mode = 0666
  }
}
CONF
  cat >/etc/systemd/system/finance-imap.service <<'UNIT'
[Unit]
Description=Finance stand: the demo company's documents box over IMAP (127.0.0.1:143)
After=network.target
[Service]
ExecStart=/usr/sbin/dovecot -F -c /etc/finance/dovecot.conf
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
  cat >/etc/systemd/system/finance-company-apis.service <<'UNIT'
[Unit]
Description=Finance stand: the demo company's T-API bank and 1C OData (127.0.0.1:7072)
After=network.target
[Service]
ExecStart=/usr/local/bin/node /opt/contour/finance/systems/company-apis.mjs --seed 41 --port 7072 --secrets /etc/finance/company-apis.json
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
  # A company's daily sync and audit: systemctl enable --now finance-sync@<name>.timer
  cat >/etc/systemd/system/finance-sync@.service <<'UNIT'
[Unit]
Description=Finance stand: sync and audit of company %i
After=finance-systems.service
[Service]
Type=oneshot
TimeoutStartSec=45min
WorkingDirectory=/opt/contour/finance
ExecStart=/usr/local/bin/node /opt/contour/finance/fin.mjs sync %i --audit
UNIT
  cat >/etc/systemd/system/finance-sync@.timer <<'UNIT'
[Unit]
Description=Finance stand: daily sync of company %i
[Timer]
OnCalendar=*-*-* 07:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable finance-imap.service finance-company-apis.service >/dev/null 2>&1
  systemctl restart finance-imap.service finance-company-apis.service

  # The company: sources without secrets; bank B and the EDO registry stay
  # hand-made exports in its folder.
  cat >/etc/finance/companies/demo.json <<'JSON'
{
  "name": "demo",
  "title": "ООО «Стеллаж-Про», прямые подключения",
  "from": "2026-07-01",
  "to": "2026-10-01",
  "asOf": "2026-09-30",
  "sources": [
    { "id": "tbank", "kind": "tbank", "base": "http://127.0.0.1:7072/tbank" },
    { "id": "1c", "kind": "odata1c", "base": "http://127.0.0.1:7072/1c/odata/standard.odata" },
    { "id": "mail", "kind": "imap", "url": "imap://127.0.0.1:143", "name": "docs@stellazh-pro.test" }
  ]
}
JSON
  install -d -m 700 /var/lib/finance/companies /var/lib/finance/companies/demo
  [ -d /var/lib/finance/companies/demo/exports ] || node company/exports.mjs --out /var/lib/finance/companies/demo/exports --connected >/dev/null
  for _ in $(seq 1 20); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7072/tbank/api/v4/bank-accounts | grep -q 401 && break; sleep 0.5; done
  echo "connectors: company «demo» — T-API and OData 1C on 127.0.0.1:7072, IMAP on 127.0.0.1:143; fin.sh connect demo --audit"
  exit 0
fi

# The stand's banks answer only to this token; the coordinator reads it
# from OpenBao, a sandbox never has it.
install -d -m 755 /etc/finance
[ -s /etc/finance/bank-token ] || (umask 077 && openssl rand -hex 24 >/etc/finance/bank-token)
bao_put finance/bank "{\"token\":\"$(cat /etc/finance/bank-token)\"}"

# What the swarm adds from this stand: skills, process packs, effect routes.
cat >"$ETC/extensions.json" <<'JSON'
{
  "catalogs": ["/opt/contour/finance/catalog"],
  "processes": ["/opt/contour/finance/processes"],
  "effects": ["/opt/contour/finance/effects"]
}
JSON

# The policy's bounds for the finance effects: OPA watches /opt/contour/policy.
install -d -m 755 /opt/contour/policy/ext/finance
rm -f /opt/contour/policy/ext/finance/*.json
cp policy/*.json /opt/contour/policy/ext/finance/ 2>/dev/null || true

# The synthetic firm, once; fin.mjs reset makes a new one.
[ -f /var/lib/finance/company/company.json ] || node company/gen.mjs --out /var/lib/finance/company

cat >/etc/systemd/system/finance-systems.service <<'UNIT'
[Unit]
Description=Finance stand: banks, EDO, ledger, mail and counterparties (127.0.0.1:7071)
After=network.target
[Service]
ExecStart=/usr/local/bin/node /opt/contour/finance/systems/fin-systems.mjs
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable finance-systems.service >/dev/null 2>&1
systemctl restart finance-systems.service contour-swarm.service
for _ in $(seq 1 30); do curl -fs http://127.0.0.1:7071/health >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:7071/health >/dev/null && echo "finance stand: systems on 127.0.0.1:7071"
