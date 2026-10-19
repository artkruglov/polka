#!/usr/bin/env bash
# The finance stand from the host (deploy/finance-stand/README.md). Lives in
# the contour VM next to the swarm; deploy/contour-stand/stand.sh up first.
#
#   deploy/finance-stand/fin.sh up          copy the stand into the VM and provision it (idempotent)
#   deploy/finance-stand/fin.sh sync        copy edited files only
#   deploy/finance-stand/fin.sh tbank-ca    trust the Russian Trusted Root CA for the bank adapter only
#   deploy/finance-stand/fin.sh <command>   fin.mjs in the VM: reset | status | statement | contract | advance
set -euo pipefail
cd "$(dirname "$0")"
VM="${VM:-contour}"
in_vm() { limactl shell --workdir /opt/contour/finance "$VM" -- sudo "$@"; }
case "${1:-}" in
  sync)
    limactl shell "$VM" -- sudo rm -rf /tmp/finance-src
    limactl copy -r . "$VM:/tmp/finance-src"
    limactl shell "$VM" -- sudo bash -c 'install -d -m 755 /opt/contour/finance && cp -r /tmp/finance-src/. /opt/contour/finance/ && rm -rf /tmp/finance-src && chmod 755 /opt/contour/finance/*.sh /opt/contour/finance/*.mjs'
    ;;
  up)
    ./fin.sh sync
    in_vm bash /opt/contour/finance/provision.sh
    ;;
  tbank-ca)
    # The bank's chain ends at the Ministry of Digital Development's root;
    # the certificate comes from the ministry's site, its fingerprint is
    # printed to compare with the published one.
    curl -fsS https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt | in_vm bash /opt/contour/finance/provision.sh tbank-ca
    ;;
  "" | -h | --help)
    sed -n '2,9p' fin.sh
    ;;
  *)
    in_vm node /opt/contour/finance/fin.mjs "$@"
    ;;
esac
