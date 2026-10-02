import React from "react";
import { Check, FileText, Folder, FolderOpen, Link2, Lock, Minus, Plus } from "lucide-react";

/**
 * What the product does, drawn with the product's own words: an agent changes
 * the files of a work, a new version appears, the link opens without an
 * account. Decorative: the same things are said in text further down.
 */
export function LandingStage() {
  return (
    <div className="lp-stage" aria-hidden="true">
      <div className="lp-window">
        <div className="lp-window-bar">
          <span className="lp-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="lp-window-title">Исследование рынка</span>
          <span className="lp-chip lp-chip--accent">v3</span>
        </div>
        <div className="lp-window-body">
          <ul className="lp-tree">
            <li className="lp-tree-dir">
              <FolderOpen /> docs
            </li>
            <li className="lp-tree-file lp-tree-file--active">
              <FileText /> report.md
            </li>
            <li className="lp-tree-file lp-tree-file--added">
              <FileText /> risks.md <Plus className="lp-tree-mark" />
            </li>
            <li className="lp-tree-file lp-tree-file--removed">
              <FileText /> draft.md <Minus className="lp-tree-mark" />
            </li>
            <li className="lp-tree-dir lp-tree-dir--closed">
              <Folder /> data
            </li>
            <li className="lp-tree-file">
              <FileText /> README.md
            </li>
          </ul>
          <div className="lp-doc">
            <b>Рынок агентных инструментов</b>
            <p>Спрос растёт там, где результат нужно показать другим: отчёт, прототип, набор экранов.</p>
            <span className="lp-doc-line lp-doc-line--long" />
            <span className="lp-doc-line" />
            <span className="lp-doc-line lp-doc-line--short" />
            <div className="lp-doc-new">
              <b>Риски</b>
              <span className="lp-doc-line lp-doc-line--long" />
              <span className="lp-doc-line lp-doc-line--short" />
            </div>
          </div>
        </div>
        <ol className="lp-versions">
          <li>v1</li>
          <li className="lp-versions-ok">
            <Check /> v2 принята
          </li>
          <li className="lp-versions-now">v3</li>
        </ol>
      </div>
      <div className="lp-agent">
        <span className="lp-agent-who">Агент в чате</span>
        <p>Добавь раздел про риски и убери черновик.</p>
        <code>
          polka_change_files <em>put</em> docs/risks.md <em>remove</em> draft.md
        </code>
      </div>
      <div className="lp-link">
        <Lock />
        <span>
          <b>polochka.app/s#…</b>
          <small>откроется без аккаунта</small>
        </span>
        <Link2 />
      </div>
    </div>
  );
}
