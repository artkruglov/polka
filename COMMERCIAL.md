# Коммерческая лицензия

Код Полки распространяется на двух условиях на выбор (двойное лицензирование):

- **[GNU AGPL-3.0](LICENSE)** — бесплатно, для всех;
- **коммерческая лицензия** — по договору с правообладателем, Кругловым Артемом Игоревичем.

Версии до v0.1.0-rc.5 включительно и все коммиты до смены лицензии остаются доступны на условиях Apache-2.0. Эти условия не отзываются.

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

## Лицензионного ключа нет

В коде нет проверки ключа и никаких технических ограничений: коммерческая версия — тот же код. Граница юридическая, а не техническая: её задают условия AGPL-3.0 и договор.

Этот файл объясняет, как устроено лицензирование, и не заменяет текст [LICENSE](LICENSE) или договора. При расхождении действует текст лицензии или договора.

---

## Commercial license (summary in English)

Полка is dual-licensed: under the [GNU AGPL-3.0](LICENSE), free for everyone, or under a commercial license from the copyright holder, Artem Kruglov. Releases up to and including v0.1.0-rc.5, and all commits before the change, remain available under Apache-2.0.

**You do not need a commercial license** to run unmodified Полка (also as a network service), to modify it and publish your changes under the AGPL-3.0 (including offering your users the modified source, § 13; set `SOURCE_URL`), or to use the hosted service at [polochka.app](https://polochka.app), which is governed by its own terms of service.

**You need one** to run a modified Полка as a network service without publishing your changes under the AGPL-3.0, to embed Полка in a proprietary product, or to get a warranty, support or an SLA under contract.

**To get one**, write to [hello@polochka.app](mailto:hello@polochka.app). Pricing is agreed case by case; there is no price list yet. There is no license key: the commercial edition is the same code, and the boundary is legal, not technical. This file is an explanation, not the license; the LICENSE text or the signed agreement prevails.
