import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FileCode2, FileText, Folder, Image, ListTree } from "lucide-react";
import type { Revision } from "../../../../../packages/contracts/index.ts";
import { projectView } from "../../shared/api/client.ts";
import { StatusPanel } from "../../shared/ui/controls.tsx";

// A project (docs/specs/PROJECTS.md): one work of many linked pages. The
// tree lists what a reader opens — documents, pages, pictures — and keeps
// stylesheets, scripts and fonts under «Файлы проекта». The frame is the
// project viewer; nav.js inside it says which page is open, so the tree and
// the address follow links the reader clicks there.

type ProjectFile = { path: string; mime: string };
type Node = { name: string; path: string; file?: ProjectFile; children: Map<string, Node> };

const READABLE = (mime: string) =>
  mime === "text/markdown" || mime === "text/html" || mime === "text/plain" || mime.startsWith("image/");
const ENTRY_NAMES = ["README.md", "index.md", "index.html"];

function buildTree(files: ProjectFile[]) {
  const root: Node = { name: "", path: "", children: new Map() };
  for (const file of files) {
    let node = root;
    const parts = file.path.split("/");
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      if (!node.children.has(part)) node.children.set(part, { name: part, path, children: new Map() });
      node = node.children.get(part)!;
    });
    node.file = file;
  }
  return root;
}

/** README and index first, then folders, then files; by name within each. */
const ordered = (node: Node) =>
  [...node.children.values()].sort((a, b) => {
    const rank = (n: Node) => (n.file && ENTRY_NAMES.includes(n.name) ? 0 : n.file ? 2 : 1);
    return rank(a) - rank(b) || a.name.localeCompare(b.name, "ru", { numeric: true });
  });

const iconOf = (mime: string) =>
  mime.startsWith("image/") ? <Image aria-hidden="true" /> : mime === "text/markdown" || mime === "text/plain" ? <FileText aria-hidden="true" /> : <FileCode2 aria-hidden="true" />;

const pathFromHash = () => {
  const match = /(?:^#|&)path=([^&]*)/.exec(location.hash);
  return match ? decodeURIComponent(match[1]!) : "";
};

function TreeBranch({
  node,
  current,
  open,
  toggle,
  choose,
  depth = 0,
}: {
  node: Node;
  current: string;
  open: Set<string>;
  toggle: (path: string) => void;
  choose: (path: string) => void;
  depth?: number;
}) {
  return (
    <ul className="project-tree-list" role={depth ? "group" : "tree"}>
      {ordered(node).map((child) =>
        child.file ? (
          <li key={child.path} role="none">
            <button
              type="button"
              role="treeitem"
              aria-current={child.path === current ? "page" : undefined}
              className="project-tree-item"
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => choose(child.path)}
            >
              {iconOf(child.file.mime)}
              <span>{child.name}</span>
            </button>
          </li>
        ) : (
          <li key={child.path} role="none">
            <button
              type="button"
              role="treeitem"
              aria-expanded={open.has(child.path)}
              className="project-tree-item project-tree-folder"
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => toggle(child.path)}
            >
              <ChevronRight aria-hidden="true" className="project-tree-chevron" />
              <Folder aria-hidden="true" />
              <span>{child.name}</span>
            </button>
            {open.has(child.path) && (
              <TreeBranch node={child} current={current} open={open} toggle={toggle} choose={choose} depth={depth + 1} />
            )}
          </li>
        ),
      )}
    </ul>
  );
}

export function ProjectView({ revision, grant }: { revision: Revision; grant?: string }) {
  const manifest = revision.manifest!;
  const files = manifest.files as ProjectFile[];
  const readable = useMemo(() => buildTree(files.filter((file) => READABLE(file.mime))), [revision.id]);
  const resources = useMemo(() => files.filter((file) => !READABLE(file.mime)), [revision.id]);
  const paths = useMemo(() => new Set(files.map((file) => file.path)), [revision.id]);
  // A recipient's address holds the link's token, so only the owner's keeps the page.
  const [current, setCurrent] = useState(() => {
    const wanted = grant ? "" : pathFromHash();
    return paths.has(wanted) ? wanted : manifest.entrypoint;
  });
  const [open, setOpen] = useState(() => {
    const folders = new Set<string>();
    for (const child of readable.children.values()) if (!child.file) folders.add(child.path);
    return folders;
  });
  const [view, setView] = useState<{ url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  // The page the frame was sent to; the frame then moves on by itself.
  const [framePath, setFramePath] = useState(current);
  const frame = useRef<HTMLIFrameElement>(null);

  const issue = useCallback(
    (signal?: AbortSignal) =>
      projectView(revision.id, grant, signal)
        .then((next) => {
          if (!signal?.aborted) setView(next);
        })
        .catch((e) => {
          if (!signal?.aborted) setError(e.message);
        }),
    [revision.id, grant],
  );
  useEffect(() => {
    const abort = new AbortController();
    setView(null);
    setError("");
    issue(abort.signal);
    return () => abort.abort();
  }, [issue]);
  // Renew the view a minute before it ends, on the page the reader is on.
  useEffect(() => {
    if (!view) return;
    const wait = Math.max(5_000, new Date(view.expiresAt).getTime() - Date.now() - 60_000);
    const timer = setTimeout(() => {
      setFramePath(current);
      issue();
    }, wait);
    return () => clearTimeout(timer);
  }, [view, current, issue]);

  const reveal = (path: string) =>
    setOpen((was) => {
      const next = new Set(was);
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"));
      return next;
    });
  useEffect(() => {
    reveal(current);
    if (!grant) history.replaceState(null, "", `#path=${encodeURIComponent(current)}`);
  }, [current, grant]);

  // Messages from the frame are hints from an untrusted page: a path of this
  // project to highlight, or a signed /away link to open in a new tab.
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const data = event.data as { type?: unknown; path?: unknown; href?: unknown };
      if (data?.type === "polka-project-page" && typeof data.path === "string") {
        const path = data.path.replace(/\/+$/, "") || manifest.entrypoint;
        if (paths.has(path)) setCurrent(path);
      } else if (
        data?.type === "polka-project-away" &&
        typeof data.href === "string" &&
        data.href.startsWith(`${location.origin}/away#`)
      )
        window.open(data.href, "_blank", "noopener,noreferrer");
    };
    addEventListener("message", listen);
    return () => removeEventListener("message", listen);
  }, [paths]);

  const choose = (path: string) => {
    setCurrent(path);
    setFramePath(path);
    setNavOpen(false);
  };
  const toggle = (path: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (error)
    return <StatusPanel title="Проект не открылся">{error}</StatusPanel>;
  const crumbs = current.split("/");
  const src = view ? view.url + framePath.split("/").map(encodeURIComponent).join("/") : "";
  return (
    <div className={`project-view${navOpen ? " project-view--nav" : ""}`}>
      <nav className="project-tree" aria-label="Содержание проекта">
        <p className="project-tree-summary">
          Проект · {files.length} файлов
        </p>
        <TreeBranch node={readable} current={current} open={open} toggle={toggle} choose={choose} />
        {resources.length > 0 && (
          <details className="project-tree-resources">
            <summary>Файлы проекта · {resources.length}</summary>
            <ul>
              {resources.map((file) => (
                <li key={file.path}>{file.path}</li>
              ))}
            </ul>
          </details>
        )}
      </nav>
      <section className="project-page" aria-label="Страница проекта">
        <header className="project-page-bar">
          <button type="button" className="project-toc-button" onClick={() => setNavOpen((was) => !was)}>
            <ListTree aria-hidden="true" /> Содержание
          </button>
          <ol className="project-crumbs" aria-label="Где вы в проекте">
            {crumbs.map((part, index) => (
              <li key={index} aria-current={index === crumbs.length - 1 ? "page" : undefined}>
                {part}
              </li>
            ))}
          </ol>
        </header>
        {view ? (
          <iframe
            ref={frame}
            key={view.url}
            className="project-frame"
            title={`Проект: ${current}`}
            src={src}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="placeholder project-frame" aria-label="Открываем проект…" />
        )}
      </section>
    </div>
  );
}
