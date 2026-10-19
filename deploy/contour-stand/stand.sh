#!/usr/bin/env bash
# The contour stand from the host (deploy/contour-stand/README.md):
#
#   deploy/contour-stand/stand.sh up         create and start the VM, build everything inside
#   deploy/contour-stand/stand.sh sync       copy edited stand files into the VM
#   deploy/contour-stand/stand.sh update     sync, then provision again (idempotent; the swarm included)
#   deploy/contour-stand/stand.sh tunnel     Полка of this computer inside the VM at 127.0.0.1:4390
#   deploy/contour-stand/stand.sh polka-bot [name]  copy a Полка bot token (agent-stand seed) into OpenBao
#   deploy/contour-stand/stand.sh secret     store the model provider's key in OpenBao (typed, not shown)
#   deploy/contour-stand/stand.sh run ...    dispatcher.mjs in the VM: run | start | wait | revoke | status
#   deploy/contour-stand/stand.sh contour ... swarm.mjs in the VM: goal | new | inbox | decide | sign | …
#   deploy/contour-stand/stand.sh reset-swarm  forget goals, added processes, letters and documents
#   deploy/contour-stand/stand.sh down       delete the VM
set -euo pipefail
cd "$(dirname "$0")"
VM="${VM:-contour}"
PORT="${POLKA_PORT:-4390}"
OUT="${OUT:-../../.local/agent-stand}"
in_vm() { limactl shell --workdir /opt/contour "$VM" -- sudo "$@"; }
case "${1:-}" in
  up)
    limactl list -q | grep -qx "$VM" || limactl create --name="$VM" --tty=false lima.yaml
    limactl start "$VM"
    limactl shell "$VM" -- sudo rm -rf /tmp/contour-src
    limactl copy -r . "$VM:/tmp/contour-src"
    limactl shell "$VM" -- sudo bash -c 'install -d -m 755 /opt/contour && cp -r /tmp/contour-src/. /opt/contour/ && rm -rf /tmp/contour-src && chmod 755 /opt/contour/*.sh /opt/contour/*.mjs'
    in_vm bash /opt/contour/provision.sh
    # The package upgrade restarts services that new ssh sessions wait on
    # (the reverse tunnel never binds); a reboot settles them, and the boot
    # unit unseals OpenBao.
    limactl stop "$VM"
    limactl start "$VM"
    ;;
  sync)
    # Copy edited stand files into the VM without rebuilding it.
    limactl copy -r . "$VM:/tmp/contour-src"
    limactl shell "$VM" -- sudo bash -c 'cp -r /tmp/contour-src/. /opt/contour/ && rm -rf /tmp/contour-src && chmod 755 /opt/contour/*.sh /opt/contour/*.mjs'
    ;;
  tunnel)
    # A reverse tunnel keeps the address the same on both sides, so Полка's
    # Host and Origin checks (APP_ORIGIN=http://127.0.0.1:$PORT) hold.
    exec ssh -F "$HOME/.lima/$VM/ssh.config" -o ControlMaster=no -o ControlPath=none \
      -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -N \
      -R "127.0.0.1:$PORT:127.0.0.1:$PORT" "lima-$VM"
    ;;
  polka-bot)
    bot="${2:-report-bot}"
    tokens="$OUT/tokens.json"
    [ -f "$tokens" ] || { echo "no $tokens: run deploy/agent-stand/seed.mjs first" >&2; exit 2; }
    node -e 'const t=require(require("path").resolve(process.argv[1]));const b=t.bots[process.argv[2]];if(!b)process.exit(3);process.stdout.write(`${process.argv[2]} ${t.origin} ${b.token}\n`)' "$tokens" "$bot" |
      in_vm bash /opt/contour/provision.sh polka-bot
    ;;
  secret)
    read -r -p "Провайдер (openai, anthropic, openrouter): " provider
    read -r -p "Модель у провайдера (например gpt-5.5 или claude-sonnet-5-5): " model
    read -r -s -p "Ключ API (не показывается): " key; echo
    printf '%s %s %s\n' "$provider" "$model" "$key" | in_vm bash /opt/contour/provision.sh upstream
    ;;
  update)
    ./stand.sh sync
    in_vm bash /opt/contour/provision.sh
    ;;
  run)
    shift
    in_vm node /opt/contour/dispatcher.mjs "$@"
    ;;
  contour)
    shift
    in_vm node /opt/contour/swarm.mjs "$@"
    ;;
  reset-swarm)
    in_vm bash -c 'systemctl stop contour-swarm contour-systems && rm -rf /var/lib/contour/swarm /var/lib/contour/systems.json && install -d -m 700 /var/lib/contour/swarm && systemctl start contour-systems contour-swarm'
    ;;
  down)
    limactl delete --force "$VM"
    ;;
  *)
    sed -n '2,14p' stand.sh
    exit 2
    ;;
esac
