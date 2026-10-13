import React from "react";

/**
 * The first Tab stop on every page: past the navigation to the page's
 * <main>. Hidden until focused. Every page's main carries id="main", so the
 * link works without script too; the click handler also moves focus there.
 */
export function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#main"
      onClick={(event) => {
        const main = document.querySelector("main");
        if (!main) return;
        event.preventDefault();
        if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
        main.focus();
        main.scrollIntoView({ block: "start" });
      }}
    >
      Перейти к содержимому
    </a>
  );
}
