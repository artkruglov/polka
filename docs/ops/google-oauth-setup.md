# Вход через Google: настройка в Google Cloud Console

Инструкция для владельца polochka.app. Что делает код и почему на polochka.app Google только привязывается к существующей полке — [SIGN_IN_PROVIDERS.md](../specs/SIGN_IN_PROVIDERS.md), раздел «Google».

Названия разделов консоли — по состоянию на сентябрь 2026. Раздел «OAuth consent screen» Google переименовал в **Google Auth Platform** со страницами Overview, Branding, Audience, Clients, Data Access и Verification Center.

## Что понадобится

- аккаунт Google владельца (лучше отдельный рабочий, а не личный);
- доступ к DNS polochka.app — для подтверждения домена в Search Console;
- логотип Полки: квадрат 120×120 px, PNG или JPG, меньше 1 МБ, без знаков и названий Google;
- опубликованные страницы https://polochka.app/privacy и https://polochka.app/terms.

## 1. Проект

1. Откройте https://console.cloud.google.com/projectcreate.
2. Project name — `Polka`. Organization — «No organization», если у вас нет Google Workspace.
3. **Create**, затем выберите этот проект в верхней панели.

Биллинг для входа через Google не нужен.

## 2. Подтвердите домен

Имя и логотип приложения Google показывает на экране входа только после проверки бренда. Для неё домен должен быть подтверждён в Search Console тем же аккаунтом Google.

1. https://search.google.com/search-console → **Добавить ресурс** → **Доменный ресурс** → `polochka.app`.
2. Добавьте у DNS-провайдера TXT-запись `google-site-verification=…` в корень домена и нажмите **Подтвердить**.

## 3. Google Auth Platform: начало и Branding

1. https://console.cloud.google.com/auth/overview → **Get started**.
2. **App Information:**
   - App name — `Полка`;
   - User support email — `hello@polochka.app`. В списке только адреса самого аккаунта и групп Google, которыми он управляет. Если hello@polochka.app там нет, войдите в консоль аккаунтом, к которому этот адрес привязан, или создайте Google Group с этим адресом.
3. **Audience** — **External**.
4. **Contact Information** — `hello@polochka.app`.
5. Согласитесь с User Data Policy и нажмите **Create**.
6. Откройте **Branding** (https://console.cloud.google.com/auth/branding) и заполните:
   - App logo — логотип Полки 120×120;
   - Application home page — `https://polochka.app`;
   - Application privacy policy link — `https://polochka.app/privacy`;
   - Application terms of service link — `https://polochka.app/terms`;
   - Authorized domains — `polochka.app`;
   - Developer contact information — `hello@polochka.app`.
7. **Save**.

## 4. Data Access

https://console.cloud.google.com/auth/scopes → **Add or remove scopes**. Отметьте только:

- `openid`;
- `.../auth/userinfo.email`;
- `.../auth/userinfo.profile`.

Все три не «чувствительные». Полка других не запрашивает, поэтому проверка приложения (security assessment) не нужна. **Save**.

## 5. Audience: в продакшен

1. https://console.cloud.google.com/auth/audience — User type **External**, статус **Testing**.
2. **Publish app** → подтвердите. Статус станет **In production**.

В статусе Testing войти могут только 100 тестовых пользователей из списка. В продакшене при scopes только `openid`, `email` и `profile` вход открыт всем, предупреждения «приложение не проверено» нет.

## 6. Проверка бренда

1. **Verification Center** (https://console.cloud.google.com/auth/verification) → **Verify branding**.
2. Автоматическая проверка идёт минуты, ручная — 2–3 рабочих дня. Google может написать на контактный адрес: ответьте оттуда же.
3. После одобрения нажмите **Publish branding** в течение 7 дней, иначе статус станет «Need to re-verify».

Пока бренд не проверен, вход работает, но на экране Google вместо «Полка» и логотипа виден только домен polochka.app.

## 7. Клиент

1. **Clients** (https://console.cloud.google.com/auth/clients) → **Create client**.
2. Application type — **Web application**, Name — `Полка (polochka.app)`.
3. Authorized JavaScript origins — не нужны: Полка обменивает код на сервере. Можно оставить пустым.
4. Authorized redirect URIs — ровно одна строка:

   ```
   https://polochka.app/api/auth/idp/google/callback
   ```

   Схема, регистр и путь должны совпадать до символа: Полка отправляет Google `APP_ORIGIN + /api/auth/idp/google/callback`.
5. **Create**. В окне появятся **Client ID** (`….apps.googleusercontent.com`) и **Client secret** (`GOCSPX-…`). Нажмите **Download JSON** или сразу скопируйте секрет: у новых клиентов Google показывает его полностью только один раз, потом видны лишь последние 4 символа. Потеряли — **Add secret**, затем отключите старый.

Для проверки на своём компьютере создайте отдельный клиент с redirect URI `<APP_ORIGIN>/api/auth/idp/google/callback`, где `APP_ORIGIN` — адрес локальной Полки на `http://localhost:<порт>`. В продакшен-клиент localhost не добавляйте.

## 8. Где хранить ID и секрет

1. На VM в `deploy/hosted/hosted.env`:

   ```
   GOOGLE_CLIENT_ID=<Client ID>
   GOOGLE_CLIENT_SECRET=<Client secret>
   GOOGLE_SIGNUP=link-only
   ```

2. Те же три значения — в секрет Yandex Lockbox `polka-hosted-env`, рядом с остальными ключами `hosted.env`. Консоль Yandex Cloud → Lockbox → `polka-hosted-env` → **Создать новую версию**, добавьте ключи `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` и `GOOGLE_SIGNUP` с этими значениями. В репозиторий, чаты и задачи секрет не попадает.
3. Перезапустите: `docker compose --env-file hosted.env up -d`.

## 9. Проверка

1. `curl -s https://polochka.app/api/capabilities | jq .signInProviders` — в списке `{"id":"google","name":"Google","signup":false}`.
2. На https://polochka.app/signup есть кнопка «Войти через Google» с пояснением, что она для тех, кто уже привязал Google.
3. Войдите в свою полку через Яндекс ID или по почте → «Агенты» → «Способы входа» → Google → **Привязать** → выберите аккаунт Google. Вернётесь с «Способ входа привязан».
4. Выйдите и войдите через «Войти через Google» — откроется та же полка.
5. В другом браузере войдите через Google с непривязанным аккаунтом: полка не откроется, на странице входа — «Через Google можно войти только в полку, к которой он уже привязан…».
6. Если что-то не так, в журнале приложения ищите `{"event":"idp.callback_failed","provider":"google",…}`. Код `provider` обычно значит неверный секрет или redirect URI, `state` — просроченный или чужой запрос.

## Если придётся

- **Сменить секрет:** Clients → клиент → **Add secret** → новый секрет в `hosted.env` и Lockbox → перезапуск → **Disable**, затем **Delete** у старого.
- **Выключить вход через Google:** очистите `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET` и перезапустите. Кнопка пропадёт. Привязки останутся и снова заработают, когда клиент вернётся.
