import { parse } from "parse5";
import type { CoverGenre, CoverKind } from "../../packages/contracts/cover.ts";

/*
 * What a shelf card shows for a saved version (docs/specs/SHELF_COVERS.md):
 * a text cover (heading and lead set large) or a picture of the first screen.
 * The decision is a heuristic over one walk of the document. It never decides
 * anything about safety; the worst a wrong guess does is a less telling card.
 *
 * Bump COVER_VERSION whenever the result for the same bytes would change:
 * stored covers of an older version are recomputed when a card asks for them.
 */
export const COVER_VERSION = 1;

/** Only the start of a very large page is read: the first screen is what the card shows. */
export const COVER_READ_BYTES = 1024 * 1024;
const MAX_HEADING = 140;
const MAX_LEAD = 240;
const MAX_CSS = 256 * 1024;

export type CoverSignals = {
  /** Visible characters of text. */
  text: number;
  headings: number;
  /** Paragraph-like blocks of at least 40 characters. */
  paragraphs: number;
  tables: number;
  canvas: number;
  /** SVG drawings larger than an icon. */
  svg: number;
  images: number;
  video: number;
  /** Inputs, buttons, selects. */
  controls: number;
  /** A charting, mapping or 3D library, by script address or call. */
  charts: boolean;
  scripted: boolean;
  /** The page's content is drawn by its script: almost no text in the markup. */
  shell: boolean;
};

export type CoverFacts = {
  kind: CoverKind;
  genre: CoverGenre;
  heading: string | null;
  lead: string | null;
  accent: string | null;
  signals: CoverSignals;
};

type Node = {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
};

const SKIPPED = new Set(["script", "style", "template", "noscript", "head", "svg", "math"]);
const PARAGRAPHS = new Set(["p", "blockquote", "li", "dd", "figcaption"]);
const CONTROLS = new Set(["input", "button", "select", "textarea"]);
const CHART_LIBRARY =
  /chart(?:\.umd)?(?:\.min)?\.js|chartjs|echarts|highcharts|plotly|apexcharts|recharts|\bd3(?:\.v\d)?(?:\.min)?\.js|\/d3@|vega(?:-lite)?|amcharts|google\.visualization|leaflet|mapbox|three(?:\.module)?(?:\.min)?\.js|\/three@/i;
const CHART_CALL =
  /new\s+Chart\s*\(|echarts\.init|Plotly\.(?:newPlot|react)|d3\.select|Highcharts\.chart|new\s+ApexCharts|getContext\(\s*["']2d|getContext\(\s*["']webgl|new\s+THREE\.|L\.map\s*\(|<(?:LineChart|BarChart|AreaChart|PieChart|ResponsiveContainer)\b/;

/** Collapses whitespace and cuts at a word boundary. */
export function clip(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:—–-]+$/, "")}…`;
}

const attr = (node: Node, name: string) =>
  node.attrs?.find((item) => item.name.toLowerCase() === name)?.value;

const size = (value: string | undefined) => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/.exec(value ?? "");
  return match ? Number(match[1]) : null;
};

/** The text of a subtree, bounded; hidden parts (script, style) are skipped. */
function textOf(node: Node, limit = 600) {
  const parts: string[] = [];
  let length = 0;
  const stack: Node[] = [node];
  while (stack.length && length < limit) {
    const current = stack.pop()!;
    if (current.nodeName === "#text") {
      parts.push(current.value ?? "");
      length += (current.value ?? "").length;
      continue;
    }
    const tag = current.tagName?.toLowerCase();
    if (tag && current !== node && SKIPPED.has(tag)) continue;
    // Block children read as separate words.
    if (tag === "br" || tag === "div" || tag === "p" || tag === "li") parts.push(" ");
    const children = current.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** An SVG larger than an icon: a chart, a diagram, an illustration. */
function drawing(node: Node) {
  const width = size(attr(node, "width"));
  const height = size(attr(node, "height"));
  if ((width !== null && width >= 80) || (height !== null && height >= 80)) return true;
  const box = (attr(node, "viewbox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box[2]! >= 120 && box[3]! >= 80 && (width === null || width >= 80)) return true;
  let elements = 0;
  const stack: Node[] = [...(node.childNodes ?? [])];
  while (stack.length && elements < 40) {
    const current = stack.pop()!;
    if (current.tagName) elements++;
    stack.push(...(current.childNodes ?? []));
  }
  return elements >= 24;
}

// Colours the page is written in: #rgb, #rrggbb and rgb() in its CSS.
const COLOUR = /#([0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi;

function hsl(r: number, g: number, b: number) {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb),
    min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s, l };
}

/**
 * The dominant saturated colour of the CSS: greys, near-white and near-black
 * are not accents. Colours are grouped by hue; the most used group wins and
 * its most used colour is the accent.
 */
export function accentOf(css: string): string | null {
  const counts = new Map<string, number>();
  const bins = new Map<number, number>();
  for (const match of css.slice(0, MAX_CSS).matchAll(COLOUR)) {
    let r: number, g: number, b: number;
    if (match[1]) {
      const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
      [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    } else [r, g, b] = [Number(match[2]), Number(match[3]), Number(match[4])];
    if (r > 255 || g > 255 || b > 255) continue;
    const { h, s, l } = hsl(r, g, b);
    if (s < 0.3 || l < 0.18 || l > 0.85) continue;
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
    const bin = Math.round(h / 30) % 12;
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  if (!bins.size) return null;
  const [bin] = [...bins].sort((a, b) => b[1] - a[1])[0]!;
  const inBin = [...counts].filter(([hex]) => {
    const n = parseInt(hex.slice(1), 16);
    return Math.round(hsl(n >> 16, (n >> 8) & 255, n & 255).h / 30) % 12 === bin;
  });
  return inBin.sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * Text or picture. Text wins with length, headings, paragraphs and tables;
 * a picture with canvases, drawings, chart libraries, images, controls, and
 * above all with a page whose markup holds almost no text (its script draws
 * everything). A long report with a chart or two stays a text cover.
 */
export function decideKind(s: CoverSignals): { kind: CoverKind; genre: CoverGenre } {
  const visual =
    Math.min(s.canvas, 3) * 3 +
    Math.min(s.svg, 3) * 2 +
    (s.charts ? 3 : 0) +
    Math.min(s.images, 3) * 1.5 +
    (s.video ? 2 : 0) +
    (s.controls >= 4 ? 2 : s.controls >= 2 ? 1 : 0) +
    (s.shell ? 5 : 0) +
    (s.text < 300 ? 3 : 0);
  const textual =
    Math.min(s.text / 700, 6) +
    Math.min(s.headings, 4) * 0.5 +
    Math.min(s.paragraphs, 8) * 0.5 +
    (s.tables ? 1 : 0);
  if (visual > textual) {
    const genre: CoverGenre =
      s.charts || s.canvas || s.svg
        ? s.shell && s.controls >= 2 && !s.charts
          ? "app"
          : "dashboard"
        : s.shell || s.controls >= 4
          ? "app"
          : "page";
    return { kind: "visual", genre };
  }
  return {
    kind: "text",
    genre: s.tables || s.headings >= 3 ? "report" : "document",
  };
}

export function coverFactsFromHtml(source: string): CoverFacts {
  const document = parse(source.slice(0, COVER_READ_BYTES)) as unknown as Node;
  const signals: CoverSignals = {
    text: 0,
    headings: 0,
    paragraphs: 0,
    tables: 0,
    canvas: 0,
    svg: 0,
    images: 0,
    video: 0,
    controls: 0,
    charts: false,
    scripted: false,
    shell: false,
  };
  let title = "";
  const headings: Array<{ level: number; order: number; text: string }> = [];
  const paragraphs: Array<{ order: number; text: string }> = [];
  const css: string[] = [];
  let cssLength = 0;
  const addCss = (value: string) => {
    if (cssLength >= MAX_CSS) return;
    css.push(value);
    cssLength += value.length;
  };
  let order = 0;
  // [node, inside a skipped element]
  const stack: Array<[Node, boolean]> = [[document, false]];
  while (stack.length) {
    const [node, hidden] = stack.pop()!;
    order++;
    if (node.nodeName === "#text") {
      if (!hidden) signals.text += (node.value ?? "").replace(/\s+/g, " ").trim().length;
      continue;
    }
    const tag = node.tagName?.toLowerCase();
    let inner = hidden;
    if (tag) {
      const style = attr(node, "style");
      if (style) addCss(style);
      if (tag === "title" && !title) title = textOf(node, 300);
      else if (tag === "style") addCss(textOf(node, MAX_CSS));
      else if (tag === "script") {
        signals.scripted = true;
        const src = attr(node, "src") ?? "";
        const code = src ? "" : textOf(node, 64 * 1024);
        if (CHART_LIBRARY.test(src) || CHART_LIBRARY.test(code) || CHART_CALL.test(code))
          signals.charts = true;
        // Colours set from script (inline styles of React apps) count too.
        if (code) addCss(code);
      } else if (!hidden) {
        if (/^h[1-3]$/.test(tag)) {
          signals.headings++;
          const text = textOf(node, 400);
          if (text) headings.push({ level: Number(tag[1]), order, text });
        } else if (PARAGRAPHS.has(tag)) {
          const text = textOf(node, 600);
          if (text.length >= 40) {
            signals.paragraphs++;
            if (paragraphs.length < 12) paragraphs.push({ order, text });
          }
        } else if (tag === "table") signals.tables++;
        else if (tag === "canvas") signals.canvas++;
        else if (tag === "svg" && drawing(node)) signals.svg++;
        else if (tag === "img") {
          const w = size(attr(node, "width")),
            h = size(attr(node, "height"));
          if (!((w !== null && w < 48) || (h !== null && h < 48))) signals.images++;
        } else if (tag === "video") signals.video++;
        else if (CONTROLS.has(tag)) signals.controls++;
      }
      if (SKIPPED.has(tag)) inner = true;
    }
    const children = node.childNodes ?? [];
    if (node.content) stack.push([node.content, true]);
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i]!, inner]);
  }
  signals.shell = signals.scripted && signals.text < 200;
  const { kind, genre } = decideKind(signals);
  const top =
    headings.find((h) => h.level === 1) ??
    headings.find((h) => h.level === 2) ??
    headings[0];
  const heading = top?.text || title || paragraphs[0]?.text || "";
  const lead =
    paragraphs.find((p) => (top ? p.order > top.order : true) && p.text !== heading) ??
    paragraphs.find((p) => p.text !== heading);
  return {
    kind,
    genre,
    heading: heading ? clip(heading, MAX_HEADING) : null,
    lead: lead ? clip(lead.text, MAX_LEAD) : null,
    accent: accentOf(css.join("\n")),
    signals,
  };
}

// Markdown markers at the start of a line: headings, lists, quotes, emphasis.
const MARKDOWN_LINE = /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/;
const plain = (line: string) =>
  line
    .replace(MARKDOWN_LINE, "")
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();

/** A text file: always a text cover. A Markdown «#» heading or the first short line leads. */
export function coverFactsFromText(source: string, filename = ""): CoverFacts {
  const lines = source.slice(0, 64 * 1024).split(/\r?\n/);
  const markdown =
    /\.(md|markdown)$/i.test(filename) || lines.some((line) => /^#{1,3}\s+\S/.test(line));
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
  const hashHeading = lines.findIndex((line) => /^#{1,2}\s+\S/.test(line));
  let heading: string | null = null;
  let rest: string[];
  if (hashHeading >= 0) {
    heading = plain(lines[hashHeading]!);
    rest = lines.slice(hashHeading + 1).map((line) => line.trim()).filter(Boolean);
  } else if (nonEmpty[0] && nonEmpty[0].length <= 120) {
    heading = plain(nonEmpty[0]);
    rest = nonEmpty.slice(1);
  } else rest = nonEmpty;
  // The lead stops at the next heading.
  const leadLines: string[] = [];
  for (const line of rest) {
    if (/^#{1,6}\s/.test(line)) {
      if (leadLines.length) break;
      continue;
    }
    leadLines.push(plain(line));
    if (leadLines.join(" ").length > MAX_LEAD) break;
  }
  const text = source.replace(/\s+/g, " ").trim().length;
  return {
    kind: "text",
    genre: markdown ? "markdown" : "note",
    heading: heading ? clip(heading, MAX_HEADING) : null,
    lead: leadLines.length ? clip(leadLines.join(" "), MAX_LEAD) : null,
    accent: null,
    signals: {
      text,
      headings: lines.filter((line) => /^#{1,6}\s/.test(line)).length,
      paragraphs: 0,
      tables: 0,
      canvas: 0,
      svg: 0,
      images: 0,
      video: 0,
      controls: 0,
      charts: false,
      scripted: false,
      shell: false,
    },
  };
}
