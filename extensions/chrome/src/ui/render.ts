/* Small DOM helpers shared by the popup and the options page. */

export type Result =
  | { ok: true; title: string; url: string | null; shelfUrl: string; note: string | null }
  | { ok: false; code: string; message: string }
  | null;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string)[]
) {
  const node: HTMLElementTagNameMap[K] = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** The outcome of a save: the link with «Копировать» and «Открыть на полке». */
export function renderResult(result: Result, onReconnect: () => void): Node[] {
  if (!result)
    return [el("p", { className: "error" }, "Расширение не ответило. Попробуйте ещё раз.")];
  if (!result.ok) {
    const nodes: Node[] = [el("p", { className: "error" }, result.message)];
    if (result.code === "not_connected") {
      const again = el("button", { type: "button", className: "secondary", textContent: "Подключить снова" });
      again.addEventListener("click", onReconnect);
      nodes.push(again);
    }
    return nodes;
  }
  const nodes: Node[] = [el("p", { className: "done" }, el("strong", {}, `«${result.title}» на полке`))];
  if (result.url) {
    const field = el("input", { readOnly: true, value: result.url, className: "link" });
    field.setAttribute("aria-label", "Ссылка на работу");
    field.addEventListener("focus", () => field.select());
    const copy = el("button", { type: "button", className: "primary", textContent: "Копировать" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(result.url!);
        copy.textContent = "Скопировано";
      } catch {
        field.select();
      }
    });
    nodes.push(field, copy);
  }
  if (result.note) nodes.push(el("p", { className: "muted" }, result.note));
  nodes.push(
    el("a", { href: result.shelfUrl, target: "_blank", rel: "noopener", className: "secondary" }, "Открыть на полке"),
  );
  return nodes;
}
