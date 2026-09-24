# Рендерер публичных ссылок на отдельной VM

Рендерер — изолированный headless Chromium. Он открывает только публичные SPA-сайты из allowlist: `*.lovable.app`, `*.bolt.host`, `*.replit.app`, `*.github.io` и `gemini.google.com/share`. Результат — снимок DOM. Claude, ChatGPT, v0, Perplexity и AI Studio рендерер не открывает никогда: их условия запрещают автоматическое извлечение. Как импорт использует снимок, описано в [docs/specs/URL_IMPORT_SUPPORT.md](../../docs/specs/URL_IMPORT_SUPPORT.md), что делает бот — на странице [/bot](https://polochka.app/bot).

Рендерер можно запустить двумя способами:

- **в том же compose**, что и Полка: `--profile renderer` в [deploy/hosted/compose.yml](../hosted/compose.yml) или [deploy/compose.base.yml](../compose.base.yml). Подходит для self-host и локальной разработки ([deploy/hosted/README.md](../hosted/README.md), раздел «Рендерер ссылок»);
- **на отдельной VM** — этот каталог. Chromium исполняет чужой JavaScript, поэтому для рабочей установки лучше отдельная машина: без базы, хранилища и секретов Полки и без доступа в её сеть.

## Что внутри

- `renderer`: образ [apps/renderer/Dockerfile](../../apps/renderer/Dockerfile) на официальном Playwright-образе, закреплённом по digest. В контейнере запущены Node-сервис `POST /render` и egress-прокси на `127.0.0.1:3128`. Chromium выходит в сеть только через этот прокси, loopback тоже. Прокси разрешает только `CONNECT` на порт 443. Он один раз резолвит DNS, закрепляет адрес и отказывает, если хотя бы один адрес непубличный: RFC 1918, адреса Docker, `169.254.169.254` (metadata), loopback, IPv6 ULA и link-local. Правило общее с импортом: [packages/public-address.ts](../../packages/public-address.ts). WebSocket, WebRTC, WebTransport, service workers, загрузки файлов и запросы разрешений в браузере выключены. Одновременно рендерится одна страница, до трёх ждут в очереди, таймаут 25 с. На каждый запрос создаётся новый контекст браузера, после ответа он уничтожается.
- `caddy`: TLS для `RENDERER_HOST`. К рендереру пропускаются только запросы с адреса `APP_VM_IP`.
- Каждый запрос приложения подписан HMAC-SHA256 с `RENDERER_SECRET` по времени, методу, пути и SHA-256 тела. Допустимое расхождение часов — 60 с ([packages/renderer-contract.ts](../../packages/renderer-contract.ts)).
- Приложение получает от рендерера только HTML страницы и фреймов, не больше 5 МБ каждого. CSS, картинки и шрифты оно скачивает и локализует само через `fetchPublic`, как при обычном импорте.
- В логах рендерера есть только исход и длительность рендера (`{"event":"render","outcome":"ok","ms":6120}`) и число отказов прокси. URL в логи не пишутся.

## Регион

Рендерер по умолчанию размещается **в России, Yandex Cloud `ru-central1`**. Ссылку вставляет пользователь, поэтому она относится к его данным (152-ФЗ). Если рендерер стоит в России, ссылка страну не покидает, и отдельная обработка за рубежом не появляется.

## Yandex Cloud (по умолчанию)

1. **VM.** Compute Cloud, зона `ru-central1-a` (или b/d). Платформа Intel Ice Lake, 2 vCPU, 2–4 ГБ RAM, 20 ГБ SSD, Ubuntu 24.04 LTS. Публичный IP нужен для исходящих запросов и Let's Encrypt. Сервисный аккаунт не назначайте: рендереру не нужны API облака.
2. **Группа безопасности** — отдельная, только для этой VM:
   - входящий TCP 443 — только с IP основной VM (`<IP>/32`);
   - входящий TCP 80 — с `0.0.0.0/0`, только если сертификат выпускается через Let's Encrypt (HTTP-01). На этом порту Caddy отвечает только ACME и редиректом, до рендерера запросы не доходят. Без порта 80 используйте внутренний сертификат (см. ниже);
   - входящий TCP 22 — только с адреса администратора, на время обслуживания;
   - исходящий TCP 80 и 443 — в `0.0.0.0/0`. Исходящий UDP 53 — к DNS-резолверу облака. Больше ничего;
   - в группе безопасности основной VM ничего не разрешайте для адреса рендерера. Подсеть рендерера не должна иметь маршрутов к приватной сети основной VM: поставьте её в отдельную сеть VPC или ограничьте это группами безопасности.
3. **Metadata.** Рендеру metadata-сервис не нужен. После первой загрузки, когда ключи SSH уже применены, выключите его:
   ```bash
   yc compute instance update <имя-vm> \
     --metadata-options gce-http-endpoint=disabled,aws-v1-http-endpoint=disabled
   ```
   Дополнительно закройте контейнерам путь к metadata и приватным сетям правилом `DOCKER-USER`, на случай если Chromium когда-нибудь обойдёт прокси:
   ```bash
   sudo iptables -I DOCKER-USER -s 172.16.0.0/12 -d 169.254.0.0/16 -j DROP
   sudo iptables -I DOCKER-USER -s 172.16.0.0/12 -d 10.0.0.0/8 -j DROP
   sudo iptables -I DOCKER-USER -s 172.16.0.0/12 -d 192.168.0.0/16 -j DROP
   sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save
   ```
4. **Docker.** Установите Docker Engine и плагин compose по [официальной инструкции](https://docs.docker.com/engine/install/ubuntu/).
5. **Код и env.** Нужен только этот репозиторий, без секретов Полки:
   ```bash
   git clone https://github.com/artkruglov/polka.git && cd polka/deploy/renderer
   cp renderer.env.example renderer.env
   # RENDERER_HOST — DNS-имя (A-запись на IP этой VM),
   # APP_VM_IP — адрес основной VM, RENDERER_SECRET — `openssl rand -hex 32`
   ```
6. **Запуск:**
   ```bash
   docker compose --env-file renderer.env up -d --build
   docker compose --env-file renderer.env logs -f renderer   # {"event":"renderer.ready",…}
   ```
7. **Основная VM** — в `deploy/hosted/hosted.env`:
   ```
   URL_IMPORT_ENABLED=true
   RENDERED_IMPORT_ENABLED=true
   RENDERER_URL=https://renderer.polka.example.com
   RENDERER_SECRET=<тот же секрет>
   ```
   Затем `docker compose --env-file hosted.env up -d`. Проверьте, что в `curl -s https://<APP_HOST>/api/imports/capabilities` в `sources` есть `rendered-spa`.

**Без Let's Encrypt (порт 80 закрыт).** В `Caddyfile` добавьте в блок сайта `tls internal`. Затем скопируйте корневой сертификат Caddy (`docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt`) в `RENDERER_CA` основной VM (PEM, одной строкой с `\n`). Приложение будет доверять только ему. Если основная VM и рендерер в одной сети VPC, `RENDERER_URL` может указывать на внутренний адрес. TLS при этом остаётся, HTTP разрешён только для loopback и адресов Docker-сети.

**Ресурсы.** Chromium с одной страницей занимает 300–700 МБ, пиково до 1 ГБ. Лимит контейнера — 1,5 ГБ RAM, 1,5 CPU, 256 процессов. 2 ГБ на VM хватает, 4 ГБ дают запас для тяжёлых страниц. Одна ссылка рендерится 6–14 с.

**Обновление:** `git pull && docker compose --env-file renderer.env up -d --build`. Базовый образ меняется только правкой digest в `apps/renderer/Dockerfile` и версии `playwright-core` в `apps/renderer/package.json` и корневом `package.json`, одновременно.

## Fly.io (альтернатива)

`fly.toml` в этом каталоге: регион `ams`, машины останавливаются в простое (`auto_stop_machines = "stop"`, `min_machines_running = 0`) и поднимаются при первом запросе. Первый импорт после паузы ждёт холодного старта, 5–15 с.

> **TODO перед включением Fly.io.** Амстердам — это трансграничная передача: URL, который вставил пользователь, обрабатывается за рубежом. До включения нужно (1) добавить в `docs/legal/privacy.md` обработчика (Fly.io, Нидерланды), цель и состав данных (URL страницы) и (2) подать в Роскомнадзор уведомление о трансграничной передаче (ст. 12 152-ФЗ). Пока это не сделано, для polochka.app используйте Yandex Cloud.

```bash
# из корня репозитория
fly apps create <имя>
fly secrets set RENDERER_SECRET=<секрет основной VM> --config deploy/renderer/fly.toml
fly deploy --config deploy/renderer/fly.toml --dockerfile apps/renderer/Dockerfile .
```

На основной VM: `RENDERER_URL=https://<имя>.fly.dev`. Групп безопасности у Fly нет, доступ ограничивает только HMAC-подпись. Приватная сеть Fly (`fdaa::/16`, IPv6 ULA) и metadata закрыты тем же egress-прокси.

## Проверка

- `docker compose exec renderer node -e "fetch('http://127.0.0.1:4395/healthz').then(r=>r.text()).then(console.log)"` → `{"ok":true}`.
- Запрос без подписи или с чужого IP получает `401` от рендерера или `403` от Caddy.
- Egress: `npm run test:renderer-runtime` из корня репозитория, на машине с Docker. Тест собирает образ и проверяет, что прокси внутри контейнера отказывает `169.254.169.254`, адресам Docker-сети и `127.0.0.1`.
