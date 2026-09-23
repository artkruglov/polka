import React, { useState } from "react";
import { client } from "../../shared/api/client.ts";
import { Button, LinkButton } from "../../shared/ui/controls.tsx";
import { LegalLinks } from "../../widgets/navigation/index.tsx";
import "./styles.css";

/**
 * «Не присылать письма о комментариях» from a letter. The signed token is in
 * the fragment (never sent to a server log); opening the page changes
 * nothing, since mail scanners open links on their own: the button does.
 */
export function MailOff() {
  const [token] = useState(() => location.hash.slice(1));
  const [state, setState] = useState<"ask" | "busy" | "done" | "failed">(
    token ? "ask" : "failed",
  );
  const [message, setMessage] = useState(
    "Ссылка неполная. Письма можно отключить в панели комментариев любой работы на Полке.",
  );
  return (
    <>
      <main className="mail-off-page">
        <span className="eyebrow">Полка</span>
        {state === "done" ? (
          <>
            <h1>Письма о комментариях отключены</h1>
            <p>
              Включить их снова можно в панели комментариев любой работы на
              Полке. Письма входа приходят как прежде.
            </p>
            <LinkButton href="/">На Полку</LinkButton>
          </>
        ) : state === "failed" ? (
          <>
            <h1>Не получилось</h1>
            <p role="alert">{message}</p>
            <LinkButton href="/">На Полку</LinkButton>
          </>
        ) : (
          <>
            <h1>Не присылать письма о комментариях?</h1>
            <p>
              Полка перестанет писать о новых комментариях к вашим работам и об
              ответах в обсуждениях. Письма с кодом входа это не затронет.
            </p>
            <Button
              variant="primary"
              busy={state === "busy"}
              onClick={async () => {
                setState("busy");
                try {
                  await client.comments.mailOff(token);
                  setState("done");
                } catch (e) {
                  setMessage(e instanceof Error ? e.message : String(e));
                  setState("failed");
                }
              }}
            >
              Отключить письма
            </Button>
          </>
        )}
      </main>
      <LegalLinks />
    </>
  );
}
