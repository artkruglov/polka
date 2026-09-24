# Рендерер публичных ссылок на отдельной VM

Рендерер — изолированный сервис с headless Chromium. Он делает три вещи, только для адресов из таблицы провайдеров ([packages/contracts/link-providers.ts](../../packages/contracts/link-providers.ts)):

- `POST /render` — снимок DOM публичного SPA-сайта: `*.lovable.app`, `*.bolt.host`, `*.replit.app`, `*.github.io`, `gemini.google.com/share`;
- `POST /render` — одна попытка открыть артефакт Claude (`claude.ai/artifact/…`). Если Cloudflare показывает проверку, ответ `source_blocked` без повторов;
- `POST /fetch` — один HTTP-запрос без браузера к общим ссылкам ChatGPT (`chatgpt.com/share/…`, `chatgpt.com/canvas/shared/…`): разговор уже есть в HTML страницы, а robots.txt разрешает эти пути.

Перед каждым запросом рендерер сам читает robots.txt для `PolkaRenderer`. v0, Perplexity, AI Studio и `claude.site` он не открывает никогда. Как импорт использует ответ, описано в [docs/specs/URL_IMPORT_SUPPORT.md](../../docs/specs/URL_IMPORT_SUPPORT.md), что делает бот — на странице [/bot](https://polochka.app/bot).

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

Ссылку вставляет пользователь, поэтому она относится к его данным (152-ФЗ). Где стоит рендерер, там её и обрабатывают.

- **Yandex Cloud `ru-central1`**: ссылка не покидает Россию. Отсюда работают Lovable, bolt.host, Replit, GitHub Pages и Gist. chatgpt.com с российских IP отвечает 403, claude.ai перенаправляет на «app unavailable in region», доступность Gemini share не подтверждена. Для self-host в России это основной вариант.
- **Fly.io, Амстердам (`ams`)**: работают ещё ChatGPT share и Gemini share. Это трансграничная передача: см. TODO в разделе «Fly.io». Для polochka.app выбран этот вариант, флаг включается после юридических шагов.

## Yandex Cloud

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

## Fly.io

[`fly.toml`](fly.toml) в этом каталоге: приложение `polka-renderer`, регион `ams`, `shared-cpu-2x` с 2 ГБ RAM. Машина останавливается в простое (`auto_stop_machines = "stop"`, `min_machines_running = 0`) и поднимается при первом запросе. Первый импорт после паузы ждёт холодного старта, 5–15 с.

> **TODO перед включением на polochka.app.** Амстердам — это трансграничная передача: URL, который вставил пользователь, и публичное содержимое страницы обрабатываются в Нидерландах (без хранения). До включения `RENDERED_IMPORT_ENABLED=true`:
> 1. добавить в `docs/legal/privacy.md` обработчика (Fly.io, Нидерланды), цель (копия страницы по запросу пользователя), состав данных (URL страницы) и срок (не хранится);
> 2. подать в Роскомнадзор уведомление о трансграничной передаче (ст. 12 152-ФЗ) и добавить пункт в чек-лист владельца.
>
> Развернуть рендерер можно заранее: пока флаг выключен, приложение к нему не обращается.

Пошагово (владелец, из корня репозитория; облачные ресурсы этот репозиторий сам не создаёт):

1. Установите [flyctl](https://fly.io/docs/flyctl/install/) и войдите: `fly auth login`.
2. Создайте приложение. Имя из `fly.toml` занято глобально; если оно недоступно, выберите своё и поменяйте `app` в `fly.toml`:
   ```bash
   fly apps create polka-renderer
   ```
3. Секрет, общий с основной VM (его же положите в `hosted.env` и в Lockbox `polka-hosted-env`):
   ```bash
   openssl rand -hex 32   # скопировать
   fly secrets set RENDERER_SECRET=<секрет> --config deploy/renderer/fly.toml --stage
   ```
4. Разверните. Образ собирается из корня репозитория по `apps/renderer/Dockerfile`:
   ```bash
   fly deploy --config deploy/renderer/fly.toml --dockerfile apps/renderer/Dockerfile .
   ```
5. Оставьте одну машину: рендерер обрабатывает одну страницу за раз, и одна машина проще в учёте.
   ```bash
   fly scale count 1 --config deploy/renderer/fly.toml
   ```
6. Проверьте: `curl -s https://polka-renderer.fly.dev/healthz` → `{"ok":true}`. `curl -s -X POST https://polka-renderer.fly.dev/render -d '{}'` → `401`.
7. На основной VM в `deploy/hosted/hosted.env`:
   ```
   URL_IMPORT_ENABLED=true
   RENDERER_URL=https://polka-renderer.fly.dev
   RENDERER_SECRET=<тот же секрет>
   RENDERED_IMPORT_ENABLED=false   # true — после TODO выше
   ```
   `docker compose --env-file hosted.env up -d`. После включения флага проверьте `curl -s https://<APP_HOST>/api/imports/capabilities`: в `sources` появятся `rendered-spa`, `server-fetch` и `server-try`.
8. Логи: `fly logs --config deploy/renderer/fly.toml`. В логах только исход и длительность, без URL.

Групп безопасности у Fly нет: доступ ограничивает HMAC-подпись с окном 60 с. Приватная сеть Fly (`fdaa::/16`, IPv6 ULA) и metadata закрыты тем же egress-прокси. Обновление — снова шаг 4.

## Проверка

- `docker compose exec renderer node -e "fetch('http://127.0.0.1:4395/healthz').then(r=>r.text()).then(console.log)"` → `{"ok":true}`.
- Запрос без подписи или с чужого IP получает `401` от рендерера или `403` от Caddy.
- Egress: `npm run test:renderer-runtime` из корня репозитория, на машине с Docker. Тест собирает образ и проверяет, что прокси внутри контейнера отказывает `169.254.169.254`, адресам Docker-сети и `127.0.0.1`.
