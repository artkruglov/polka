#!/bin/sh
# Starts what the profile asks for inside the sandbox: the agent on the task
# in /work/TASK.md, a skill's script and its checks, or the probe of checks.sh.
set -eu
export HOME=/work/.home CODEX_HOME=/work/.home/.codex
mkdir -p "$CODEX_HOME"
cp /opt/contour/codex.toml "$CODEX_HOME/config.toml"
case "${1:-codex}" in
  codex)
    exec codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --ephemeral \
      -C /work -o /work/LAST.md "$(cat /work/TASK.md)" ;;
  probe) exec /opt/contour/probe.sh ;;
  # A process step without a model: the skill's own script (swarm.mjs).
  skill) exec python3 /work/skill/run.py ;;
  check) python3 /work/skill/check.py >/work/review.json ;;
  sleep) exec sleep "${2:-600}" ;;
  *) echo "unknown command $1" >&2; exit 2 ;;
esac
