#!/usr/bin/env bash
# The finance stand from the host (deploy/finance-stand/README.md). Lives in
# the contour VM next to the swarm; deploy/contour-stand/stand.sh up first.
#
#   deploy/finance-stand/fin.sh up          copy the stand into the VM and provision it (idempotent)
#   deploy/finance-stand/fin.sh sync        copy edited files only
#   deploy/finance-stand/fin.sh tbank-ca    trust the Russian Trusted Root CA for the bank adapter only
#   deploy/finance-stand/fin.sh audit <dir> [--check]   a company's exports into the VM (never into git), then fin.mjs audit
#   deploy/finance-stand/fin.sh review <journal> <file.csv>    the audit's tails out to the host, for the bookkeeper to mark
#   deploy/finance-stand/fin.sh verdicts <journal> <file.csv>  the marked sheet back: precision and recall
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
    # The swarm imports the stand's hooks once: a running one would keep the old code.
    limactl shell "$VM" -- sudo systemctl try-restart finance-systems.service contour-swarm.service
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
  audit)
    # Real exports live in the VM only: /var/lib/finance/audit/<name>.
    src="${2:?usage: fin.sh audit <папка с выгрузками>}"
    name=$(basename "$src")
    limactl shell "$VM" -- sudo rm -rf "/tmp/audit-$name"
    limactl copy -r "$src" "$VM:/tmp/audit-$name"
    limactl shell "$VM" -- sudo bash -c "install -d -m 700 /var/lib/finance/audit && rm -rf /var/lib/finance/audit/$name && mv /tmp/audit-$name /var/lib/finance/audit/$name"
    shift 2
    in_vm node /opt/contour/finance/fin.mjs audit --dir "/var/lib/finance/audit/$name" "$@"
    ;;
  review)
    journal="${2:?usage: fin.sh review <журнал аудита> <файл.csv>}" out="${3:?usage: fin.sh review <журнал аудита> <файл.csv>}"
    in_vm node /opt/contour/finance/fin.mjs review --journal "$journal"
    limactl shell "$VM" -- sudo cat "/var/lib/finance/audit/$journal.review.csv" >"$out"
    chmod 600 "$out"
    echo "$out"
    ;;
  verdicts)
    journal="${2:?usage: fin.sh verdicts <журнал аудита> <файл.csv>}" file="${3:?usage: fin.sh verdicts <журнал аудита> <файл.csv>}"
    ext="${file##*.}"
    limactl copy "$file" "$VM:/tmp/verdicts.$ext"
    limactl shell "$VM" -- sudo bash -c "install -d -m 700 /var/lib/finance/audit && mv /tmp/verdicts.$ext /var/lib/finance/audit/$journal.verdicts.$ext"
    in_vm node /opt/contour/finance/fin.mjs score --journal "$journal" --review "/var/lib/finance/audit/$journal.verdicts.$ext"
    ;;
  "" | -h | --help)
    sed -n '2,12p' fin.sh
    ;;
  *)
    in_vm node /opt/contour/finance/fin.mjs "$@"
    ;;
esac
