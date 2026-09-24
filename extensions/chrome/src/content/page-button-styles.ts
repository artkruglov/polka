/** Styles of the page button, inside its shadow root (no leaks either way). */
export const STYLES = `
:host { all: initial; font: 500 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color-scheme: light dark; }
.wrap { position: relative; display: inline-block; }
.save { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: 1px solid #c9d2e0; border-radius: 8px; background: #fff; color: #1d3f8a; font: inherit; cursor: pointer; white-space: nowrap; }
.save::before { content: ""; width: 14px; height: 10px; border-bottom: 2px solid currentColor; border-top: 2px solid currentColor; box-sizing: border-box; }
.save:hover { background: #eef3fb; }
.save:focus-visible, button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid #3563c9; outline-offset: 2px; }
.save:disabled { opacity: .7; cursor: progress; }
.card { position: absolute; right: 0; top: calc(100% + 8px); z-index: 2147483647; display: grid; gap: 8px; width: 300px; padding: 14px 14px 12px; border: 1px solid #d5dbe6; border-radius: 12px; background: #fff; color: #1b1f24; box-shadow: 0 10px 30px rgba(20, 30, 50, .18); font-weight: 400; line-height: 1.45; }
.card[hidden] { display: none; }
.card p { margin: 0; color: #4a5260; }
.card .error { color: #8f2a20; }
.card strong { padding-right: 20px; font-weight: 600; overflow-wrap: anywhere; }
.link { width: 100%; box-sizing: border-box; height: 32px; padding: 0 8px; border: 1px solid #c9d2e0; border-radius: 6px; font: 12px ui-monospace, monospace; color: inherit; background: #f6f8fb; }
.primary, .secondary { display: inline-flex; justify-content: center; align-items: center; height: 32px; padding: 0 12px; border-radius: 8px; font: 500 13px system-ui, sans-serif; text-decoration: none; cursor: pointer; }
.primary { border: 0; background: #2f5bd3; color: #fff; }
.secondary { border: 1px solid #c9d2e0; background: #fff; color: #1d3f8a; }
.close { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; border: 0; border-radius: 6px; background: transparent; color: #6a7280; font-size: 18px; line-height: 1; cursor: pointer; }
@media (prefers-color-scheme: dark) {
  .save, .secondary { background: #1f2430; border-color: #3a4252; color: #b9ccff; }
  .save:hover { background: #283042; }
  .card { background: #1a1e27; border-color: #353c4a; color: #e8ebf1; }
  .card p { color: #b4bac6; }
  .card .error { color: #ff9b8f; }
  .link { background: #11151c; border-color: #3a4252; }
}
`;
