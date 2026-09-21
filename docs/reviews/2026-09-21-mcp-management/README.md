# MCP management — локальная приёмка

Sol реализовал scoped manage, metadata receipts, get/list/folders и lifecycle tools. Astra scoped review принят; unknown cursor state400 исправлен. Migration014 применена, dev перезапущен, readiness200. Focused service3/3 + officialSDK5/5 прошли. Default suite включает agent-management tests.

UI Luna: manage checkbox offdefault; explicitselection не включаетread; response/list enum принимаетmanage. Check/build и Astrareview passed. Rootbrowser подтвердил initialunchecked, selectchecked/readunchecked, resetunchecked. Токен через эту UI форму в этой проверке не выдавался.

## Настоящий Codex CLI Luna

Создан отдельный synthetic fixture обычным capture через officialSDK. Временный token context/read/capture/manage в отдельном synthetic tenant отозван в finally. Native Codex CLI gpt-5.6-luna выполнил context, list_folders, get_artifact, metadata rename и identical replay=true. Artifact title теперь CLI manage verified, revision1 исходная, lifecycleVersion0, trashedAtnull.

Native polka_trash остановлен клиентской проверкой: «MCP tool call requires approval, but approval policy is never». Серверного удаления не было; последующие listtrashed/restore не выполнялись. Exitcode0 означает завершение ответа модели, а не прохождение сценария. Защитные annotations/approval не ослаблялись. Нужно отдельно проверить поддержанный интерактивный workflow подтверждения; SDK lifecycle test не заменяет nativeCLI acceptance.

Результат в cli-result.json. Raw events остаются локально, credentials в evidence не включены. CLI сообщил input149197, cached127488, output1013 tokens; стоимость не вычислялась. Новый запуск без изменения предпосылок не нужен.
