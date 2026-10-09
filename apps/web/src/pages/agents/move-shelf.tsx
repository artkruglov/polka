import React from "react";
import { CopyButton } from "../../shared/ui/CopyText.tsx";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * «Перенести полку» in the settings (docs/specs/SHELF_TRANSFER.md): the whole
 * shelf into a folder with polka-export.mjs, then the operator of the other
 * installation saves it there with npm run shelf:import.
 */
export function MoveShelf({ origin }: { origin: string }) {
  const commands = [
    `curl -fsSLo polka-export.mjs ${shellQuote(`${origin}/api/v1/cli/polka-export.mjs`)}`,
    "read -r -s POLKA_TOKEN && export POLKA_TOKEN",
    "node polka-export.mjs ./polka-export",
  ].join("\n");
  return (
    <section className="agent-move-shelf" id="move-shelf" aria-labelledby="move-shelf-title">
      <h2 id="move-shelf-title">Перенести полку</h2>
      <p>
        Заберите полку в свою установку Полки: все работы со всеми версиями и датами, папки, принятые версии, карточку
        полки и корзину. Ссылки и комментарии не переносятся — ссылки выпускаются заново на новом адресе.
      </p>
      <ol>
        <li>Создайте выше токен с разрешениями «Читать список» и «Читать исходники и шаблоны».</li>
        <li>Выполните команды (Node 22+). Повторный запуск продолжает с места и не скачивает файлы второй раз.</li>
      </ol>
      <div className="agent-instruction-block">
        <h4>Скачать полку в папку</h4>
        <pre>
          <code>{commands}</code>
        </pre>
        <CopyButton value={commands} label="Скопировать команды" successText="Команды скопированы" />
      </div>
      <p className="agent-help">
        На своей установке оператор сохраняет папку на полку командой{" "}
        <code>npm run shelf:import -- --dir ./polka-export --account &lt;почта&gt;</code>.
      </p>
    </section>
  );
}
