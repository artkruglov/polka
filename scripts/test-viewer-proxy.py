#!/usr/bin/env python3
"""Local TLS proxy smoke; synthetic data, cached image, no host ports/network."""
import argparse
import hashlib
import json
import pathlib
import signal
import subprocess
import tempfile
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--confirm-synthetic', action='store_true')
args = parser.parse_args()

def interrupted(signum, frame):
    raise KeyboardInterrupt('proxy smoke interrupted')

signal.signal(signal.SIGTERM, interrupted)
if not args.confirm_synthetic:
    parser.error('--confirm-synthetic required')
ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'deploy/viewer-staging.nginx.conf.example'
IMAGE = 'sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10'
name = 'polka-proxy-smoke-' + uuid.uuid4().hex[:16]
marker = 'synthetic-capability-' + uuid.uuid4().hex
results = []

def run(argv, timeout=20, check=True):
    value = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    if check and value.returncode:
        raise RuntimeError('command failed: ' + argv[0] + ' (output suppressed)')
    return value

def inside(*argv, check=True):
    return run(['docker', 'exec', name, *argv], check=check)

def record(label, ok):
    results.append({'case': label, 'passed': bool(ok)})

handler = r'''#!/bin/sh
IFS= read -r request
length=0; host=''; cookie=''; auth=''; dest=''; proto=''; count=0
while IFS= read -r line; do
 line=$(printf '%s' "$line" | tr -d '\r')
 [ -z "$line" ] && break
 count=$((count+1)); [ "$count" -gt 100 ] && exit 1
 key=$(printf '%s' "${line%%:*}" | tr '[:upper:]' '[:lower:]')
 value=${line#*:}; value=${value# }
 case "$key" in
 content-length) length=$value;; host) host=$value;; cookie) cookie=$value;;
 authorization) auth=$value;; sec-fetch-dest) dest=$value;; x-forwarded-proto) proto=$value;;
 esac
done
case "$length" in *[!0-9]*|'') exit 1;; esac
[ "$length" -gt 9437184 ] && exit 1
bytes=$(head -c "$length" | wc -c | tr -d ' ')
body=$(printf 'host=%s\ncookie=%s\nauth=%s\ndest=%s\nproto=%s\nbytes=%s\n' "$host" "$cookie" "$auth" "$dest" "$proto" "$bytes")
size=$(printf '%s' "$body" | wc -c | tr -d ' ')
printf 'HTTP/1.1 200 OK\r\nContent-Length: %s\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Security-Policy: default-src '\''none'\''; sandbox allow-scripts\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nSet-Cookie: synthetic=1; Secure\r\n\r\n%s' "$size" "$body"
'''
with tempfile.TemporaryDirectory(prefix='polka-proxy-smoke-') as temporary:
    directory = pathlib.Path(temporary)
    snapshot = directory / 'nginx.conf'
    snapshot.write_bytes(CONFIG.read_bytes())
    (directory / 'handler.sh').write_text(handler)
    (directory / 'handler.sh').chmod(0o755)
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
         '-keyout', str(directory / 'privkey.pem'), '-out', str(directory / 'fullchain.pem'),
         '-subj', '/CN=viewer.example-b.invalid', '-addext',
         'subjectAltName=DNS:viewer.example-b.invalid,DNS:app.example-a.invalid'])
    created = False
    failure = None
    cleanup = False
    try:
        # Preflight refuses any existing named resource. Never remove by prefix.
        existing = run(['docker', 'container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'])
        if existing.stdout.strip():
            raise RuntimeError('container name collision')
        created = True  # An uncertain create is cleaned up by this exact random name.
        run(['docker', 'run', '-d', '--pull=never', '--name', name, '--network', 'none',
             '--read-only', '--memory', '128m', '--cpus', '1', '--pids-limit', '64',
             '--tmpfs', '/var/cache/nginx', '--tmpfs', '/var/run', '--tmpfs', '/var/log/nginx',
             '--tmpfs', '/tmp', '-v', str(snapshot) + ':/etc/nginx/nginx.conf:ro',
             '-v', temporary + ':/fixture:ro',
             '-v', temporary + ':/etc/nginx/tls/app:ro',
             '-v', temporary + ':/etc/nginx/tls/viewer:ro', '--entrypoint', '/bin/sh', IMAGE,
             '-c', 'nc -lk -s 127.0.0.1 -p 4390 -e /fixture/handler.sh & '
             'nc -lk -s 127.0.0.1 -p 4391 -e /fixture/handler.sh & echo $! >/tmp/viewer.pid; '
             'exec nginx -g "daemon off;"'])
        inside('nginx', '-t')
        inside('sh', '-c', 'head -c 2097152 /dev/zero >/tmp/body2; head -c 9437184 /dev/zero >/tmp/body9')
        def request(sni, host=None, path=None, extra=(), scheme='https'):
            port = '443' if scheme == 'https' else '80'
            command = ['curl', '--noproxy', '*', '--cacert', '/fixture/fullchain.pem',
                       '--resolve', sni + ':' + port + ':127.0.0.1', '--max-time', '8',
                       '--http1.1', '-sS', '-D', '/tmp/headers', '-o', '/tmp/body', '-w', '%{http_code}']
            if host: command += ['-H', 'Host: ' + host]
            command += list(extra) + [scheme + '://' + sni + (path or '/document/' + marker)]
            reply = inside(*command, check=False)
            headers = inside('cat', '/tmp/headers', check=False).stdout
            body = inside('cat', '/tmp/body', check=False).stdout
            request.last_error = reply.stderr
            return reply.returncode, reply.stdout, headers.lower(), body
        app = 'app.example-a.invalid'; viewer = 'viewer.example-b.invalid'
        code, status, headers, body = request(app, extra=('-H', 'Cookie: synthetic=1', '-H', 'Authorization: Bearer synthetic'))
        record('app routing and credentials preserved', code == 0 and status == '200' and 'host='+app in body and 'cookie=synthetic=1' in body and 'auth=Bearer synthetic' in body)
        code, status, headers, body = request(viewer, extra=('-H', 'Cookie: synthetic=1', '-H', 'Authorization: Bearer synthetic', '-H', 'Sec-Fetch-Dest: iframe'))
        record('viewer routing strips credentials and preserves fetch metadata', code == 0 and status == '200' and 'host=127.0.0.1:4391' in body and 'cookie=\n' in body and 'auth=\n' in body and 'dest=iframe' in body)
        record('viewer CSP cache nosniff and cookie response', 'content-security-policy: default-src' in headers and 'sandbox allow-scripts' in headers and 'cache-control: no-store' in headers and 'x-content-type-options: nosniff' in headers and 'set-cookie:' not in headers)
        for sni, host in [(app, viewer), (viewer, app), (viewer, 'unknown.invalid')]:
            code, status, _, _ = request(sni, host)
            record('reject Host '+host+' with SNI '+sni, code == 0 and status == '421')
        code, status, _, _ = request('unknown.invalid')
        record('unknown SNI handshake rejected', code == 35 and status == '000' and 'unrecognized name' in request.last_error.lower().replace('_', ' '))
        code, status, headers, _ = request(viewer, scheme='http')
        record('HTTP viewer rejected without redirect', code != 0 and status == '000' and 'location:' not in headers)
        code, status, _, body = request(app, extra=('-H', 'Expect:', '--data-binary', '@/tmp/body2'))
        record('app permits 2MiB body', code == 0 and status == '200' and 'bytes=2097152' in body)
        code, status, _, _ = request(app, extra=('-H', 'Expect:', '--data-binary', '@/tmp/body9'))
        record('app rejects body above8MiB', code == 0 and status == '413')
        code, status, _, _ = request(viewer, extra=('-H', 'Expect:', '--data-binary', '@/tmp/body2'))
        record('viewer oversized body rejected', code == 0 and status == '413')
        code, status, _, _ = request(viewer, 'bad host')
        record('malformed Host rejected', code == 0 and status == '400')
        inside('sh', '-c', 'kill "$(cat /tmp/viewer.pid)"')
        code, status, headers, _ = request(viewer)
        record('viewer upstream failure no cache', code == 0 and status == '502' and 'cache-control: no-store' in headers)
        logs = inside('sh', '-c', 'cat /var/log/nginx/* 2>/dev/null', check=False).stdout
        docker_logs = run(['docker', 'logs', name], check=False)
        record('all proxy logs exclude capability marker', marker not in logs + docker_logs.stdout + docker_logs.stderr)
    except Exception as error:
        failure = type(error).__name__ + ': ' + str(error)
    finally:
        if created:
            removed = run(['docker', 'rm', '-f', name], check=False)
            absent = run(['docker', 'container', 'ls', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}'], check=False)
            cleanup = removed.returncode == 0 and absent.returncode == 0 and not absent.stdout.strip()
    result = {'configSha256': hashlib.sha256(snapshot.read_bytes()).hexdigest(), 'image': IMAGE,
              'cases': results, 'failure': failure, 'containerRemoved': cleanup,
              'network': 'none', 'hostPorts': False, 'trustStoreChanged': False,
              'browserAcceptance': False, 'productionAcceptance': False}
    print(json.dumps(result, indent=2))
    if failure or not cleanup or not results or not all(item['passed'] for item in results):
        raise SystemExit(1)
