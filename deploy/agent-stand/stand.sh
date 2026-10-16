#!/usr/bin/env bash
# The stand's VM from the host (deploy/agent-stand/README.md):
#
#   deploy/agent-stand/stand.sh up        create and start the VM, provision it
#   deploy/agent-stand/stand.sh tunnel    Полка of this computer inside the VM at 127.0.0.1:4390
#   deploy/agent-stand/stand.sh login     sign Codex in as the agent (you confirm in the browser)
#   deploy/agent-stand/stand.sh down      delete the VM
set -euo pipefail
cd "$(dirname "$0")"
VM="${VM:-agent-stand}"
PORT="${POLKA_PORT:-4390}"
case "${1:-}" in
  up)
    limactl list -q | grep -qx "$VM" || limactl create --name="$VM" --tty=false lima.yaml
    limactl start "$VM"
    limactl copy provision.sh "$VM:/tmp/provision.sh"
    limactl shell "$VM" -- sudo env POLKA_PORT="$PORT" bash /tmp/provision.sh
    ;;
  tunnel)
    # A reverse tunnel keeps the address the same on both sides, so Полка's
    # Host and Origin checks (APP_ORIGIN=http://127.0.0.1:$PORT) hold.
    exec ssh -F "$HOME/.lima/$VM/ssh.config" -o ControlMaster=no -o ControlPath=none \
      -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -N \
      -R "127.0.0.1:$PORT:127.0.0.1:$PORT" "lima-$VM"
    ;;
  login)
    exec limactl shell "$VM" -- sudo -u agent env CODEX_HOME=/opt/agent-stand/codex codex login --device-auth
    ;;
  down)
    limactl delete --force "$VM"
    ;;
  *)
    sed -n '2,8p' "$0"
    exit 2
    ;;
esac
