#!/usr/bin/env bash
# The finance stand inside the contour VM (deploy/finance-stand/README.md).
# Run as root from /opt/contour/finance; fin.sh does it. Idempotent.
#
#   provision.sh             tokens, extensions, policy, the firm, the systems unit
#   provision.sh tbank-ca    install the Russian Trusted Root CA (PEM on stdin) for the bank adapter only
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
