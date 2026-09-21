# Реальное подключение MCP в интерфейсе

Контракт: [MCP_ONBOARDING_SPEC](../../MCP_ONBOARDING_SPEC.md). Luna реализовала общий AgentConnections для /settings/agents и /connections, отдельные typed CSRF API методы, одноразовый token state, list/revoke и инструкции клиентов.

Root проверил в браузере настоящую выдачу подключения с одним scope context и TTL1день → закрытие токена → reload (токена нет, запись есть) → revoke («Доступ отозван»). Содержимое токена не выводилось, тестовое подключение отозвано. Второй маршрут /connections#agent отображает тот же flow. На390px clientWidth/scrollWidth/innerWidth390; root исправил конфликт с глобальным label CSS, computed scope display grid, client selector direction row, screenshot показывает checkbox рядом с названием.

Astra нашла два дефекта: definite4xx ошибочно обозначались как неизвестная выдача; empty/HTML401 терял status при JSON parse. Luna исправила оба и добавила два regression tests. Malformed issue/list DTO проверяются до state. 401 очищает secret и отменяет pending; no automatic retry unknown issue. Check/build/diff-check проходят. Новые tests включены в default suite; отдельный прогон описан ниже.

Ограничения: browser issue-токен не использовался для отдельного native client запроса, поэтому связанный UI→seen→capture flow здесь ещё не принят. Реальный Codex context/capture/prepare/share проверен отдельным CLI протоколом. Guest return, clipboard denial, потеря issue response и late response после unmount ещё не воспроизведены браузерным fault injection; code review не выдаётся за такой эксперимент. OAuth и второй клиент остаются открыты.
