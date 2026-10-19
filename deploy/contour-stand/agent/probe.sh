#!/bin/sh
# Runs inside the sandbox with exactly what an agent gets (checks.sh starts
# it through the dispatcher with profiles/probe.yaml) and tries to step out.
# One line per attempt: «ok|fail <check> — <detail>». Expected refusals are
# «ok». The environment is dumped last so checks.sh can look for secrets in
# it from outside, where the real values are known.
P="$HTTP_PROXY"
O=http://127.0.0.1:4390
# curl prints 000 itself when no answer comes; the body of a past probe must not linger.
code() { : >/tmp/body; curl -sS -o /tmp/body -w '%{http_code}' --max-time 8 "$@" 2>/dev/null || true; }
say() { echo "$1 $2 — $3"; }
# want <check> <expected codes regexp> <curl args...>
want() {
  name=$1; re=$2; shift 2
  c=$(code "$@")
  if echo "$c" | grep -Eq "^($re)$"; then say ok "$name" "$c"; else say fail "$name" "got $c $(head -c 80 /tmp/body)"; fi
}

if dmesg 2>/dev/null | grep -q gVisor; then say ok kernel "gVisor sandbox kernel"; else say fail kernel "not gVisor: $(uname -r)"; fi
want internet-direct 000 --noproxy '*' https://example.com/
want internet-proxy '403|000' https://example.com/
want openbao-via-proxy 403 http://127.0.0.1:8200/v1/sys/health
want keycloak-via-proxy 403 http://127.0.0.1:8080/realms/contour
want postgres-via-proxy '403|000' http://127.0.0.1:5432/
want nats-via-proxy '403|000' http://127.0.0.1:4222/
want opa-via-proxy 403 http://127.0.0.1:8181/v1/data
want host-ssh-direct 000 --noproxy '*' http://10.77.0.1:22/
want litellm-admin '401|403' -H "authorization: Bearer $CONTOUR_MODEL_KEY" http://127.0.0.1:4000/key/list
want polka-no-token 401 $O/api/v1/works
want polka-mint-token '401|403' -X POST $O/api/v1/task-token -H "authorization: Bearer $POLKA_MCP_TOKEN" -H content-type:application/json -d '{"minutes":60}'
want polka-web-api '401|403' $O/api/shelves -H "authorization: Bearer $POLKA_MCP_TOKEN"

# The proxy adds the git token: the agent is the bot without holding a token.
c=$(code http://127.0.0.1:3000/api/v1/user)
if [ "$c" = 200 ] && grep -q '"login":"agent-bot"' /tmp/body; then say ok git-identity "proxy acts as agent-bot"; else say fail git-identity "got $c"; fi
c=$(code -H 'authorization: token forged' http://127.0.0.1:3000/api/v1/user)
if [ "$c" = 200 ] && grep -q '"login":"agent-bot"' /tmp/body; then say ok git-forged-header "own header replaced by the proxy"; else say fail git-forged-header "got $c"; fi
rm -rf /tmp/repo && git clone -q http://127.0.0.1:3000/contour/demo.git /tmp/repo 2>/tmp/git.err && cd /tmp/repo && {
  git -c user.name=probe -c user.email=probe@contour.test commit -q --allow-empty -m probe
  if git push -q origin HEAD:main 2>/dev/null; then say fail git-push-main "pushed to protected main"; else say ok git-push-main "refused"; fi
  b="probe/$(date +%s)"
  if git push -q origin "HEAD:$b" 2>/dev/null; then say ok git-push-branch "$b"; git push -q origin --delete "$b" 2>/dev/null; else say fail git-push-branch "refused"; fi
  cd /
} || say fail git-clone "$(head -c 80 /tmp/git.err)"

# Systems of record: readable through the proxy, never writable from here.
want systems-read 200 http://127.0.0.1:7070/ledger/invoices
want systems-write 403 -X POST http://127.0.0.1:7070/ledger/invoices -H content-type:application/json -d '{"counterparty":"x","amount":1}'
want systems-mail-in 403 -X POST http://127.0.0.1:7070/mail/incoming -H content-type:application/json -d '{"box":"support","from":"a@b","subject":"x","text":"x"}'
# The finance stand (deploy/finance-stand), when it is installed: EDO and the
# ledger readable, nothing writable, the banks closed without their token,
# the bank's real API out of reach.
fin() {
  name=$1; re=$2; shift 2
  c=$(code "$@")
  if [ "$c" = 503 ] || [ "$c" = 502 ]; then say ok "$name" "финансового стенда нет"; elif echo "$c" | grep -Eq "^($re)$"; then say ok "$name" "$c"; else say fail "$name" "got $c $(head -c 80 /tmp/body)"; fi
}
fin fin-read 200 http://127.0.0.1:7071/edo/documents
fin fin-write 403 -X POST http://127.0.0.1:7071/edo/request -H content-type:application/json -d '{"inn":"1","basis":"x"}'
fin fin-bank-no-token 401 http://127.0.0.1:7071/tbank/api/v4/bank-accounts
want tbank-direct 000 --noproxy '*' https://business.tbank.ru/openapi/sandbox/api/v4/bank-accounts
want tbank-proxy '403|000' https://business.tbank.ru/openapi/sandbox/api/v4/bank-accounts

# Budget: the probe profile gives the key a few cents on a priced mock model.
n=0; stopped=""
while [ $n -lt 40 ]; do
  n=$((n+1))
  c=$(code -X POST http://127.0.0.1:4000/v1/chat/completions -H "authorization: Bearer $CONTOUR_MODEL_KEY" -H content-type:application/json \
    -d '{"model":"mock-model","messages":[{"role":"user","content":"hi"}]}')
  [ "$c" = 200 ] || { stopped=$c; break; }
done
if [ -n "$stopped" ] && [ $n -gt 1 ]; then say ok budget "stopped at call $n with $stopped"; else say fail budget "calls $n, last ${stopped:-200}"; fi
want model-not-in-profile '400|401|403' -X POST http://127.0.0.1:4000/v1/chat/completions -H "authorization: Bearer $CONTOUR_MODEL_KEY" -H content-type:application/json \
  -d '{"model":"agent-model","messages":[{"role":"user","content":"hi"}]}'

echo "--- env"
env | sort
