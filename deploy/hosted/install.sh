#!/bin/sh
# Полка on one VM from the published image: no build, no Node.js on the host.
#
# Download it, read it, run it (safer than piping into sh):
#   curl -fsSLo polka-install.sh https://raw.githubusercontent.com/artkruglov/polka/main/deploy/hosted/install.sh
#   less polka-install.sh
#   S3_ACCESS_KEY=… S3_SECRET_KEY=… BACKUP_S3_ACCESS_KEY=… BACKUP_S3_SECRET_KEY=… \
#   sudo -E sh polka-install.sh --app-host polka.company.ru --viewer-host polka-view.company.net \
#     --s3-endpoint https://storage.yandexcloud.net --s3-region ru-central1 \
#     --s3-bucket company-polka-objects --backup-bucket company-polka-backups
# From a checkout: sudo -E sh deploy/hosted/install.sh … (uses that checkout's files).
# Missing answers are asked on the terminal (secrets without echo); --yes never asks.
#
# What it does, each step safe to repeat:
#   1. checks Docker and the compose plugin;
#   2. pulls ghcr.io/artkruglov/polka:<release> and polka-backup:<release>
#      (--release; default: the newest release, pinned by its version);
#   3. copies that release's deploy files out of the image into <dir>/deploy
#      (a file you changed is kept as <file>.previous);
#   4. checks that both hosts resolve to this machine (--skip-dns-check);
#   5. writes <dir>/deploy/hosted/hosted.env (mode 600) with
#      scripts/hosted-setup.mjs inside the image: generated database passwords
#      and LINK_KEY, never printed. An existing file is kept unless --force
#      (which keeps its secrets and changes only what you pass; --rotate makes
#      new ones);
#   6. docker compose up -d, then waits for the app to be healthy.
# Then: the first administrator (account bootstrap) and the checklist (ops doctor).
#
# SC2015: `test && test || die` is meant (die when either test fails).
# SC2163: `export "$name"` exports the variable named by $name, on purpose.
# shellcheck disable=SC2015,SC2163
set -eu

REGISTRY=${POLKA_REGISTRY:-ghcr.io/artkruglov}
DIR=${POLKA_DIR:-/opt/polka}
RELEASE=${POLKA_RELEASE:-latest}
IMAGE=
BACKUP_IMAGE=
APP_HOST=
VIEWER_HOST=
S3_ENDPOINT_URL=
S3_REGION_NAME=
S3_BUCKET_NAME=
BACKUP_BUCKET_NAME=
SMTP_HOST_NAME=
SMTP_PORT_NUMBER=
SMTP_USER_NAME=
MAIL_FROM_ADDRESS=
OIDC_URL=
OIDC_ID=
OIDC_LABEL=
CONTACT=
PUBLIC_IP=
SETS=
LIVE=0
FORCE=0
ROTATE=0
YES=0
SKIP_DNS=0
NO_START=0

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die() {
	printf 'Ошибка: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat <<'EOF'
Использование: sh install.sh [ключи]

  --app-host HOST         адрес приложения (polka.company.ru)
  --viewer-host HOST      адрес просмотра на другом registrable domain (polka-view.company.net)
  --s3-endpoint URL       https://storage.yandexcloud.net
  --s3-region REGION      ru-central1
  --s3-bucket NAME        бакет объектов (versioning включено)
  --backup-bucket NAME    бакет дампов (versioning включено)
  --live                  интерактивный HTML на домене просмотра (HTML_LIVE_MODE=production)
  --smtp-host HOST --smtp-port N --smtp-user USER --mail-from ADDR
                          почта (MAIL_MODE=smtp); пароль — в SMTP_PASS
  --oidc-discovery-url URL --oidc-client-id ID [--oidc-name NAME]
                          вход компании (OIDC); секрет — в OIDC_CLIENT_SECRET
  --operator-contact ADDR адрес для обжалования блокировок (OPERATOR_CONTACT)
  --set KEY=VALUE         любая настройка из hosted.env.example (можно несколько раз)
  --release X.Y.Z         версия образа (по умолчанию — последний релиз)
  --image REF             свой образ приложения вместо опубликованного
  --backup-image REF      свой образ бэкапа (пусто при --image: собрать на VM)
  --dir PATH              куда ставить (/opt/polka)
  --public-ip IP          публичный IP этой VM, если его не определить
  --skip-dns-check        не сверять DNS с IP машины
  --force [--rotate]      обновить существующий hosted.env (секреты остаются; --rotate — новые)
  --no-start              только файлы и hosted.env, без docker compose up
  --yes                   ничего не спрашивать (чего нет — ошибка)

Секреты — только через окружение (не попадут в историю оболочки):
  S3_ACCESS_KEY S3_SECRET_KEY BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY SMTP_PASS OIDC_CLIENT_SECRET
С sudo передайте их ключом -E (sudo -E sh install.sh …).
EOF
}

need_value() {
	[ $# -ge 2 ] && [ -n "$2" ] || die "$1: нужно значение"
}

while [ $# -gt 0 ]; do
	case "$1" in
	--app-host) need_value "$@"; APP_HOST=$2; shift 2 ;;
	--viewer-host) need_value "$@"; VIEWER_HOST=$2; shift 2 ;;
	--s3-endpoint) need_value "$@"; S3_ENDPOINT_URL=$2; shift 2 ;;
	--s3-region) need_value "$@"; S3_REGION_NAME=$2; shift 2 ;;
	--s3-bucket) need_value "$@"; S3_BUCKET_NAME=$2; shift 2 ;;
	--backup-bucket) need_value "$@"; BACKUP_BUCKET_NAME=$2; shift 2 ;;
	--smtp-host) need_value "$@"; SMTP_HOST_NAME=$2; shift 2 ;;
	--smtp-port) need_value "$@"; SMTP_PORT_NUMBER=$2; shift 2 ;;
	--smtp-user) need_value "$@"; SMTP_USER_NAME=$2; shift 2 ;;
	--mail-from) need_value "$@"; MAIL_FROM_ADDRESS=$2; shift 2 ;;
	--oidc-discovery-url) need_value "$@"; OIDC_URL=$2; shift 2 ;;
	--oidc-client-id) need_value "$@"; OIDC_ID=$2; shift 2 ;;
	--oidc-name) need_value "$@"; OIDC_LABEL=$2; shift 2 ;;
	--operator-contact) need_value "$@"; CONTACT=$2; shift 2 ;;
	--set)
		need_value "$@"
		case "$2" in [A-Z]*=*) ;; *) die "--set $2: нужно KEY=VALUE" ;; esac
		case "$2" in *"
"*) die "--set: значение в одну строку" ;; esac
		SETS="${SETS}${2}
"
		shift 2
		;;
	--release) need_value "$@"; RELEASE=${2#v}; shift 2 ;;
	--image) need_value "$@"; IMAGE=$2; shift 2 ;;
	--backup-image) need_value "$@"; BACKUP_IMAGE=$2; shift 2 ;;
	--dir) need_value "$@"; DIR=$2; shift 2 ;;
	--public-ip) need_value "$@"; PUBLIC_IP=$2; shift 2 ;;
	--live) LIVE=1; shift ;;
	--force) FORCE=1; shift ;;
	--rotate) ROTATE=1; shift ;;
	--skip-dns-check) SKIP_DNS=1; shift ;;
	--no-start) NO_START=1; shift ;;
	--yes | -y) YES=1; shift ;;
	-h | --help) usage; exit 0 ;;
	*) usage >&2; die "неизвестный ключ $1" ;;
	esac
done
[ "$ROTATE" = 0 ] || [ "$FORCE" = 1 ] || die "--rotate меняет секреты существующего hosted.env: только вместе с --force"

# Questions go to the terminal even when the script itself came through a pipe.
INTERACTIVE=0
if [ "$YES" = 0 ] && [ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null; then INTERACTIVE=1; fi

# ask VAR "Question" [default]
ask() {
	eval "current=\${$1}"
	[ -n "$current" ] && return 0
	if [ "$INTERACTIVE" = 1 ]; then
		if [ -n "${3:-}" ]; then printf '%s [%s]: ' "$2" "$3" >/dev/tty; else printf '%s: ' "$2" >/dev/tty; fi
		IFS= read -r answer </dev/tty || answer=
		[ -n "$answer" ] || answer=${3:-}
		eval "$1=\$answer"
	elif [ -n "${3:-}" ]; then
		eval "$1=\$3"
	fi
	eval "current=\${$1}"
	[ -n "$current" ] || die "не задано: $2 (ключ или ответ на вопрос)"
}

# ask_secret VAR "Question" [optional]: from the environment, or typed without echo.
ask_secret() {
	eval "current=\${$1:-}"
	if [ -z "$current" ] && [ "$INTERACTIVE" = 1 ]; then
		printf '%s (не отображается): ' "$2" >/dev/tty
		stty -echo </dev/tty 2>/dev/null || true
		IFS= read -r answer </dev/tty || answer=
		stty echo </dev/tty 2>/dev/null || true
		printf '\n' >/dev/tty
		eval "$1=\$answer"
		answer=
	fi
	eval "current=\${$1:-}"
	[ -n "$current" ] || [ "${3:-}" = optional ] || die "не задано: $2 (переменная окружения $1)"
	current=
	export "$1"
}
if [ "$INTERACTIVE" = 1 ]; then trap '{ stty echo </dev/tty; } 2>/dev/null || true' EXIT INT TERM; fi

step "1. Docker"
command -v docker >/dev/null 2>&1 || die "нет Docker: https://docs.docker.com/engine/install/ (нужен и плагин compose)"
docker info >/dev/null 2>&1 || die "Docker не отвечает: запущен ли он и есть ли права (sudo или группа docker)"
docker compose version >/dev/null 2>&1 || die "нет плагина docker compose (пакет docker-compose-plugin)"
say "$(docker --version); $(docker compose version)"
case "$(uname -m)" in
x86_64 | amd64 | aarch64 | arm64) ;;
*) die "образы есть для amd64 и arm64, а здесь $(uname -m)" ;;
esac

SCRIPT_DIR=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
FROM_CHECKOUT=0
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/compose.yml" ] && [ -f "$SCRIPT_DIR/../../package.json" ]; then
	# Started from a checkout: its own files, at whatever commit it is on.
	FROM_CHECKOUT=1
	HOSTED=$SCRIPT_DIR
else
	HOSTED="$DIR/deploy/hosted"
fi
ENV_FILE="$HOSTED/hosted.env"
NEW=1
[ -f "$ENV_FILE" ] && NEW=0
if [ "$NEW" = 0 ] && [ "$FORCE" = 0 ]; then
	# Without --force nothing in hosted.env changes, the image included: the
	# deploy files must be those of the version it names.
	[ -z "$IMAGE" ] && [ "$RELEASE" = latest ] || die "hosted.env уже есть: другая версия — вместе с --force (секреты останутся)"
	IMAGE=$(sed -n 's/^POLKA_IMAGE=//p' "$ENV_FILE")
	BACKUP_IMAGE=$(sed -n 's/^POLKA_BACKUP_IMAGE=//p' "$ENV_FILE")
	[ -n "$IMAGE" ] || die "в $ENV_FILE пуст POLKA_IMAGE"
	RELEASE=${IMAGE##*:}
fi

step "2. Образы"
if [ -z "$IMAGE" ]; then
	IMAGE="$REGISTRY/polka:$RELEASE"
	docker pull "$IMAGE" || die "не скачать $IMAGE (пакет ещё не публичный или нет такой версии)"
	if [ "$RELEASE" = latest ]; then
		# Pin the release: hosted.env names a version, never «latest».
		RELEASE=$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$IMAGE")
		[ -n "$RELEASE" ] && [ "$RELEASE" != "<no value>" ] || die "у $IMAGE нет метки версии"
		docker tag "$IMAGE" "$REGISTRY/polka:$RELEASE"
		IMAGE="$REGISTRY/polka:$RELEASE"
	fi
	[ -n "$BACKUP_IMAGE" ] || BACKUP_IMAGE="$REGISTRY/polka-backup:$RELEASE"
else
	docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" || die "нет образа $IMAGE"
	RELEASE=${IMAGE##*:}
fi
if [ -n "$BACKUP_IMAGE" ]; then
	docker pull "$BACKUP_IMAGE" || die "не скачать $BACKUP_IMAGE"
fi
say "приложение: $IMAGE"
say "бэкап: ${BACKUP_IMAGE:-собирается на VM из deploy/hosted/backup}"

step "3. Файлы установки"
if [ "$FROM_CHECKOUT" = 1 ]; then
	say "файлы из этой копии репозитория: $HOSTED"
else
	mkdir -p "$DIR/deploy" 2>/dev/null || die "нет прав на $DIR: запустите через sudo или выберите --dir"
	tmp=$(mktemp -d)
	cid=$(docker create "$IMAGE")
	docker cp "$cid:/app/deploy/." "$tmp/" >/dev/null
	docker rm "$cid" >/dev/null
	changed=0
	for file in $(cd "$tmp" && find . -type f | sed 's|^\./||'); do
		target="$DIR/deploy/$file"
		mkdir -p "$(dirname "$target")"
		if [ -f "$target" ] && ! cmp -s "$tmp/$file" "$target"; then
			case "$file" in
			migrations/*) ;;
			*) cp -p "$target" "$target.previous" && say "изменённый $file сохранён как $file.previous" ;;
			esac
		fi
		cmp -s "$tmp/$file" "$target" 2>/dev/null || { cp -p "$tmp/$file" "$target" && changed=$((changed + 1)); }
	done
	rm -rf "$tmp"
	say "файлы версии $RELEASE в $DIR/deploy (обновлено: $changed)"
fi
if [ "$NEW" = 0 ] && [ "$FORCE" = 0 ]; then
	say "hosted.env уже есть — не трогаю (изменить: --force, секреты останутся)"
fi

if [ "$NEW" = 1 ] || [ "$FORCE" = 1 ]; then
	if [ "$NEW" = 1 ]; then
		say ""
		say "Новая установка: два домена с A-записями на эту VM и два приватных бакета с версионированием."
		ask APP_HOST "Адрес приложения (polka.company.ru)"
		ask VIEWER_HOST "Адрес просмотра на другом домене (polka-view.company.net)"
		ask S3_ENDPOINT_URL "S3 endpoint" "https://storage.yandexcloud.net"
		ask S3_REGION_NAME "S3 регион" "ru-central1"
		ask S3_BUCKET_NAME "Бакет объектов"
		ask BACKUP_BUCKET_NAME "Бакет дампов"
		ask_secret S3_ACCESS_KEY "Ключ приложения S3: access key"
		ask_secret S3_SECRET_KEY "Ключ приложения S3: secret key"
		ask_secret BACKUP_S3_ACCESS_KEY "Ключ бэкапа (только запись в бакет дампов): access key"
		ask_secret BACKUP_S3_SECRET_KEY "Ключ бэкапа: secret key"
		if [ -z "$SMTP_HOST_NAME" ] && [ "$INTERACTIVE" = 1 ]; then
			printf 'SMTP для кодов входа (Enter — без почты): ' >/dev/tty
			IFS= read -r SMTP_HOST_NAME </dev/tty || SMTP_HOST_NAME=
		fi
		if [ -z "$OIDC_URL" ] && [ "$INTERACTIVE" = 1 ]; then
			printf 'OIDC discovery URL входа компании (Enter — без SSO): ' >/dev/tty
			IFS= read -r OIDC_URL </dev/tty || OIDC_URL=
		fi
	else
		# --force: only what is given changes; secrets from the environment if set.
		for secret in S3_ACCESS_KEY S3_SECRET_KEY BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY; do
			eval "current=\${$secret:-}"
			[ -z "$current" ] || export "$secret"
		done
		current=
	fi
	if [ -n "$SMTP_HOST_NAME" ]; then
		ask SMTP_PORT_NUMBER "SMTP порт" "587"
		ask SMTP_USER_NAME "SMTP пользователь"
		ask MAIL_FROM_ADDRESS "Адрес отправителя (Полка <polka@company.ru>)"
		ask_secret SMTP_PASS "SMTP пароль"
	fi
	if [ -n "$OIDC_URL" ]; then
		ask OIDC_ID "OIDC client id"
		ask_secret OIDC_CLIENT_SECRET "OIDC client secret"
	fi
fi

step "4. DNS"
if [ "$SKIP_DNS" = 1 ]; then
	say "пропущено (--skip-dns-check)"
else
	hosts=
	if [ -n "$APP_HOST" ]; then hosts="$APP_HOST $VIEWER_HOST"; elif [ -f "$ENV_FILE" ]; then
		hosts="$(sed -n 's/^APP_HOST=//p' "$ENV_FILE") $(sed -n 's/^VIEWER_HOST_NAME=//p' "$ENV_FILE")"
	fi
	# Resolution and this machine's public address, with the image's Node.js:
	# the host needs neither dig nor curl.
	# shellcheck disable=SC2086 # hosts is a list of host names
	report=$(docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
		-e PUBLIC_IP="$PUBLIC_IP" "$IMAGE" node -e '
const dns = require("node:dns").promises;
const os = require("node:os");
(async () => {
  const mine = new Set(Object.values(os.networkInterfaces()).flat().map((i) => i.address));
  let pub = process.env.PUBLIC_IP;
  for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip"]) {
    if (pub) break;
    try { pub = (await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text()).trim(); } catch {}
  }
  if (pub) mine.add(pub);
  console.log(`public ${pub || "?"}`);
  for (const host of process.argv.slice(1)) {
    let addresses = [];
    try { addresses = (await dns.lookup(host, { all: true, family: 4 })).map((a) => a.address); } catch {}
    console.log(`${addresses.length && addresses.every((a) => mine.has(a)) ? "ok" : "bad"} ${host} ${addresses.join(",") || "-"}`);
  }
})();' $hosts) || die "не удалось проверить DNS (--skip-dns-check, чтобы пропустить)"
	public=$(printf '%s\n' "$report" | sed -n 's/^public //p')
	say "публичный IP этой VM: $public"
	bad=0
	for line in $(printf '%s\n' "$report" | grep -E '^(ok|bad) ' | tr ' ' '|'); do
		verdict=${line%%|*}
		rest=${line#*|}
		host=${rest%%|*}
		addresses=${rest#*|}
		if [ "$verdict" = ok ]; then say "✓ $host → $addresses"; else
			say "✗ $host → $addresses (нужна A-запись на $public, без прокси CDN)"
			bad=1
		fi
	done
	[ "$bad" = 0 ] || die "DNS ещё не указывает на эту VM: Caddy не получит сертификаты. Исправьте записи и запустите снова (или --skip-dns-check, --public-ip)"
fi

step "5. hosted.env"
if [ "$NEW" = 1 ] || [ "$FORCE" = 1 ]; then
	set -- --out /out/hosted.env --image "$IMAGE"
	[ -z "$BACKUP_IMAGE" ] || set -- "$@" --backup-image "$BACKUP_IMAGE"
	[ -z "$APP_HOST" ] || set -- "$@" --app-host "$APP_HOST"
	[ -z "$VIEWER_HOST" ] || set -- "$@" --viewer-host "$VIEWER_HOST"
	[ -z "$S3_ENDPOINT_URL" ] || set -- "$@" --s3-endpoint "$S3_ENDPOINT_URL"
	[ -z "$S3_REGION_NAME" ] || set -- "$@" --s3-region "$S3_REGION_NAME"
	[ -z "$S3_BUCKET_NAME" ] || set -- "$@" --s3-bucket "$S3_BUCKET_NAME"
	[ -z "$BACKUP_BUCKET_NAME" ] || set -- "$@" --backup-bucket "$BACKUP_BUCKET_NAME"
	[ "$LIVE" = 0 ] || set -- "$@" --live
	if [ -n "$SMTP_HOST_NAME" ]; then
		set -- "$@" --set MAIL_MODE=smtp --set "SMTP_HOST=$SMTP_HOST_NAME" --set "SMTP_PORT=$SMTP_PORT_NUMBER" \
			--set "SMTP_USER=$SMTP_USER_NAME" --set "MAIL_FROM=$MAIL_FROM_ADDRESS"
	fi
	if [ -n "$OIDC_URL" ]; then
		set -- "$@" --set "OIDC_DISCOVERY_URL=$OIDC_URL" --set "OIDC_CLIENT_ID=$OIDC_ID"
		[ -z "$OIDC_LABEL" ] || set -- "$@" --set "OIDC_NAME=$OIDC_LABEL"
	fi
	[ -z "$CONTACT" ] || set -- "$@" --set "OPERATOR_CONTACT=$CONTACT"
	old_ifs=$IFS
	IFS='
'
	for pair in $SETS; do set -- "$@" --set "$pair"; done
	IFS=$old_ifs
	[ "$FORCE" = 0 ] || set -- "$@" --force
	[ "$ROTATE" = 0 ] || set -- "$@" --rotate
	# Secrets travel as environment variables named without values (-e NAME):
	# never on a command line. No network: the script only writes a file.
	docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
		--user "$(id -u):$(id -g)" \
		-e S3_ACCESS_KEY -e S3_SECRET_KEY -e BACKUP_S3_ACCESS_KEY -e BACKUP_S3_SECRET_KEY \
		-e SMTP_PASS -e OIDC_CLIENT_SECRET \
		-v "$HOSTED:/out" "$IMAGE" node scripts/hosted-setup.mjs "$@" || die "hosted.env не записан (причина выше)"
	chmod 600 "$ENV_FILE"
fi

if [ "$NO_START" = 1 ]; then
	say ""
	say "Запуск пропущен (--no-start): cd $HOSTED && docker compose --env-file hosted.env up -d"
	exit 0
fi

step "6. Запуск"
cd "$HOSTED"
if grep -q '^POLKA_BACKUP_IMAGE=.' hosted.env; then
	docker compose --env-file hosted.env up -d
else
	docker compose --env-file hosted.env up -d --build
fi
say "ждём, пока приложение ответит (миграции, проверка хранилища)…"
waited=0
while :; do
	app=$(docker compose --env-file hosted.env ps -q app 2>/dev/null || true)
	health=
	[ -z "$app" ] || health=$(docker inspect -f '{{ if .State.Health }}{{ .State.Health.Status }}{{ end }}' "$app" 2>/dev/null || true)
	[ "$health" = healthy ] && break
	if [ "$waited" -ge 300 ]; then
		docker compose --env-file hosted.env ps
		die "приложение не поднялось за 5 минут: docker compose --env-file hosted.env logs migrate storage-check app"
	fi
	sleep 5
	waited=$((waited + 5))
done

APP=$(sed -n 's/^APP_HOST=//p' hosted.env)
cat <<EOF

Полка $RELEASE запущена: https://$APP

Дальше, из $HOSTED:
  # первый администратор: аккаунт, роль и одноразовая ссылка для входа на час
  docker compose --env-file hosted.env run --rm -T --no-deps app \\
    node --import tsx scripts/admin.ts account bootstrap you@company.ru
  # проверка установки: DNS, TLS, база, хранилище, бэкап, почта, вход
  docker compose --env-file hosted.env run --rm -T --no-deps app \\
    node --import tsx scripts/admin.ts ops doctor

Сохраните копию LINK_KEY из hosted.env в менеджере секретов.
EOF
