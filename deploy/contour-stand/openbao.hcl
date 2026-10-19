# OpenBao with file storage: secrets survive a restart. The unseal key and
# root token sit in /etc/contour/bao-init.json (root only) — a stand
# exception; a customer uses auto-unseal and AppRole for the dispatcher.
storage "file" { path = "/openbao/file" }
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}
disable_mlock = true
ui            = false
