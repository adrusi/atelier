// Emulated media features (ARCHITECTURE.md, "Media features"): which ones a
// tab emulates, and media queries rewritten to match. Shared by the
// userScripts-world emulation (emulation.ts) and the page-world matchMedia
// override (main.ts), so it has no imports and stays small.

/** Emulated media features and their values. */
export type Features = {
  "prefers-color-scheme"?: "light" | "dark";
  /** The viewport size to lay out at, in CSS pixels. */
  width?: number;
  height?: number;
};

/** The features a document emulates: in a frame, only the colour scheme.
 * A real dark preference reaches every frame; but a frame's viewport is its
 * iframe's box, which the emulated page around it already lays out, so
 * inside a frame the size is real and nothing about it is emulated. */
export function forThisFrame(f: Features | null, inFrame: boolean): Features | null {
  if (!f || !inFrame) return f;
  const scheme = f["prefers-color-scheme"];
  return scheme ? { "prefers-color-scheme": scheme } : null;
}

/** Always true, and always false: single parenthesized features, so they
 * can stand wherever the feature they replace stood (after `not`, say). */
export const TRUE = "(min-width: 0px)";
export const FALSE = "(min-width: 99999999px)";

/** A media query length in CSS pixels: a number with px, em or rem (em and
 * rem are the initial font size, 16px, as the browser has them in media
 * queries), or calc() of those with + - * / and parentheses. Null if it's
 * anything else. Parsed by hand: page CSP can forbid eval in the page world. */
function px(value: string): number | null {
  const tokens = value.trim().replace(/^calc(?=\()/i, "").match(/-?\d*\.?\d+(?:px|em|rem)?|[-+*/()]|calc|\S/gi);
  if (!tokens) return null;
  let i = 0;
  const atom = (): number | null => {
    const t = tokens[i++];
    if (t === undefined) return null;
    if (t.toLowerCase() === "calc") return atom();
    if (t === "(") {
      const v = sum();
      return tokens[i++] === ")" ? v : null;
    }
    const m = /^(-?\d*\.?\d+)(px|em|rem)?$/i.exec(t);
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] && m[2].toLowerCase() !== "px" ? n * 16 : n;
  };
  const product = (): number | null => {
    let v = atom();
    while (v !== null && (tokens[i] === "*" || tokens[i] === "/")) {
      const op = tokens[i++];
      const w = atom();
      v = w === null ? null : op === "*" ? v * w : v / w;
    }
    return v;
  };
  const sum = (): number | null => {
    let v = product();
    while (v !== null && (tokens[i] === "+" || tokens[i] === "-")) {
      const op = tokens[i++];
      const w = product();
      v = w === null ? null : op === "+" ? v + w : v - w;
    }
    return v;
  };
  const v = sum();
  return i === tokens.length ? v : null;
}

/** A ratio ("16/9", "1.5"), or null. */
function ratio(value: string): number | null {
  const m = /^([\d.]+)\s*(?:\/\s*([\d.]+))?$/.exec(value.trim());
  return m ? Number(m[1]) / Number(m[2] ?? 1) : null;
}

const compare = (a: number, op: string, b: number) =>
  op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : Math.abs(a - b) < 0.01;

/** The emulated value of a size feature (width, height, aspect-ratio), or null. */
function sizeOf(name: string, f: Features): number | null {
  if (f.width === undefined || f.height === undefined) return null;
  if (name === "width") return f.width;
  if (name === "height") return f.height;
  if (name === "aspect-ratio") return f.width / f.height;
  return null;
}

/** Evaluates `name: value` (plain syntax), or null if it isn't emulated. */
function plain(name: string, value: string, f: Features): boolean | null {
  if (name === "prefers-color-scheme") return f[name] === undefined ? null : value.trim() === f[name];
  if (name === "orientation") {
    if (f.width === undefined || f.height === undefined) return null;
    return value.trim() === (f.height >= f.width ? "portrait" : "landscape");
  }
  const m = /^(min-|max-)?(width|height|aspect-ratio)$/.exec(name);
  if (!m) return null;
  const actual = sizeOf(m[2], f);
  const wanted = m[2] === "aspect-ratio" ? ratio(value) : px(value);
  if (actual === null || wanted === null) return null;
  return compare(actual, m[1] === "min-" ? ">=" : m[1] === "max-" ? "<=" : "=", wanted);
}

/** Evaluates a range-syntax feature ("width >= 600px", "400px < width <= 700px"), or null. */
function range(text: string, f: Features): boolean | null {
  const parts = text.split(/\s*(<=|>=|<|>|=)\s*/).map((p) => p.trim());
  const name = parts.find((p) => /^(width|height|aspect-ratio)$/.test(p));
  if (!name || (parts.length !== 3 && parts.length !== 5)) return null;
  const actual = sizeOf(name, f);
  if (actual === null) return null;
  const value = (s: string) => (name === "aspect-ratio" ? ratio(s) : px(s));
  for (let i = 0; i + 2 < parts.length; i += 2) {
    const [left, op, right] = [parts[i], parts[i + 1], parts[i + 2]];
    const a = left === name ? actual : value(left);
    const b = right === name ? actual : value(right);
    if (a === null || b === null) return null;
    if (!compare(a, op, b)) return false;
  }
  return true;
}

/** A media query list with every emulated feature test replaced by one
 * that's always true or always false; others are left as they are.
 * Parentheses are matched, so features with calc() in them, and groups
 * like ((a) or (b)), are understood. */
export function rewriteMedia(text: string, f: Features): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "(") {
      out += text[i];
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) break;
    }
    const inner = text.slice(i + 1, j).trim();
    if (/^(\(|not\s*\()/i.test(inner)) {
      // A group of conditions: rewrite inside it.
      out += `(${rewriteMedia(inner, f)})`;
    } else {
      const colon = /^([a-z-]+)\s*:\s*([\s\S]+)$/i.exec(inner);
      const result = colon ? plain(colon[1].toLowerCase(), colon[2], f) : /[<>=]/.test(inner) ? range(inner, f) : null;
      out += result === null ? text.slice(i, j + 1) : result ? TRUE : FALSE;
    }
    i = j;
  }
  return out;
}

/** Whether a media query mentions anything emulated. */
export function mentions(text: string, f: Features): boolean {
  if (f["prefers-color-scheme"] && text.includes("prefers-color-scheme")) return true;
  return f.width !== undefined && /width|height|orientation|aspect-ratio/.test(text);
}

/** The media queries in CSS text (@media and @import preludes) rewritten;
 * the rest, container queries and @supports included, left alone. */
export function rewriteMediaInCss(css: string, f: Features): string {
  return css
    .replace(/@media([^{;]+)\{/g, (_, prelude: string) => `@media${rewriteMedia(prelude, f)}{`)
    .replace(/@import([^;]+);/g, (_, rest: string) => `@import${rewriteMedia(rest, f)};`);
}
