**Что меняется и зачем / What changes and why**

**Как проверено / How it was tested**

**Проверки / Checks**
- [ ] `npm run check`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm test -- --live` (если затронуты viewer, сборщик, runtime или «Интересное» / if the viewer, builder, runtime or catalogue changed)
- [ ] Новая миграция и `deploy/runtime-grants.sql` (если меняется схема) / New migration and grants (if the schema changes)
- [ ] Документация и `CHANGELOG.md` обновлены / Docs and `CHANGELOG.md` updated
