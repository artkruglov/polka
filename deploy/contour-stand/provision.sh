#!/usr/bin/env bash
# Builds the contour stand inside its VM (deploy/contour-stand/README.md).
# Run as root from /opt/contour; stand.sh does it. Idempotent.
#
#   provision.sh              everything: packages, gVisor, firewall, Squid, services, secrets, Gitea
#   provision.sh boot         after a reboot: unseal OpenBao (systemd runs it)
#   provision.sh upstream     read «provider model key» on stdin, store it, restart the gateway
#   provision.sh polka-bot    read «name origin token» on stdin, store the Полка service token
#
# Secrets are generated here and kept in OpenBao and in root-only files
# under /etc/contour; nothing is printed.
set -euo pipefail
cd "$(dirname "$0")"

RUNSC_VERSION="${RUNSC_VERSION:-20261012.0}"
NODE_VERSION="${NODE_VERSION:-22.16.0}"
ETC=/etc/contour
STATE=/var/lib/contour
BAO=http://127.0.0.1:8200

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

rand() { head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"; }
secret_file() { [ -s "$1" ] || { umask 077; printf '%s' "$(rand 32)" >"$1"; }; cat "$1"; }
bao_token() { jq -r .root_token "$ETC/bao-init.json"; }
bao_put() { # bao_put <path> <json>
  curl -fsS -o /dev/null -X POST "$BAO/v1/contour/data/$1" -H "x-vault-token: $(bao_token)" -d "{\"data\":$2}"
}
bao_get() { curl -fsS "$BAO/v1/contour/data/$1" -H "x-vault-token: $(bao_token)" | jq -r ".data.data.$2"; }
wait_http() { for _ in $(seq 1 120); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 2; done; echo "timeout: $1" >&2; return 1; }

unseal() {
  wait_http "$BAO/v1/sys/seal-status"
  if [ "$(curl -fsS $BAO/v1/sys/seal-status | jq -r .initialized)" = false ]; then
    (umask 077; curl -fsS -X POST "$BAO/v1/sys/init" -d '{"secret_shares":1,"secret_threshold":1}' >"$ETC/bao-init.json")
  fi
  if [ "$(curl -fsS $BAO/v1/sys/seal-status | jq -r .sealed)" = true ]; then
    curl -fsS -o /dev/null -X POST "$BAO/v1/sys/unseal" -d "{\"key\":\"$(jq -r '.keys[0]' "$ETC/bao-init.json")\"}"
  fi
}

# The gateway's model list: the mock model always (checks.sh prices it so a
# budget runs out), «agent-model» once the owner has stored an upstream key.
render_litellm() {
  local provider model
  provider=$(bao_get upstream provider 2>/dev/null || echo null)
  model=$(bao_get upstream model 2>/dev/null || echo null)
  {
    echo "# Rendered by provision.sh from OpenBao; do not edit."
    echo "model_list:"
    echo "  - model_name: mock-model"
    echo "    litellm_params: { model: openai/mock, api_key: none, mock_response: 'ok' }"
    echo "    model_info: { input_cost_per_token: 0.0005, output_cost_per_token: 0.0005 }"
    if [ "$provider" != null ] && [ -n "$provider" ]; then
      echo "  - model_name: agent-model"
      echo "    litellm_params: { model: '$provider/$model', api_key: os.environ/UPSTREAM_API_KEY }"
    fi
    echo "general_settings:"
    echo "  master_key: os.environ/LITELLM_MASTER_KEY"
    echo "  database_url: os.environ/DATABASE_URL"
    echo "  proxy_batch_write_at: 2   # spend reaches the database within 2 s; the dispatcher reads it at close"
    echo "litellm_settings:"
    echo "  drop_params: true"
  } >"$ETC/litellm.yaml"
  chmod 600 "$ETC/litellm.yaml"
  (
    umask 077
    {
      echo "LITELLM_MASTER_KEY=sk-$(cat "$ETC/litellm-master")"
      echo "DATABASE_URL=postgresql://litellm:$(cat "$ETC/postgres-password")@postgres:5432/litellm"
      key=$(bao_get upstream api_key 2>/dev/null || echo null)
      if [ "$key" != null ]; then echo "UPSTREAM_API_KEY=$key"; fi
    } >"$ETC/litellm.env"
  )
}

render_squid_secrets() {
  local token
  token=$(bao_get git/agent-bot token)
  printf 'request_header_add Authorization "token %s" p_git\n' "$token" >/etc/squid/contour-secrets.conf
  chown root:proxy /etc/squid/contour-secrets.conf
  chmod 640 /etc/squid/contour-secrets.conf
}

case "${1:-all}" in
  boot) unseal; exit 0 ;;
  upstream)
    read -r provider model key
    [ -n "${key:-}" ] || { echo "expected: provider model key" >&2; exit 2; }
    bao_put upstream "$(jq -nc --arg p "$provider" --arg m "$model" --arg k "$key" '{provider:$p,model:$m,api_key:$k}')"
    render_litellm
    docker compose -f compose.yaml up -d --force-recreate litellm >/dev/null
    wait_http http://127.0.0.1:4000/health/liveliness
    echo "gateway: agent-model = $provider/$model"
    exit 0 ;;
  polka-bot)
    read -r name origin token
    [ -n "${token:-}" ] || { echo "expected: name origin token" >&2; exit 2; }
    bao_put "polka/$name" "$(jq -nc --arg o "$origin" --arg t "$token" '{origin:$o,token:$t}')"
    echo "OpenBao: contour/polka/$name stored"
    exit 0 ;;
  all) ;;
  *) sed -n '5,9p' "$0"; exit 2 ;;
esac

# ---- packages: Docker, Squid, gVisor (pinned), Node (pinned)
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 docker-buildx squid jq curl iptables git >/dev/null
if [ ! -f /etc/apt/sources.list.d/gvisor.list ]; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    >/etc/apt/sources.list.d/gvisor.list
  apt-get update -qq
fi
apt-get install -y -qq --allow-downgrades "runsc=$RUNSC_VERSION" >/dev/null
runsc install >/dev/null
systemctl restart docker
arch=$(uname -m); case "$arch" in aarch64) narch=arm64 ;; x86_64) narch=x64 ;; *) echo "unsupported $arch" >&2; exit 1 ;; esac
if [ "$(node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$narch.tar.xz" | tar -xJ -C /usr/local --strip-components=1
fi

install -d -m 700 "$ETC"
install -d -m 755 "$STATE" "$STATE/events" "$STATE/tasks" "$STATE/work"

# ---- the task network: internal (no route out), its bridge named task0
docker network inspect task-net >/dev/null 2>&1 ||
  docker network create --internal --subnet 10.77.0.0/24 --gateway 10.77.0.1 \
    --opt com.docker.network.bridge.name=task0 task-net >/dev/null

# ---- firewall: from task0 only the proxy port on the VM answers
cat >/etc/systemd/system/contour-firewall.service <<'UNIT'
[Unit]
Description=Contour stand: sandboxes reach only the proxy on the VM
After=network.target
Before=docker.service squid.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -C INPUT -i task0 -j DROP 2>/dev/null || iptables -I INPUT -i task0 -j DROP; iptables -C INPUT -i task0 -p tcp -d 10.77.0.1 --dport 3128 -j ACCEPT 2>/dev/null || iptables -I INPUT -i task0 -p tcp -d 10.77.0.1 --dport 3128 -j ACCEPT'
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now contour-firewall.service >/dev/null 2>&1
systemctl restart contour-firewall.service

# ---- secrets for the services (generated once, root only)
pg=$(secret_file "$ETC/postgres-password")
secret_file "$ETC/litellm-master" >/dev/null
kc=$(secret_file "$ETC/keycloak-admin")
(umask 077
 echo "POSTGRES_PASSWORD=$pg" >"$ETC/postgres.env"
 printf 'KC_BOOTSTRAP_ADMIN_USERNAME=admin\nKC_BOOTSTRAP_ADMIN_PASSWORD=%s\n' "$kc" >"$ETC/keycloak.env")
for user in ivanov petrov ib; do secret_file "$ETC/user-$user" >/dev/null; done
sed -e "s/__IVANOV_PASSWORD__/$(cat $ETC/user-ivanov)/" -e "s/__PETROV_PASSWORD__/$(cat $ETC/user-petrov)/" \
    -e "s/__IB_PASSWORD__/$(cat $ETC/user-ib)/" keycloak/realm.json >"$ETC/realm.json"
chmod 644 "$ETC/realm.json" # read by Keycloak's container user; the VM has no other users who matter
[ -f "$ETC/litellm.yaml" ] || { printf 'model_list: []\n' >"$ETC/litellm.yaml"; : >"$ETC/litellm.env"; }

# ---- services
docker build -q -t contour/agent:1 agent >/dev/null
docker compose -f compose.yaml up -d openbao >/dev/null
unseal
curl -fsS -o /dev/null -X POST "$BAO/v1/sys/mounts/contour" -H "x-vault-token: $(bao_token)" \
  -d '{"type":"kv","options":{"version":"2"}}' 2>/dev/null || true
bao_put litellm "{\"master_key\":\"sk-$(cat $ETC/litellm-master)\"}"
for user in ivanov petrov; do bao_put "users/$user" "{\"password\":\"$(cat $ETC/user-$user)\"}"; done
bao_put users/ib-admin "{\"password\":\"$(cat $ETC/user-ib)\"}"
render_litellm
docker compose -f compose.yaml up -d >/dev/null
wait_http http://127.0.0.1:3000/api/healthz
wait_http http://127.0.0.1:8080/realms/contour
wait_http http://127.0.0.1:4000/health/liveliness

# ---- Gitea: an admin, the agent's bot, a repository with a bug, main protected
gitea() { docker compose -f compose.yaml exec -T -u git gitea gitea "$@"; }
ga=$(secret_file "$ETC/gitea-admin")
gitea admin user list | grep -q contour-admin ||
  gitea admin user create --admin --username contour-admin --password "$ga" --email admin@contour.test --must-change-password=false >/dev/null
gitea admin user list | grep -q agent-bot ||
  gitea admin user create --username agent-bot --password "$(rand 32)" --email agent-bot@contour.test --must-change-password=false >/dev/null
api() { curl -fsS -u "contour-admin:$ga" -H content-type:application/json "http://127.0.0.1:3000/api/v1$1" "${@:2}"; }
api /orgs/contour >/dev/null 2>&1 || api /orgs -d '{"username":"contour","visibility":"private"}' >/dev/null
if ! api /repos/contour/demo >/dev/null 2>&1; then
  api /orgs/contour/repos -d '{"name":"demo","private":true,"default_branch":"main"}' >/dev/null
  src=$(mktemp -d)
  cp -r demo-repo/. "$src"
  git -C "$src" init -q -b main
  git -C "$src" -c user.name=contour-admin -c user.email=admin@contour.test add -A
  git -C "$src" -c user.name=contour-admin -c user.email=admin@contour.test commit -q -m "Расчёт суммы заказа"
  git -C "$src" push -q "http://contour-admin:$ga@127.0.0.1:3000/contour/demo.git" main
  rm -rf "$src"
  api /repos/contour/demo/collaborators/agent-bot -X PUT -d '{"permission":"write"}' >/dev/null
  api /repos/contour/demo/branch_protections -d '{"rule_name":"main","enable_push":false,"enable_merge_whitelist":true,"merge_whitelist_usernames":["contour-admin"]}' >/dev/null
fi
if ! curl -fsS -o /dev/null "$BAO/v1/contour/data/git/agent-bot" -H "x-vault-token: $(bao_token)"; then
  token=$(gitea admin user generate-access-token --username agent-bot --token-name "contour-$(date +%s)" \
    --scopes write:repository,read:user --raw | tr -d "\r\n")
  bao_put git/agent-bot "{\"token\":\"$token\"}"
fi

# ---- Squid: the base config, an empty task list, the git token from OpenBao
install -m 644 squid.conf /etc/squid/squid.conf
[ -f /etc/squid/contour-tasks.conf ] || echo "# no running tasks" >/etc/squid/contour-tasks.conf
render_squid_secrets
install -d /etc/systemd/system/squid.service.d
cat >/etc/systemd/system/squid.service.d/contour.conf <<'UNIT'
[Unit]
After=docker.service contour-firewall.service
Requires=docker.service
[Service]
ExecStartPre=/bin/sh -c 'until ip -4 addr show task0 | grep -q 10.77.0.1; do sleep 1; done'
UNIT
cat >/etc/systemd/system/contour-boot.service <<UNIT
[Unit]
Description=Contour stand: unseal OpenBao after a reboot
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/opt/contour/provision.sh boot
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable contour-boot.service >/dev/null 2>&1
systemctl restart squid

echo "contour: node $(node -v), $(runsc --version | head -1), squid $(squid -v | head -1 | awk '{print $4}')"
docker compose -f compose.yaml ps --format '{{.Service}} {{.State}}'
