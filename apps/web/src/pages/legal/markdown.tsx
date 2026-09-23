import React from "react";

/**
 * The small Markdown subset the legal texts in docs/legal use: headings,
 * paragraphs, "- " lists, one "> " note, **bold**, `code`, links between the
 * two texts and [PLACEHOLDERS] the operator still has to fill. Everything is
 * rendered as React text, never as HTML.
 */
const LOCAL_LINKS: Record<string, string> = {
  "privacy.md": "/privacy",
  "terms.md": "/terms",
};

const INLINE =
  /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\[([^\]]+)\]/g;

function inline(text: string, key = ""): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const id = `${key}${at}`;
    const [, bold, code, label, href, placeholder] = match;
    if (bold !== undefined)
      out.push(<strong key={id}>{inline(bold, `${id}-`)}</strong>);
    else if (code !== undefined) out.push(<code key={id}>{code}</code>);
    else if (label !== undefined) {
      const target =
        LOCAL_LINKS[href] ?? (/^https:\/\//.test(href) ? href : null);
      out.push(
        target ? (
          <a key={id} href={target}>
            {inline(label, `${id}-`)}
          </a>
        ) : (
          label
        ),
      );
    } else
      out.push(
        <mark key={id} className="legal-placeholder">
          [{placeholder}]
        </mark>,
      );
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;
    if (!line.trim()) {
      i++;
    } else if (/^#{1,3} /.test(line)) {
      const level = line.indexOf(" ");
      const Tag = `h${level}` as "h1" | "h2" | "h3";
      blocks.push(<Tag key={key}>{inline(line.slice(level + 1).trim())}</Tag>);
      i++;
    } else if (line.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith("- "))
        items.push(lines[i++].slice(2));
      blocks.push(
        <ul key={key}>
          {items.map((item, n) => (
            <li key={n}>{inline(item)}</li>
          ))}
        </ul>,
      );
    } else if (line.startsWith("> ")) {
      const text: string[] = [];
      while (i < lines.length && lines[i].startsWith("> "))
        text.push(lines[i++].slice(2));
      blocks.push(
        <aside key={key} className="legal-note" role="note">
          {inline(text.join(" "))}
        </aside>,
      );
    } else if (/^\*\*[^*]+\*\*$/.test(line.trim())) {
      // A line that is only bold text heads a group of items.
      blocks.push(<h3 key={key}>{line.trim().slice(2, -2)}</h3>);
      i++;
    } else {
      const text: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,3} |- |> )/.test(lines[i])
      )
        text.push(lines[i++]);
      blocks.push(<p key={key}>{inline(text.join(" "))}</p>);
    }
  }
  return <>{blocks}</>;
}
