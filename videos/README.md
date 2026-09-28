# Ролики Полки

Два немых ролика для лендинга, собранные кодом на [Remotion](https://www.remotion.dev) из настоящих стилей и компонентов Полки:

- `PolkaPeople` — «Для людей», ≈ 33 с: агент сделал работу → «Моя полка» → ссылка → пост → телефон друга.
- `PolkaCompanies` — «Для компаний», ≈ 34 с: работа теряется в чатах отделов → девять функций Полки для компании.

Бренд-кит и принятые решения — [BRAND.md](BRAND.md). Отдельный пакет: в зависимости и образ Полки не входит.

```sh
cd videos && npm install
npm run studio                                   # просмотр и правка
bun scripts/stills.ts out/review 600 --composition PolkaPeople   # кадры для проверки
npx remotion render src/index.ts PolkaPeople out/final/PolkaPeople.mp4 --props='{"fps":60}' --crf=18
```

Remotion распространяется по своей лицензии: бесплатно для частных лиц и небольших команд, крупным компаниям нужна лицензия компании ([remotion.dev/license](https://www.remotion.dev/license)). Сторонний код — [THIRD_PARTY.md](THIRD_PARTY.md).
