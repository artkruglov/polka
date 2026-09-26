# Открытое ядро и коммерческая редакция

Полка устроена как открытое ядро и коммерческая редакция для организаций.

- **Открытое ядро** — весь код в этом репозитории, под [GNU AGPL-3.0](LICENSE), бесплатно для всех.
  - В ядре есть всё, что нужно человеку, команде и компании на своей установке: сохранение из агентов, версии и ссылки, интерактивный просмотр, проекты, поиск по тексту, библиотеки шаблонов, вход через OpenID Connect, Яндекс ID и VK ID, полки отделов с ролями, агенты по полкам, страница администратора компании, модерация, бэкапы.
  - Облако [polochka.app](https://polochka.app) работает на открытом ядре.
- **Коммерческая редакция** — расширение ядра для организаций (`@polka/enterprise`), закрытый код. Распространяется только по договору с правообладателем, Кругловым Артемом Игоревичем, и включается подписанным ключом лицензии. Подключается через [точки расширения](docs/specs/EXTENSIONS.md) ядра.
  - Сейчас в ней контроль ссылок: ссылки только для сотрудников, предельный срок ссылок для компании, кто выпускает ссылки с полок отделов.
  - Дальше: контроль и журнал агентов, события и коннекторы (Битрикс24, Jira, 1С), выгрузка в S3 и WebDAV, SAML и SCIM, установка без интернета.
- **Коммерческая лицензия на ядро** — по договору, если условия AGPL-3.0 не подходят (см. ниже).

Версии до v0.1.0-rc.5 включительно и все коммиты до смены лицензии остаются доступны на условиях Apache-2.0. Эти условия не отзываются. Всё, что опубликовано в этом репозитории под AGPL-3.0, остаётся под AGPL-3.0.

## Кому лицензия не нужна

- Вы запускаете Полку без изменений — для себя, команды или компании, в том числе как сетевой сервис.
- Вы меняете код и публикуете свои изменения на условиях AGPL-3.0: в том числе даёте пользователям своей установки ссылку на исходный код изменённой версии (§ 13 AGPL). Для этого в Полке есть настройка `SOURCE_URL`, см. [deploy/hosted/README.md](deploy/hosted/README.md#исходный-код-изменённой-версии).
- Вы пользуетесь облаком [polochka.app](https://polochka.app). Это отдельный сервис, он работает по своему [пользовательскому соглашению](docs/legal/terms.md), лицензия на код к нему не относится.

## Кому нужна

- Компании, которая хочет запускать изменённую Полку как сетевой сервис и не публиковать свои изменения на условиях AGPL-3.0.
- Тем, кто встраивает Полку или её части в закрытый продукт, который распространяется или предоставляется по сети не на условиях AGPL-3.0.
- Тем, кому нужны гарантии, поддержка или SLA по договору. AGPL-3.0 даёт код «как есть», без гарантий (§§ 15–16).

## Что даёт коммерческая лицензия

Право использовать, изменять и предоставлять Полку, в том числе изменённую, без обязанностей AGPL-3.0 раскрывать исходный код. Точный объём прав, срок, территория, число установок, поддержка и гарантии согласуются в договоре. Лицензия не даёт прав на название и знаки «Полка».

## Как получить

Напишите на [hello@polochka.app](mailto:hello@polochka.app): кто вы, как собираетесь использовать Полку, нужны ли поддержка и SLA. Цена пока обсуждается в каждом случае отдельно, фиксированного прайса нет.

## Ключ лицензии

Открытое ядро не проверяет никаких ключей и не имеет технических ограничений. Ключ нужен только коммерческой редакции: без действительного ключа не включается само расширение, а ядро работает всегда.

Этот файл объясняет, как устроено лицензирование, и не заменяет текст [LICENSE](LICENSE) или договора. При расхождении действует текст лицензии или договора.

---

## Open core and commercial edition (summary in English)

Полка is an open core with a commercial edition for organisations.

- **The open core** is all the code in this repository, licensed under the [GNU AGPL-3.0](LICENSE) and free for everyone. The hosted service at [polochka.app](https://polochka.app) runs it.
- **The commercial edition** is a proprietary extension of the core for organisations (`@polka/enterprise`). It is available only under an agreement with the copyright holder, Artem Kruglov, and is enabled by a signed license key. It plugs into the core's [extension points](docs/specs/EXTENSIONS.md). Today it adds link controls: employee-only links, a company-wide maximum link lifetime, and who may issue links from department shelves.
- **A commercial license for the core** is available for anyone who cannot accept the AGPL-3.0: for example, to run a modified Полка as a network service without publishing the changes, or to embed it in a proprietary product.

Releases up to and including v0.1.0-rc.5, and all commits before the change, remain available under Apache-2.0. What is published here under the AGPL-3.0 stays under the AGPL-3.0. The core has no license key; only the commercial edition checks one. Write to [hello@polochka.app](mailto:hello@polochka.app). This file is an explanation, not the license; the LICENSE text or the signed agreement prevails.
