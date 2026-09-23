import React from "react";

/** Shown under the email form: the first sign-in by code creates a shelf. */
export function SignupConsent() {
  return (
    <p className="onboard-fine onboard-consent">
      Продолжая, вы принимаете <a href="/terms">Соглашение</a> и{" "}
      <a href="/privacy">Политику обработки данных</a>.
    </p>
  );
}
