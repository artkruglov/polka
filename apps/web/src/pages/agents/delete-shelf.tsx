import React from "react";
import { useCapabilities } from "../../entities/capabilities/useCapabilities.ts";
import { DeleteAccount } from "../../features/account-deletion/index.tsx";

/**
 * «Удалить полку» in the settings: there is no self-service deletion yet, so
 * the owner writes to the operator's address (PRIVACY_CONTACT in
 * /api/capabilities: OPERATOR_CONTACT, else OPERATOR_EMAIL).
 */
export function DeleteShelf({
  contact,
  selfService = null,
}: {
  contact: string | null;
  /** Self-service deletion is on here: `purge` — a worker erases the data. */
  selfService?: { purge: boolean } | null;
}) {
  const subject = encodeURIComponent("Удалить полку");
  return (
    <section className="agent-delete-shelf" id="delete-shelf" aria-labelledby="delete-shelf-title">
      <h2 id="delete-shelf-title">Удалить полку</h2>
      {selfService ? (
        <>
          <p>
            Удалим полку и все данные: работы со всеми версиями, ссылки, подключения агентов и способы
            входа. Сначала покажем, что именно уйдёт и когда; ничего не удаляется, пока вы не подтвердите.
          </p>
          <div>
            <DeleteAccount purge={selfService.purge} />
          </div>
        </>
      ) : contact ? (
        <p>
          Напишите на{" "}
          <a href={`mailto:${contact}?subject=${subject}`}>{contact}</a> —
          удалим полку и все данные: работы со всеми версиями, ссылки,
          подключения агентов и способы входа. Пишите с адреса, которым входите,
          или укажите имя полки.
        </p>
      ) : (
        <p>
          Напишите оператору этой установки — он удалит полку и все данные:
          работы со всеми версиями, ссылки, подключения агентов и способы входа.
        </p>
      )}
      <p className="agent-help">
        Удаление нельзя отменить. Из резервных копий данные исчезают, когда
        копии истекут (до 30 дней).
      </p>
    </section>
  );
}

export function DeleteShelfSection() {
  const state = useCapabilities();
  return (
    <DeleteShelf
      contact={state.capabilities?.privacyContact ?? null}
      selfService={state.capabilities?.accountDeletion ?? null}
    />
  );
}
