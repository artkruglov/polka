// The comment overlay: a small script the viewer adds to a document only
// when the embedding shell asked for comments (viewer_grants.comments).
// Downloads and every other view stay byte-exact.
//
// It runs inside the sandboxed, opaque-origin frame and talks to Полка's
// page only by postMessage: it accepts messages only from `parent` with the
// expected APP_ORIGIN, and sends only to that origin. It highlights quoted
// fragments, reports where they are (for the rail beside the frame), reports
// the reader's selection, and nothing else: it never reads cookies (there
// are none in an opaque origin), never touches the network (connect-src
// 'none' binds it too), and never turns page text into markup.
//
// Highlights use the CSS Custom Highlight API: no element of the page is
// wrapped or split, so a React page keeps the DOM it owns. Overlapping
// quotes share segments, and a segment's shade grows with the number of
// quotes over it, up to three levels. Where the API is missing, positions
// and selection still work, without paint.
//
// The quote matching (ANCHOR_SOURCE) is plain JavaScript shared with the
// tests. The protocol is a subset of the one in just-html (MIT, © 2026
// Kernel Technologies, Inc., lib/docs/overlay.ts); this is a new, smaller
// implementation, not a copy.
//
// Page markup is hostile: `document.body`, `document.createTreeWalker` and
// `window.addEventListener` can be shadowed by named elements (<img
// name=body>), and a <form> can shadow its own methods. The script takes
// every DOM entry point from the prototypes before the page is parsed.
import { randomBytes } from "node:crypto";
import { VIEWER_GUARD, withLeadingMarkup } from "./html.ts";

/**
 * Finds a W3C text quote {exact, prefix, suffix} in the text of a document.
 * Returns [start, end) or null. The exact text first; among several
 * matches the one whose surroundings agree best with prefix and suffix; a
 * tie is refused (null) rather than guessed. Without an exact match the
 * quote is looked for with whitespace runs collapsed. Not found or
 * ambiguous: the comment becomes a comment on the whole work.
 */
export const ANCHOR_SOURCE = String.raw`
function polkaSquash(s) { return String(s || "").replace(/\s+/g, " "); }
function polkaCommonSuffix(a, b) {
  var n = Math.min(a.length, b.length), i = 0;
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}
function polkaCommonPrefix(a, b) {
  var n = Math.min(a.length, b.length), i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
function polkaFindQuote(full, quote) {
  var exact = String(quote && quote.exact || "");
  if (!exact) return null;
  var found = [], from = 0, at;
  while ((at = full.indexOf(exact, from)) !== -1) {
    found.push(at); from = at + 1;
    if (found.length > 1000) break;
  }
  if (found.length === 0) {
    // Whitespace may differ between the quote and the text (line breaks of a
    // selection, reflowed source): match with runs collapsed, map back.
    var squashed = polkaSquash(exact).trim();
    if (!squashed) return null;
    var map = [], text = "", space = false;
    for (var i = 0; i < full.length; i++) {
      var ws = /\s/.test(full[i]);
      if (ws && space) continue;
      map.push(i); text += ws ? " " : full[i]; space = ws;
    }
    var first = text.indexOf(squashed);
    if (first === -1 || text.indexOf(squashed, first + 1) !== -1) return null;
    var last = first + squashed.length - 1;
    return [map[first], map[last] + 1];
  }
  if (found.length === 1) return [found[0], found[0] + exact.length];
  var prefix = polkaSquash(quote.prefix), suffix = polkaSquash(quote.suffix);
  var best = -1, pick = -1, tie = false;
  for (var k = 0; k < found.length; k++) {
    var start = found[k];
    var before = polkaSquash(full.slice(Math.max(0, start - 96), start));
    var after = polkaSquash(full.slice(start + exact.length, start + exact.length + 96));
    var score = (prefix ? polkaCommonSuffix(before, prefix) : 0) +
      (suffix ? polkaCommonPrefix(after, suffix) : 0);
    if (score > best) { best = score; pick = start; tie = false; }
    else if (score === best) tie = true;
  }
  if (tie || best <= 0) return null;
  return [pick, pick + exact.length];
}
`;

const OVERLAY_SOURCE = String.raw`
(function (APP_ORIGIN, MODE) {
  "use strict";
  var W = window, D = document;
  var DocP = Document.prototype, NodeP = Node.prototype;
  var getter = function (proto, name) { return Object.getOwnPropertyDescriptor(proto, name).get; };
  var bodyOf = getter(DocP, "body"), rootOf = getter(DocP, "documentElement");
  var readyStateOf = getter(DocP, "readyState");
  var createTreeWalker = DocP.createTreeWalker, createRange = DocP.createRange;
  var createElement = DocP.createElement, querySelectorAll = DocP.querySelectorAll;
  var caretRangeFromPoint = DocP.caretRangeFromPoint, caretPositionFromPoint = DocP.caretPositionFromPoint;
  var listen = EventTarget.prototype.addEventListener;
  var appendChild = NodeP.appendChild, insertBefore = NodeP.insertBefore, removeChild = NodeP.removeChild;
  var parentOf = getter(NodeP, "parentNode"), childNodesOf = getter(NodeP, "childNodes");
  var nodeNameOf = getter(NodeP, "nodeName"), nodeTypeOf = getter(NodeP, "nodeType");
  var textOf = getter(NodeP, "textContent");
  var createFragment = DocP.createDocumentFragment, adoptNode = DocP.adoptNode;
  var setText = Object.getOwnPropertyDescriptor(NodeP, "textContent").set;
  var getSelection = W.getSelection, parentWindow = W.parent;
  var highlights = W.CSS && W.CSS.highlights, HighlightCtor = W.Highlight;
  var MAX_ANCHORS = 500, MAX_EXACT = 2000, CONTEXT = 32;

  var anchors = [];      // [{id, exact, prefix, suffix}] from the shell
  var resolved = {};     // id -> [start, end)
  var active = null;
  var model = null;      // {nodes:[{node,start,end}], full}
  var dirty = true;

  function send(message) {
    // The parent's own postMessage, to Полка's origin only.
    try { parentWindow.postMessage(message, APP_ORIGIN); } catch (e) {}
  }
  function text(value, max) {
    return typeof value === "string" ? value.slice(0, max) : "";
  }

  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1, TITLE: 1 };
  function buildModel() {
    var body = bodyOf.call(D);
    var nodes = [], full = "";
    if (body) {
      var walker = createTreeWalker.call(D, body, 4 /* SHOW_TEXT */);
      var node;
      while ((node = walker.nextNode())) {
        var parent = parentOf.call(node);
        if (parent && SKIP[nodeNameOf.call(parent)]) continue;
        var value = node.nodeValue || "";
        if (!value) continue;
        nodes.push({ node: node, start: full.length, end: full.length + value.length });
        full += value;
        if (full.length > 4000000) break;
      }
    }
    model = { nodes: nodes, full: full };
    dirty = false;
    return model;
  }
  function current() { return dirty || !model ? buildModel() : model; }

  // The text node holding an offset: a start lies in [start, end) of its
  // node, an end in (start, end], so a range never begins or ends on the
  // wrong side of a node boundary.
  function locate(offset, isEnd) {
    var nodes = current().nodes, lo = 0, hi = nodes.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, item = nodes[mid];
      if (isEnd ? offset <= item.start : offset < item.start) hi = mid - 1;
      else if (isEnd ? offset > item.end : offset >= item.end) lo = mid + 1;
      else return { node: item.node, offset: offset - item.start };
    }
    return null;
  }
  function rangeOf(start, end) {
    var a = locate(start, false), b = locate(end, true);
    if (!a || !b) return null;
    try {
      var range = createRange.call(D);
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      return range;
    } catch (e) { return null; }
  }
  // A selection boundary (node, offset) as an offset into the text model.
  function offsetOf(container, offset, isEnd) {
    var nodes = current().nodes;
    if (nodeTypeOf.call(container) === 3) {
      for (var i = 0; i < nodes.length; i++)
        if (nodes[i].node === container) return nodes[i].start + Math.min(offset, nodes[i].end - nodes[i].start);
    }
    // An element boundary: the first text node at or after it.
    var probe = createRange.call(D);
    try { probe.setStart(container, offset); } catch (e) { return isEnd ? current().full.length : 0; }
    for (var j = 0; j < nodes.length; j++) {
      var here = createRange.call(D);
      here.selectNodeContents(nodes[j].node);
      if (probe.compareBoundaryPoints(Range.START_TO_START, here) <= 0) return nodes[j].start;
    }
    return current().full.length;
  }

  var STYLE = "::highlight(polka-d1){background-color:rgba(255,213,79,.38)}" +
    "::highlight(polka-d2){background-color:rgba(255,193,7,.52)}" +
    "::highlight(polka-d3){background-color:rgba(255,160,0,.66)}" +
    "::highlight(polka-active){background-color:rgba(255,145,0,.8)}";
  var styled = false;
  function ensureStyle() {
    if (styled) return;
    var root = rootOf.call(D);
    if (!root) return;
    var style = createElement.call(D, "style");
    setText.call(style, STYLE);
    appendChild.call(root, style);
    styled = true;
  }

  function paint() {
    var full = current().full;
    resolved = {};
    var missing = [], bounds = {};
    for (var i = 0; i < anchors.length; i++) {
      var hit = polkaFindQuote(full, anchors[i]);
      if (!hit) { missing.push(anchors[i].id); continue; }
      resolved[anchors[i].id] = hit;
      bounds[hit[0]] = 1; bounds[hit[1]] = 1;
    }
    send({ type: "polka:resolved", missing: missing });
    if (!highlights || !HighlightCtor) return positions();
    ensureStyle();
    var points = Object.keys(bounds).map(Number).sort(function (x, y) { return x - y; });
    var layers = [[], [], []], ids = Object.keys(resolved);
    for (var p = 0; p + 1 < points.length; p++) {
      var s = points[p], e = points[p + 1], depth = 0;
      for (var k = 0; k < ids.length; k++) {
        var r = resolved[ids[k]];
        if (r[0] <= s && r[1] >= e) depth++;
      }
      if (!depth) continue;
      var range = rangeOf(s, e);
      if (range) layers[Math.min(depth, 3) - 1].push(range);
    }
    for (var l = 0; l < 3; l++) highlights.set("polka-d" + (l + 1), new HighlightCtor(...layers[l]));
    var focus = active && resolved[active] ? rangeOf(resolved[active][0], resolved[active][1]) : null;
    if (focus) {
      var h = new HighlightCtor(focus);
      h.priority = 1;
      highlights.set("polka-active", h);
    } else highlights.delete("polka-active");
    positions();
  }

  var scheduled = false;
  function positions() {
    if (scheduled) return;
    scheduled = true;
    W.requestAnimationFrame(function () {
      scheduled = false;
      var out = {}, y = W.scrollY;
      for (var id in resolved) {
        var range = rangeOf(resolved[id][0], resolved[id][1]);
        if (!range) continue;
        var rect = range.getBoundingClientRect();
        out[id] = Math.round(rect.top + y);
      }
      var root = rootOf.call(D);
      send({
        type: "polka:positions", positions: out, scrollY: Math.round(y),
        viewport: W.innerHeight, height: root ? root.scrollHeight : 0
      });
    });
  }

  function selection() {
    var sel = getSelection.call(W);
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return send({ type: "polka:selectionCleared" });
    var range = sel.getRangeAt(0);
    var full = current().full;
    var start = offsetOf(range.startContainer, range.startOffset, false);
    var end = offsetOf(range.endContainer, range.endOffset, true);
    while (start < end && /\s/.test(full[start])) start++;
    while (end > start && /\s/.test(full[end - 1])) end--;
    if (end <= start) return send({ type: "polka:selectionCleared" });
    var rect = range.getBoundingClientRect();
    var box = { top: Math.round(rect.top), left: Math.round(rect.left), bottom: Math.round(rect.bottom), right: Math.round(rect.right) };
    if (end - start > MAX_EXACT) return send({ type: "polka:selection", tooLong: true, rect: box });
    send({
      type: "polka:selection",
      anchor: {
        exact: full.slice(start, end),
        prefix: full.slice(Math.max(0, start - CONTEXT), start),
        suffix: full.slice(end, end + CONTEXT)
      },
      rect: box
    });
  }

  function focusAt(x, y) {
    var sel = getSelection.call(W);
    if (sel && !sel.isCollapsed) return;
    var node = null, offset = 0;
    if (caretPositionFromPoint) {
      var pos = caretPositionFromPoint.call(D, x, y);
      if (pos) { node = pos.offsetNode; offset = pos.offset; }
    } else if (caretRangeFromPoint) {
      var r = caretRangeFromPoint.call(D, x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node || nodeTypeOf.call(node) !== 3) return;
    var at = offsetOf(node, offset, false), best = null, size = Infinity;
    for (var id in resolved) {
      var hit = resolved[id];
      if (hit[0] <= at && at < hit[1] && hit[1] - hit[0] < size) { best = id; size = hit[1] - hit[0]; }
    }
    if (best) send({ type: "polka:focus", id: best });
  }

  function scrollTo(id) {
    var hit = resolved[id];
    if (!hit) return;
    var range = rangeOf(hit[0], hit[1]);
    if (!range) return;
    var rect = range.getBoundingClientRect();
    W.scrollTo({ top: Math.max(0, rect.top + W.scrollY - W.innerHeight / 3), behavior: "smooth" });
  }

  // Only the shell, from Полка's origin; anything else is ignored.
  listen.call(W, "message", function (event) {
    if (!event.isTrusted || event.source !== parentWindow || event.origin !== APP_ORIGIN) return;
    var data = event.data;
    if (!data || typeof data !== "object" || typeof data.type !== "string") return;
    if (data.type === "polka:anchors" && Array.isArray(data.anchors)) {
      anchors = [];
      for (var i = 0; i < data.anchors.length && anchors.length < MAX_ANCHORS; i++) {
        var a = data.anchors[i];
        if (!a || typeof a.id !== "string" || typeof a.exact !== "string" || !a.exact) continue;
        anchors.push({ id: text(a.id, 100), exact: text(a.exact, MAX_EXACT), prefix: text(a.prefix, 64), suffix: text(a.suffix, 64) });
      }
      paint();
    } else if (data.type === "polka:active") {
      active = typeof data.id === "string" ? data.id : null;
      paint();
    } else if (data.type === "polka:scrollTo" && typeof data.id === "string") {
      scrollTo(data.id);
    } else if (data.type === "polka:clearSelection") {
      var sel = getSelection.call(W);
      if (sel) sel.removeAllRanges();
    }
  });

  // A static page is shown with scripting on (for this script only), which
  // hides <noscript>; show its markup as the scriptless view did. The
  // markup was already rewritten by the view (external links), and nothing
  // in it can run: the CSP admits only this script.
  function restoreNoscript() {
    if (MODE !== "static") return;
    var list = querySelectorAll.call(D, "noscript");
    for (var i = 0; i < list.length; i++) {
      var element = list[i], parent = parentOf.call(element);
      if (!parent) continue;
      var parsed = new DOMParser().parseFromString(textOf.call(element) || "", "text/html");
      var fragment = createFragment.call(D);
      var from = [parsed.head, parsed.body];
      for (var f = 0; f < from.length; f++) {
        if (!from[f]) continue;
        var children = childNodesOf.call(from[f]);
        while (children.length) appendChild.call(fragment, adoptNode.call(D, children[0]));
      }
      insertBefore.call(parent, fragment, element);
      removeChild.call(parent, element);
    }
  }

  var selectionTimer = 0;
  function start() {
    restoreNoscript();
    dirty = true;
    send({ type: "polka:ready" });
    listen.call(D, "selectionchange", function () {
      W.clearTimeout(selectionTimer);
      selectionTimer = W.setTimeout(selection, 180);
    });
    // A pointer click only: keyboard activation of a control has no position.
    listen.call(D, "click", function (event) { if (event.detail > 0) focusAt(event.clientX, event.clientY); }, true);
    listen.call(W, "scroll", positions, { passive: true });
    listen.call(W, "resize", function () { positions(); });
    listen.call(W, "load", function () { dirty = true; paint(); });
    var body = bodyOf.call(D);
    if (body && W.MutationObserver) {
      var timer = 0;
      new W.MutationObserver(function () {
        dirty = true;
        W.clearTimeout(timer);
        timer = W.setTimeout(paint, 250);
      }).observe(body, { childList: true, subtree: true, characterData: true });
    }
  }
  if (readyStateOf.call(D) === "loading") listen.call(D, "DOMContentLoaded", start);
  else start();
})`;

const json = (value: unknown) =>
  // A string inside a <script>: nothing in it may close the element.
  JSON.stringify(value).replace(/</g, "\\u003c");

/** The overlay for one document: `mode` is how the viewer shows it. */
export function overlayScript(appOrigin: string, mode: "static" | "live") {
  return `(function(){${ANCHOR_SOURCE}${OVERLAY_SOURCE}(${json(appOrigin)},${json(mode)});})();`;
}

/**
 * The scripts go before any page markup; nothing in them may end the
 * element or enter the script-data escape states.
 */
function assertPlainScript(source: string) {
  if (/<\/script|<!--|<script/i.test(source))
    throw new Error("Overlay source must not contain script markup");
}
assertPlainScript(overlayScript("https://polka.invalid", "live"));

/** A fresh CSP nonce for one static response. */
export const overlayNonce = () => randomBytes(18).toString("base64url");

/**
 * The interactive view with comments: the WebRTC guard first, as always,
 * then the overlay, then the page (whose scripts run after both).
 */
export function withLiveOverlay(html: Buffer, appOrigin: string) {
  return withLeadingMarkup(
    html,
    Buffer.from(
      `${VIEWER_GUARD}<script>${overlayScript(appOrigin, "live")}</script>`,
    ),
  );
}

/**
 * The static view with comments: the only scripts of the response carry
 * its nonce, and they are the WebRTC guard and the overlay. The CSP from
 * staticHtmlCsp(…, nonce) admits nothing else.
 */
export function withStaticOverlay(
  html: Buffer,
  appOrigin: string,
  nonce: string,
) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new Error("Invalid nonce");
  assertPlainScript(overlayScript(appOrigin, "static"));
  const open = `<script nonce="${nonce}">`;
  return withLeadingMarkup(
    html,
    Buffer.from(
      VIEWER_GUARD.replace("<script>", open) +
        `${open}${overlayScript(appOrigin, "static")}</script>`,
    ),
  );
}
