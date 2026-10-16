#!/usr/bin/env bash
# Prepares the agent stand VM (deploy/agent-stand/README.md). Run as root
# inside the VM: stand.sh provision does it. Idempotent.
#
# What the agent gets: a user without sudo, an empty home, a work folder,
# Codex and sandbox-runtime at pinned versions, and a sandbox that lets it
# read and write only its work folder and reach only Полка and the model.
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.16.0}"
CODEX_VERSION="${CODEX_VERSION:-0.162.1}"
SRT_VERSION="${SRT_VERSION:-0.0.79}"
POLKA_PORT="${POLKA_PORT:-4390}"
# Hosts the model needs (Codex signed in with ChatGPT). Keep the list
# short and grow it only by what a run proves it needs.
MODEL_HOSTS="${MODEL_HOSTS:-chatgpt.com auth.openai.com}"

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install -y -qq bubblewrap socat ripgrep git python3 curl ca-certificates jq apparmor-utils >/dev/null

# Node from nodejs.org, pinned.
arch=$(uname -m); case "$arch" in aarch64) narch=arm64 ;; x86_64) narch=x64 ;; *) echo "unsupported $arch" >&2; exit 1 ;; esac
if [ "$(node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$narch.tar.xz" | tar -xJ -C /usr/local --strip-components=1
fi
npm install -g --silent "@openai/codex@$CODEX_VERSION" "@anthropic-ai/sandbox-runtime@$SRT_VERSION"

# Ubuntu 24.04 forbids unprivileged user namespaces unless an AppArmor
# profile allows them for the program; bubblewrap needs them.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
  cat >/etc/apparmor.d/agent-stand-bwrap <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>
profile agent-stand-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/agent-stand-bwrap>
}
PROFILE
  apparmor_parser -r /etc/apparmor.d/agent-stand-bwrap
fi

# The agent: no sudo, no password, nothing in its home.
id agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash agent
passwd -l agent >/dev/null
rm -f /etc/sudoers.d/agent

# Codex's sign-in lives apart from the home, the only path besides the work
# folder the sandbox lets it write.
install -d -o agent -g agent -m 700 /opt/agent-stand/codex
install -d -o agent -g agent -m 755 /work
install -d -m 755 /etc/agent-stand
install -d -m 700 /etc/agent-stand/secrets

# Canaries for the check kit (scripts/polka-sandbox-check.mjs): random
# values in paths the sandbox must hide. Readable by the agent outside the
# sandbox, so a control read proves the check can see them at all.
canary() { install -d -o agent -g agent -m 700 "$(dirname "$1")"; head -c 24 /dev/urandom | base64 >"$1"; chown agent:agent "$1"; chmod 600 "$1"; }
[ -f /home/agent/.ssh/id_canary ] || canary /home/agent/.ssh/id_canary
[ -f /home/agent/.aws/credentials ] || canary /home/agent/.aws/credentials
[ -f /opt/agent-stand/canary/secret ] || canary /opt/agent-stand/canary/secret

domains=$(printf '"127.0.0.1:%s"' "$POLKA_PORT"; for h in $MODEL_HOSTS; do printf ', "%s"' "$h"; done)
cat >/etc/agent-stand/srt.json <<JSON
{
  "network": {
    "allowedDomains": [$domains],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["/home", "/root", "/etc/agent-stand/secrets", "/opt/agent-stand/canary"],
    "allowWrite": ["/work", "/opt/agent-stand/codex", "/tmp"],
    "denyWrite": []
  }
}
JSON
chmod 644 /etc/agent-stand/srt.json

# Codex: Полка over MCP with the task token from the environment; commands
# run unsandboxed by Codex itself because srt wraps the whole process
# (run-task.sh), which is the one boundary.
cat >/opt/agent-stand/codex/config.toml <<TOML
[mcp_servers.polka]
url = "http://127.0.0.1:$POLKA_PORT/mcp"
bearer_token_env_var = "POLKA_MCP_TOKEN"
TOML
chown agent:agent /opt/agent-stand/codex/config.toml

echo "node $(node -v), codex $(codex --version 2>/dev/null | awk '{print $2}'), srt $(srt --version)"
