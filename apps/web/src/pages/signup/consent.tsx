import React from "react";

/**
 * Shown under the email form: the first sign-in by code creates a shelf and
 * accepts the terms. The policy is only acknowledged: processing rests on the
 * agreement (152-FZ art. 6 p. 1 item 5), not on a consent, and a consent would
 * have to be a separate document anyway.
 */
export function SignupConsent() {
  return (
    <p className="onboard-fine onboard-consent">
      Продолжая, вы принимаете <a href="/terms">Соглашение</a> и подтверждаете,
      что прочитали{" "}
      <a href="/privacy">Политику обработки данных</a>.
    </p>
  );
}
