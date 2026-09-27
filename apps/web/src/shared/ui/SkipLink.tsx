import React from "react";

/**
 * The first Tab stop on every page: past the navigation to the page's
 * <main>. Hidden until focused. Pages name their main differently, so the
 * link finds the element instead of relying on an id.
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
