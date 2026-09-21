# R09: название, папка и пагинация

Luna добавила общий metadata service и PATCH с expectedTitle/expectedFolderId. Tenant/owner/disabled и targetfolder проверяются до update; metadata CAS даёт409; версии и shares не изменяются. Astra нашла title161–200 несовместимый с загрузкой следующейверсии: title теперь max160, expectedTitle200 оставлен для восстановления. Boundary regression добавлен.

Owner UI: «Название и папка», отдельная форма, смена папки и «Без папки», busy/errors, conflict recovery. Root исправил effect, который стирал draft при обновлении snapshot того же artifact.

## Настоящий browser flow

Через /bring загружен собственный calculator-1.html как тестовый private artifact `b5cfa9bd-fab1-4aa8-ad4f-19c135bdba04`. Название изменено, материал перенесён в существующую папку «Проекты». Затем во второй вкладке сохранено другое название; первая вкладка получила409 и сохранила введённый черновик. «Обновить данные» оставило черновик; явное повторное сохранение сработало. Тест возвращён в «Без папки», назван «Тест Полки — название и папка (демо)». Reload подтвердил результат. Revision остаётся `43bf45d0-4bd2-4561-ba7e-e66caeb62cf3`, v1. Пользовательские исходные документы не редактировались; обе временные вкладки закрыты.

## Пагинация

Sol исправил web cursor: дата берётся из PostgreSQL с шестью дробными знаками, вместо округления через JS Date. HTTP regression создаёт26 артефактов внутри одной миллисекунды и получает все26 уникальных IDs через две страницы.

Общий прогон после объединения: **npm test68/68**; check/build прошли, diff-check чистый. Backend metadata regression проверяет hash/revision/share preservation, чужой artifact/folder и staleCAS. Browser mobile для metadata диалога и удаление/trash ещё не приняты; весь R09 не закрыт.
