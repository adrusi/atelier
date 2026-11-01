// The inspection and interaction tools' page side (the background's tools.ts
// calls these by name). They work on the page model in core.ts, so they see
// every open shadow root and the copies of cross-origin sheets. Results must
// be plain JSON.

import * as core from "./core";
import { syncNow } from "./emulation";

/** Adds CSS for one capture (after atelier's own styles, so it wins ties),
 * or removes it (null). For showing variants without editing files. */
export function extraCss(css: string | null) {
  core.query("style[data-atelier-extra]", false)[0]?.remove();
  if (css === null) return;
  const el = document.createElement("style");
  el.setAttribute("data-atelier-extra", "");
  el.textContent = css;
  document.documentElement.append(el);
}

/** Brings what emulation keeps up to date (where fixed elements sit, for
 * the scroll position) up to date now: before a screenshot. */
export function syncEmulation() {
  syncNow();
}

/** Finishes CSS animations and transitions (shadow trees' included). */
export function finishAnimations(): number {
  let n = 0;
  for (const a of document.getAnimations()) {
    try {
      a.finish();
      n++;
    } catch {
      // Infinite animations can't be finished.
    }
  }
  return n;
}

export function pageState(): { visibility: string; width: number; height: number; scrollY: number } {
  const root = document.documentElement;
  return {
    visibility: document.visibilityState,
    width: Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0),
    height: Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0),
    scrollY: window.scrollY,
  };
}

/** Where an element shows, in viewport coordinates: its box, or for a box
 * with no size whose contents overflow it (a popover's host element, a
 * wrapper of positioned children), the union of what's in it. */
function box(el: Element): DOMRect {
  const r = el.getBoundingClientRect();
  if (r.width >= 2 && r.height >= 2) return r;
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const d of [...el.querySelectorAll("*")].slice(0, 500)) {
    const b = d.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) continue;
    [left, top, right, bottom] = [Math.min(left, b.left), Math.min(top, b.top), Math.max(right, b.right), Math.max(bottom, b.bottom)];
  }
  return left === Infinity ? r : new DOMRect(left, top, right - left, bottom - top);
}

/** Why an element that's in the layout can't be seen, if it can't: it or an
 * ancestor is transparent or invisible, or it's outside the page. Pages
 * keep things like this in the DOM until they're wanted (a "new posts"
 * pill, a closed drawer), and its rect alone doesn't say so. */
function unseen(el: Element, b: DOMRect): string | null {
  for (let e: Element | null = el; e && e !== document.documentElement; e = core.up(e)) {
    const cs = getComputedStyle(e);
    const who = e === el ? "it" : `its ancestor ${core.describe(e, 1, 3)}`;
    if (Number(cs.opacity) === 0) return `${who} has opacity 0`;
    if (cs.visibility !== "visible") return `${who} has visibility ${cs.visibility}`;
  }
  const root = document.documentElement;
  const [x, y] = [b.left + window.scrollX, b.top + window.scrollY];
  if (x + b.width <= 0 || y + b.height <= 0 || x >= root.scrollWidth || y >= root.scrollHeight) {
    return `it's outside the page (at ${Math.round(x)},${Math.round(y)} in the document), moved off by its position or a transform`;
  }
  return null;
}

/** The element's box in document coordinates, and why it can't be seen if
 * it can't (unseen), or null if nothing matches. */
export function rectOf(selector: string): { x: number; y: number; width: number; height: number; unseen?: string } | null {
  const all = core.query(selector, true);
  if (!all.length) return null;
  // The first match that's actually showing: pages often keep hidden copies (templates, other breakpoints).
  const el = all.find((e) => { const b = box(e); return b.width > 0 && b.height > 0; }) ?? all[0];
  const r = box(el);
  const why = r.width && r.height ? unseen(el, r) : null;
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height, ...(why ? { unseen: why } : {}) };
}

export function query(selector: string, limit: number, maxLength: number) {
  const els = core.query(selector, true);
  return {
    count: els.length,
    elements: els.slice(0, limit).map((el) => {
      const html = el.outerHTML;
      return { path: core.describe(el, 4, 3), html: html.length > maxLength ? `${html.slice(0, maxLength)}…` : html };
    }),
  };
}

export function computed(selector: string, properties: string[] | null) {
  const el = core.query(selector, false)[0] ?? null;
  if (!el) return null;
  const cs = getComputedStyle(el);
  const props = properties?.length
    ? properties
    : [
        "color", "background-color", "background-image", "border-color", "border-width", "border-radius",
        "box-shadow", "font-family", "font-size", "font-weight", "line-height", "opacity", "display",
        "color-scheme", "outline",
      ];
  return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
}

/** Copies of the sheets the page couldn't read, fetched by the extension. */
export const provideFetched = core.provideFetched;
export const unreadableSheets = core.unreadableSheets;

/** Custom properties defined by the page's stylesheets (following @import,
 * and in open shadow roots): where, under which conditions, and where
 * they're used; and which selectors other than :root re-declare them (nested
 * theme scopes, which undo :root overrides inside them). */
export function tokens(filter: string | null, limit: number, usage: boolean, scope: string | null, verbose: boolean) {
  type Def = { selector: string; value: string; context?: string; sheet: string };
  const defs = new Map<string, Def[]>();
  const uses = new Map<string, { count: number; examples: string[] }>();
  const scopes = new Map<string, number>();
  const unread: string[] = [];
  const sheets = core.allSheets().filter((s) => s.owner === "page" || s.owner === "fetched");
  for (const { rule: r, selector, context, sheet } of core.rules(sheets, unread)) {
    const inScope = !scope || selector.includes(scope);
    for (let i = 0; i < r.style.length; i++) {
      const name: string = r.style[i];
      if (!inScope || !name.startsWith("--") || (filter && !name.includes(filter))) continue;
      const list = defs.get(name) ?? [];
      const value: string = r.style.getPropertyValue(name).trim();
      list.push({
        selector,
        value: value.length > 100 ? `${value.slice(0, 100)}…` : value,
        ...(context ? { context } : {}),
        sheet: sheet.label,
      });
      defs.set(name, list);
      if (!/^\s*(:root|html|:host)\b/.test(selector)) scopes.set(selector, (scopes.get(selector) ?? 0) + 1);
    }
    if (usage) {
      for (const m of core.declarations(r.style).matchAll(/var\(\s*(--[\w-]+)/g)) {
        const u = uses.get(m[1]) ?? { count: 0, examples: [] };
        u.count++;
        if (u.examples.length < 3 && !u.examples.includes(selector)) u.examples.push(selector.slice(0, 80));
        uses.set(m[1], u);
      }
    }
  }
  const names = [...defs.keys()].sort();
  // Compact by default: one string per definition, and stylesheets listed once.
  const sheetNames: string[] = [];
  const sheetIndex = (name: string) => {
    let i = sheetNames.indexOf(name);
    if (i < 0) i = sheetNames.push(name) - 1;
    return i;
  };
  // Name families with counts, so a huge design system can be narrowed with `filter`.
  const families = new Map<string, number>();
  for (const n of names) {
    const f = n.split("-").slice(0, 3).join("-");
    families.set(f, (families.get(f) ?? 0) + 1);
  }
  return {
    total: names.length,
    shown: Math.min(limit, names.length),
    families: [...families.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([f, n]) => `${f}-* ${n}`),
    tokens: names.slice(0, limit).map((name) => {
      const ds = defs.get(name)!;
      const used = uses.get(name) ?? { count: 0, examples: [] };
      if (verbose) return { name, definitions: ds, ...(usage ? { used } : {}) };
      return {
        name,
        // "selector = value  [conditions] (sheet N)"
        defs: ds.map((d) => `${d.selector} = ${d.value}${d.context ? `  [${d.context}]` : ""} (sheet ${sheetIndex(d.sheet)})`),
        ...(usage ? { used: used.count ? `${used.count}× e.g. ${used.examples.join(" | ")}` : "unused" } : {}),
      };
    }),
    ...(verbose ? {} : { sheets: sheetNames }),
    // Selectors other than :root/html that define custom properties, with how
    // many they define, and which elements they match now. Those matching
    // elements inside the page (`nested`) re-declare tokens there, undoing
    // :root overrides inside them.
    otherScopes: [...scopes.entries()]
      .map(([selector, count]) => {
        let root = false;
        let nested: string[] = [];
        try {
          root = document.documentElement.matches(selector);
          nested = core
            .queryAll(selector)
            .filter((e) => e !== document.documentElement)
            .slice(0, 5)
            .map((e) => e.tagName.toLowerCase() + (e.id ? `#${e.id}` : "") + [...e.classList].slice(0, 2).map((c) => `.${c}`).join(""));
        } catch {
          // Selectors the DOM API can't evaluate (e.g. with pseudo-elements).
        }
        return { selector, tokens: count, matchesRoot: root, nested };
      })
      .sort((a, b) => b.nested.length - a.nested.length || Number(b.matchesRoot) - Number(a.matchesRoot) || b.tokens - a.tokens)
      .slice(0, 40),
    unreadableSheets: unread,
  };
}

/** Selector specificity as [ids, classes, types]. */
function specificity(sel: string): number[] {
  const add = (a: number[], b: number[]) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  let total = [0, 0, 0];
  let s = sel;
  // Functional pseudo-classes: :where() counts nothing; :is/:not/:has count their most specific argument.
  for (;;) {
    const m = /:(is|not|has|where|matches|-moz-any)\(/.exec(s);
    if (!m) break;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < s.length && depth > 0; i++) {
      if (s[i] === "(") depth++;
      else if (s[i] === ")") depth--;
    }
    const inner = s.slice(m.index + m[0].length, i - 1);
    if (m[1] !== "where") total = add(total, maxSpecificity(core.splitTop(inner).map(specificity)));
    s = `${s.slice(0, m.index)} ${s.slice(i)}`;
  }
  s = s.replace(/\[[^\]]*\]/g, () => ((total = add(total, [0, 1, 0])), " "));
  s = s.replace(/#[\w-]+/g, () => ((total = add(total, [1, 0, 0])), " "));
  s = s.replace(/\.[\w-]+/g, () => ((total = add(total, [0, 1, 0])), " "));
  s = s.replace(/::[\w-]+(\([^)]*\))?|:(before|after|first-line|first-letter)\b/g, () => ((total = add(total, [0, 0, 1])), " "));
  s = s.replace(/:[\w-]+(\([^)]*\))?/g, () => ((total = add(total, [0, 1, 0])), " "));
  s.replace(/(^|[\s>+~])([a-zA-Z][\w-]*)/g, (_, __, tag) => ((total = add(total, [0, 0, 1])), tag));
  return total;
}

const maxSpecificity = (xs: number[][]) =>
  xs.reduce((m, x) => (x[0] > m[0] || (x[0] === m[0] && (x[1] > m[1] || (x[1] === m[1] && x[2] > m[2]))) ? x : m), [0, 0, 0]);

/** The same side of a box under its other name, for an element in
 * horizontal text: padding-left is padding-inline-start in left-to-right
 * text and padding-inline-end in right-to-left; top is inset-block-start. */
function counterparts(property: string, el: Element): string[] {
  const rtl = getComputedStyle(el).direction === "rtl";
  const logicalOf: Record<string, string> = {
    top: "block-start",
    bottom: "block-end",
    left: rtl ? "inline-end" : "inline-start",
    right: rtl ? "inline-start" : "inline-end",
  };
  const physicalOf = Object.fromEntries(Object.entries(logicalOf).map(([k, v]) => [v, k]));
  let m = /^(top|right|bottom|left)$/.exec(property);
  if (m) return [`inset-${logicalOf[m[1]]}`];
  m = /^inset-((?:block|inline)-(?:start|end))$/.exec(property);
  if (m) return [physicalOf[m[1]]];
  m = /^(margin|padding|border|scroll-margin|scroll-padding)-(top|right|bottom|left)(-(?:color|style|width))?$/.exec(property);
  if (m) return [`${m[1]}-${logicalOf[m[2]]}${m[3] ?? ""}`];
  m = /^(margin|padding|border|scroll-margin|scroll-padding)-((?:block|inline)-(?:start|end))(-(?:color|style|width))?$/.exec(property);
  if (m) return [`${m[1]}-${physicalOf[m[2]]}${m[3] ?? ""}`];
  return [];
}

/** Shorthands that can set a longhand: its hyphenated prefixes
 * (padding-inline for padding-inline-start, border-top for
 * border-top-color), and the few that aren't prefixes. */
function shorthandsOf(property: string): string[] {
  const parts = property.split("-");
  const out = parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("-"));
  const FONT = ["font-style", "font-variant", "font-weight", "font-stretch", "font-width", "font-size", "line-height", "font-family"];
  if (FONT.includes(property) && !out.includes("font")) out.push("font");
  if (/^(top|right|bottom|left)$/.test(property)) out.push("inset");
  if (/^inset-(block|inline)-(start|end)$/.test(property)) out.push(`inset-${parts[1]}`);
  let m = /^border-(?:top|right|bottom|left|(?:block|inline)-(?:start|end))-(color|style|width)$/.exec(property);
  if (m) out.push(`border-${m[1]}`);
  m = /^border-(block|inline)-(?:start|end)-(color|style|width)$/.exec(property);
  if (m) out.push(`border-${m[1]}-${m[2]}`);
  return out;
}

/** Style rules that match an element, with specificity and conditions, most
 * specific first; ties are listed latest first, as later rules win. An
 * element inside a shadow root is styled by that root's sheets. */
export function matchedRules(selector: string, property: string | null, limit: number) {
  const el = core.query(selector, false)[0] ?? null;
  if (!el) return null;

  // The property under its other name (padding-left is padding-inline-start
  // in left-to-right text), and the shorthands that can set either.
  const names = property ? [property, ...counterparts(property, el)] : [];
  const setters = names.flatMap(shorthandsOf);

  type Hit = { selector: string; specificity: number[]; declarations: string; context?: string; active: boolean; sheet: string; order: number };
  const hits: Hit[] = [];
  const unread: string[] = [];
  const home = el.getRootNode() as core.Scope;
  for (const { rule: r, selector: full, context, active, sheet, order } of core.rules(core.sheets(home), unread)) {
    const matching = core.splitTop(full).filter((part) => {
      try {
        return el.matches(part);
      } catch {
        return false; // e.g. pseudo-elements
      }
    });
    if (!matching.length) continue;
    let declarations = core.declarations(r.style);
    if (property) {
      const name = names.find((n) => r.style.getPropertyValue(n));
      if (name) {
        declarations = `${name}: ${r.style.getPropertyValue(name)}${r.style.getPropertyPriority(name) ? " !important" : ""}`;
        // Say so when it comes from a shorthand, which is easy to miss (font: … resets font-stretch).
        const via = setters.find((n) => r.style.getPropertyValue(n));
        const notes = [...(via ? [`via ${via}: ${r.style.getPropertyValue(via)}`] : []), ...(name !== property ? [`sets ${property}`] : [])];
        if (notes.length) declarations += ` (${notes.join("; ")})`;
      } else {
        // A shorthand that sets it (font: … resets font-stretch, border: … sets border-top-color).
        const sh = setters.find((name) => r.style.getPropertyValue(name));
        if (!sh) continue;
        declarations = `${sh}: ${r.style.getPropertyValue(sh)} (sets ${property})`;
      }
    }
    hits.push({
      selector: full,
      specificity: maxSpecificity(matching.map(specificity)),
      declarations: declarations.length > 400 ? `${declarations.slice(0, 400)}…` : declarations,
      ...(context ? { context } : {}),
      active,
      sheet: sheet.label,
      order,
    });
  }
  hits.sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a.specificity[i] !== b.specificity[i]) return b.specificity[i] - a.specificity[i];
    return b.order - a.order;
  });
  const inline = (el as HTMLElement).style?.cssText;
  // Nothing here sets it: say which ancestor the inherited value comes from.
  let inheritedFrom: string | undefined;
  if (property && !hits.length && !inline) {
    const value = getComputedStyle(el).getPropertyValue(property);
    let origin: Element = el;
    for (let p = core.up(el); p && getComputedStyle(p).getPropertyValue(property) === value; p = core.up(p)) origin = p;
    if (origin !== el) inheritedFrom = core.describe(origin, 1, 3);
  }
  return {
    ...(inheritedFrom ? { inheritedFrom, hint: `No rule sets ${property} on this element; it inherits from ${inheritedFrom}. Run matched_rules on that.` } : {}),
    element: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + [...el.classList].map((c) => `.${c}`).join(""),
    ...(property ? { computed: getComputedStyle(el).getPropertyValue(property) } : {}),
    ...(inline
      ? {
          inlineStyle: inline,
          note: "The element has an inline style attribute, which beats every rule here unless the rule uses !important.",
        }
      : {}),
    total: hits.length,
    rules: hits.slice(0, limit).map(({ order: _, ...h }) => h),
    ...(unread.length ? { unreadableSheets: unread, unreadableNote: "These stylesheets couldn't be read, so rules in them aren't listed." } : {}),
  };
}

/** Visible text whose contrast with its background is below the WCAG
 * threshold (3:1 for large text), in the page and its open shadow roots.
 * Backgrounds are composited from the element up; text over background
 * images is counted as unknown, not checked. */
export function contrast(minRatio: number, limit: number, exclude: string | null = null) {
  type RGBA = { r: number; g: number; b: number; a: number };
  const parse = (c: string): RGBA | null => {
    let m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
    }
    m = /color\(srgb ([^)]+)\)/.exec(c);
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p[3] ?? 1 };
    }
    return null;
  };
  const over = (top: RGBA, bottom: RGBA): RGBA => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const lum = (c: RGBA) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const hex = (c: RGBA) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
  const canvas = matchMedia("(prefers-color-scheme: dark)").matches &&
    getComputedStyle(document.documentElement).colorScheme.includes("dark")
    ? { r: 28, g: 27, b: 34, a: 1 }
    : { r: 255, g: 255, b: 255, a: 1 };
  const background = (el: Element): RGBA | null => {
    const layers: RGBA[] = [];
    for (let e: Element | null = el; e; e = core.up(e)) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== "none") return null;
      const bg = parse(cs.backgroundColor);
      if (bg && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 1) break;
      }
    }
    return layers.reverse().reduce((acc, l) => over(l, acc), canvas);
  };

  const seen = new Set<Element>();
  const failures: { ratio: number }[] = [];
  let checked = 0;
  let unknown = 0;
  let disabled = 0;
  let excluded = 0;
  for (const node of core.textNodes()) {
    const el = node.parentElement;
    if (!el || seen.has(el) || !node.textContent?.trim()) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility !== "visible" || !el.getClientRects().length) continue;
    // WCAG exempts disabled controls; sites dim them on purpose.
    if (el.closest(':disabled, [aria-disabled="true"]')) {
      disabled++;
      continue;
    }
    // Text the agent says is meant to be faint (downvoted comments, say).
    if (exclude && el.closest(exclude)) {
      excluded++;
      continue;
    }
    checked++;
    const bg = background(el);
    if (!bg) {
      unknown++;
      continue;
    }
    const fg = parse(cs.color);
    if (!fg) continue;
    const text = over(fg, bg);
    const [hi, lo] = [lum(text), lum(bg)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const threshold = size >= 24 || (bold && size >= 18.66) ? Math.min(3, minRatio) : minRatio;
    if (ratio < threshold) {
      failures.push({
        element: core.describe(el),
        text: node.textContent.trim().slice(0, 60),
        color: hex(text),
        background: hex(bg),
        ratio: Math.round(ratio * 100) / 100,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
      } as { ratio: number });
    }
  }
  failures.sort((a, b) => a.ratio - b.ratio);
  // The colour pairs behind the failures, most common first: thousands of
  // failures are often one pair, deliberate or not.
  const pairs = new Map<string, { color: string; background: string; count: number; worst: number; example: string }>();
  for (const f of failures as unknown as { color: string; background: string; ratio: number; element: string }[]) {
    const key = `${f.color} ${f.background}`;
    const p = pairs.get(key) ?? { color: f.color, background: f.background, count: 0, worst: f.ratio, example: f.element };
    p.count++;
    pairs.set(key, p);
  }
  const byColour = [...pairs.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  return {
    checked,
    failing: failures.length,
    failures: failures.slice(0, limit),
    ...(failures.length > limit ? { byColour } : {}),
    unknownBackground: unknown,
    skippedDisabled: disabled,
    ...(exclude ? { skippedExcluded: excluded } : {}),
  };
}

/** Forces pseudo-class states on an element, like devtools' "force element
 * state": every readable rule using one of the states, in every scope, is
 * cloned with the pseudo-class replaced by an attribute, which is then set
 * on the element (and its ancestors, across shadow boundaries, for :hover,
 * :active and :focus-within, which apply there too). The clones come after
 * all other styles in their scope, so at equal specificity they can win
 * slightly more often than the real state would. An empty `states` clears
 * everything forced. */
export function forceState(selector: string, states: string[]) {
  const KNOWN = ["hover", "active", "focus", "focus-visible", "focus-within"];
  const attr = (s: string) => `data-atelier-force-${s}`;
  for (const el of core.queryAll("style[data-atelier-force]")) el.remove();
  for (const s of KNOWN) for (const e of core.queryAll(`[${attr(s)}]`)) e.removeAttribute(attr(s));
  if (!states.length) return { cleared: true };
  const unknown = states.filter((s) => !KNOWN.includes(s));
  if (unknown.length) return { error: `unknown states: ${unknown.join(", ")}; known: ${KNOWN.join(", ")}` };
  const el = core.query(selector, false)[0] ?? null;
  if (!el) return null;

  const pattern = new RegExp(`:(${states.map((s) => s.replace(/-/g, "\\-")).join("|")})(?![\\w-])`, "g");
  let cloned = 0;
  for (const scope of core.scopes()) {
    const clones: string[] = [];
    for (const { rule, own, selector: full, context } of core.rules(core.sheets(scope).filter((s) => s.owner !== "forced"))) {
      if (!own) continue;
      pattern.lastIndex = 0;
      if (!pattern.test(full)) continue;
      const sel = full.replace(pattern, (_: string, s: string) => `[${attr(s)}]`);
      // Each condition wraps the clone, outermost first; @import's and @layer's can't wrap a rule.
      const heads = (context.match(/@(media|supports|container)\b[^@]*/g) ?? []).map((h) => h.trim());
      clones.push(heads.reduceRight((css, head) => `${head} { ${css} }`, `${sel} { ${rule.style.cssText} }`));
    }
    if (!clones.length) continue;
    const style = document.createElement("style");
    style.setAttribute("data-atelier-force", states.join(" "));
    style.textContent = clones.join("\n");
    core.rootOf(scope).append(style);
    cloned += clones.length;
  }
  const propagate = new Set(["hover", "active", "focus-within"]);
  for (const s of states) {
    for (let e: Element | null = el; e; e = propagate.has(s) ? core.up(e) : null) e.setAttribute(attr(s), "");
  }
  // Some sites react to hover from JavaScript (mouseover), not CSS.
  if (states.includes("hover")) {
    for (const type of ["mouseover", "mouseenter", "pointerover", "pointerenter"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith("over"), composed: true }));
    }
  }
  return { forced: states, rulesCloned: cloned };
}

/** Waits (up to timeoutMs) for images to load and decode, so a screenshot
 * doesn't catch them blank. */
export async function imagesReady(timeoutMs: number) {
  const pending = (core.queryAll("img") as HTMLImageElement[]).map((img) =>
    img.complete
      ? img.decode().catch(() => {})
      : new Promise((r) => {
          img.addEventListener("load", r, { once: true });
          img.addEventListener("error", r, { once: true });
        }),
  );
  await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
  return pending.length;
}

/** Waits until `selector` matches something, for pages that render after
 * load. Resolves true if it did within timeoutMs. */
export async function waitForSelector(selector: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (core.query(selector, false).length) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Fills a form field as typing would: focuses it, sets the value, and
 * dispatches input and change events, so scripts listening for input (search
 * suggestions, filters) respond. Fields in open shadow roots count too: web
 * components (MDN's search, say) keep theirs there, and setting the host's
 * value does nothing. */
export function fill(selector: string, text: string, submit: boolean) {
  const editable = (e: Element) => e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement;
  let target = core.find(selector);
  if (!target) return null;
  if (target instanceof HTMLSelectElement) {
    // A <select>: choose the option whose value or text this is, as a user would.
    const want = text.trim().toLowerCase();
    const options = [...target.options];
    const option = options.find((o) => o.value === text) ?? options.find((o) => o.text.trim().toLowerCase() === want);
    if (!option) return { error: `\`${selector}\` is a <select> with no option "${text}"; its options: ${options.map((o) => `${o.text.trim()} (${o.value})`).join(", ")}` };
    target.focus();
    target.value = option.value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return { value: target.value, chosen: option.text.trim() };
  }
  let host: string | undefined;
  if (!editable(target)) {
    const inner = core.scopes(target).filter((s): s is ShadowRoot => s instanceof ShadowRoot).map((s) => s.querySelector("input:not([type=hidden]), textarea")).find(Boolean) ?? null;
    if (!inner) return { error: `\`${selector}\` matches a <${target.tagName.toLowerCase()}>, which isn't a text field and has none in an open shadow root` };
    host = target.tagName.toLowerCase();
    target = inner;
  }
  const el = target as HTMLInputElement | HTMLTextAreaElement;
  el.focus();
  el.value = text;
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true }));
    }
    el.form?.requestSubmit();
  }
  const root = el.getRootNode() as core.Scope;
  return {
    value: el.value,
    focused: root.activeElement === el,
    ...(host || root !== document ? { inShadowRootOf: host ?? (root as ShadowRoot).host.tagName.toLowerCase() } : {}),
    ...(el.value !== text ? { warning: "The field didn't keep the text (the page may reset it, or limit what it accepts)." } : {}),
  };
}

/** Visible elements still drawn as boxes (rounded, shadowed, framed, or
 * filled differently from what's behind them), grouped by tag and classes.
 * For themes that change shapes: what's left to flatten, or left on purpose. */
export function shapeScan(scope: string | null, limit: number) {
  const root = scope ? core.query(scope, false)[0] : document.body;
  if (!root) return null;
  const transparent = (c: string) => c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);
  const behind = (el: Element | null): string => {
    for (let e = el; e; e = core.up(e)) {
      const bg = getComputedStyle(e).backgroundColor;
      if (!transparent(bg)) return bg;
    }
    return getComputedStyle(document.documentElement).backgroundColor;
  };
  const CONTROLS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON"]);
  type Group = { selector: string; count: number; features: Set<string>; example: string; control: boolean; round: boolean };
  const groups = new Map<string, Group>();
  let checked = 0;
  let shadowed = 0;
  for (const [el, inScope] of core.elements(root)) {
    // Groups inside shadow roots start with their hosts (host › element).
    const host = inScope instanceof ShadowRoot ? `${core.hostPath(el).split(" >>> ").join(" › ")} › ` : "";
    if (host) shadowed++;
    if (el.closest("[data-atelier-extra], style, script, head")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
    checked++;
    const features: string[] = [];
    const radius = Math.max(...["borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius"].map((p) => parseFloat((cs as any)[p]) || 0));
    if (radius > 0) features.push(`rounded ${Math.round(radius)}px`);
    if (cs.boxShadow !== "none") features.push("shadow");
    const sides = ["Top", "Right", "Bottom", "Left"].filter(
      (s) => parseFloat((cs as any)[`border${s}Width`]) > 0 && (cs as any)[`border${s}Style`] !== "none" && !transparent((cs as any)[`border${s}Color`]),
    ).length;
    if (sides >= 3) features.push("framed");
    const bg = cs.backgroundColor;
    if (!transparent(bg) && bg !== behind(core.up(el)) && r.height >= 24) features.push("filled");
    if (!features.length) continue;
    const classes = [...el.classList].filter((c) => !/\d{3,}|^[a-z]{1,3}-[a-zA-Z0-9]{5,}$/.test(c)).slice(0, 2);
    const selector = host + el.tagName.toLowerCase() + (el.id && !/\d{3,}/.test(el.id) ? `#${el.id}` : "") + classes.map((c) => `.${c}`).join("");
    // Small and square with a radius of about half its size: round by nature (avatars, radios, dots).
    const round = radius >= Math.min(r.width, r.height) * 0.4 && Math.abs(r.width - r.height) < 4 && r.width <= 96;
    let g = groups.get(selector);
    if (!g) {
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      g = { selector, count: 0, features: new Set(), example: text.length > 50 ? `${text.slice(0, 50)}…` : text, control: CONTROLS.has(el.tagName), round };
      groups.set(selector, g);
    }
    g.count++;
    for (const f of features) g.features.add(f.replace(/ \d+px$/, ` ${Math.round(radius)}px`));
  }
  const all = [...groups.values()].sort((a, b) => b.count - a.count);
  const show = (gs: Group[]) => gs.slice(0, limit).map((g) => ({ selector: g.selector, count: g.count, features: [...g.features], ...(g.example ? { example: g.example } : {}) }));
  return {
    checked,
    ...(shadowed ? { inShadowRoots: `${shadowed} elements were inside open shadow roots; their groups start with the host element (host › element). Closed shadow roots can't be seen.` } : {}),
    boxes: show(all.filter((g) => !g.control && !g.round)),
    controls: show(all.filter((g) => g.control && !g.round)),
    probablyRoundByNature: show(all.filter((g) => g.round)),
    ...(all.length > limit ? { note: `${all.length} groups in all; showing the largest. Narrow with scope.` } : {}),
  };
}

/** Where colour-scheme emulation falls short on this page: frames from
 * other origins (emulated, but injected as they load, so their earliest
 * scripts may see the real scheme), and SVG images, which follow the
 * browser's real preference if they carry their own prefers-color-scheme
 * rules (the background fetches these candidates to check). */
export function emulationGaps(): { frames: number; svgImages: string[] } {
  const urls = new Set<string>();
  const add = (u: string) => {
    if (u && /^data:image\/svg|\.svg([?#]|$)/i.test(u)) urls.add(u);
  };
  for (const img of core.queryAll("img") as HTMLImageElement[]) add(img.currentSrc || img.src);
  const PROPS = ["background-image", "mask-image", "list-style-image", "border-image-source", "content"];
  for (const [el] of core.elements().slice(0, 5000)) {
    for (const pseudo of [null, "::before", "::after"]) {
      const cs = getComputedStyle(el, pseudo);
      for (const p of PROPS) for (const m of cs.getPropertyValue(p).matchAll(/url\("([^"]+)"\)/g)) add(m[1]);
    }
  }
  const crossOrigin = (core.queryAll("iframe[src], frame[src]") as HTMLIFrameElement[]).filter((f) => {
    try {
      return new URL(f.src, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  }).length;
  return { frames: crossOrigin, svgImages: [...urls].slice(0, 40) };
}

/** A selector of one of atelier's styles that Firefox can't use:
 * "dropped" (it can't parse it, so the whole rule is thrown away), or
 * "ignored" (inside :is() or :where(), which forgive what they can't parse:
 * the rule stays, but those arguments match nothing). */
type Unusable = { style: string; selector: string; effect: "dropped" | "ignored" };

/** atelier's styles as they are in the page: which are present (the
 * shim's elements, and @shadow styles in shadow roots), and selectors in
 * them Firefox can't use, which is silent and easy to mistake for a
 * cascade problem. Each selector in each rule's list is tested with
 * CSS.supports, Firefox's own (unforgiving) parser, and one that fails is
 * tried in a sheet to see what Firefox does with the rule. */
export function atelierStyleCheck(): { present: string[]; dropped: Unusable[] } {
  const present = new Set<string>();
  const dropped: Unusable[] = [];
  const effect = (sel: string): Unusable["effect"] => (core.keepsRule(sel.replace(/&/g, "*")) ? "ignored" : "dropped");
  const supported = (sel: string) => {
    // Nesting: & stands for the parent, and a leading combinator is relative to it.
    const testable = sel.replace(/&/g, "*").replace(/^\s*[>+~]/, "* $&");
    try {
      return CSS.supports(`selector(${testable})`);
    } catch {
      return true; // can't tell
    }
  };
  for (const el of core.queryAll("style[data-atelier]")) {
    const id = el.getAttribute("data-atelier")!;
    present.add(id);
    // Rule preludes in the source: text before each {, outside comments and
    // strings, skipping at-rules and keyframe selectors.
    const text = (el.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks: string[] = [];
    let start = 0;
    let quote = "";
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      // Braces and semicolons inside strings ([title="a;b"], content: "{") don't count.
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === "{") {
        const prelude = text.slice(start, i).trim();
        const inKeyframes = blocks.some((b) => /^@(-\w+-)?keyframes/.test(b));
        blocks.push(prelude);
        if (prelude && !prelude.startsWith("@") && !inKeyframes) {
          // selector() takes one selector, not a list: test each.
          for (const p of core.splitTop(prelude)) {
            if (!supported(p) && dropped.length < 10) dropped.push({ style: id, selector: p, effect: effect(p) });
          }
        }
        start = i + 1;
      } else if (c === "}") {
        blocks.pop();
        start = i + 1;
      } else if (c === ";") start = i + 1;
    }
  }
  return { present: [...present], dropped };
}

/** Whether the page is a bot check (a challenge shown before the real page),
 * and which, judged by its title and markers the common ones use. */
export function botCheck(): string | null {
  const title = document.title.trim();
  if (/^(just a moment|attention required|checking your browser|verifying you are human|making sure you('|’)re not a bot|ddos-guard|please wait)/i.test(title)) return title;
  if (core.find("#challenge-form, #cf-challenge-running, .cf-browser-verification, #anubis_challenge, [data-ddg-challenge]")) return title || "a challenge page";
  return null;
}

/** Declarations in atelier's style files that never take effect: on every
 * element their rule matches, another of atelier's rules sets the property
 * to something else and wins. That's a specificity clash nobody meant (a
 * new rule losing to an older, broader one), which nothing else flags;
 * matched_rules explains one once it's suspected. A rule overridden only in
 * places is usually a refinement (a general rule, refined for a part of the
 * page), so those are only counted. Elements are counted whether they're
 * shown or not. The cascade is judged by !important, specificity and
 * order; @layer isn't considered. */
export function atelierClashes(limit: number) {
  type Decl = { value: string; important: boolean };
  type Ours = { file: string; selector: string; parts: string[]; order: number; scope: core.Scope; props: Map<string, Decl> };
  const ours: Ours[] = [];
  for (const scope of core.scopes()) {
    for (const { rule: r, selector, active, sheet, order } of core.rules(core.sheets(scope))) {
      if (sheet.owner !== "atelier" || !active) continue;
      const props = new Map<string, Decl>();
      for (let i = 0; i < r.style.length; i++) {
        const name = r.style[i];
        props.set(name, { value: r.style.getPropertyValue(name).trim(), important: r.style.getPropertyPriority(name) === "important" });
      }
      if (props.size) ours.push({ file: sheet.label.replace(/^.*atelier: /, ""), selector, parts: core.splitTop(selector), order, scope, props });
    }
  }
  type Hit = { r: Ours; spec: number[] };
  const byElement = new Map<Element, Hit[]>();
  for (const r of ours) {
    let els: Element[];
    try {
      els = core.queryAll(r.selector, r.scope).filter((el) => el.getRootNode() === r.scope);
    } catch {
      continue; // pseudo-elements and the like
    }
    for (const el of els.slice(0, 2000)) {
      const matching = r.parts.filter((p) => {
        try {
          return el.matches(p);
        } catch {
          return false;
        }
      });
      const hits = byElement.get(el) ?? [];
      hits.push({ r, spec: maxSpecificity(matching.map(specificity)) });
      byElement.set(el, hits);
    }
  }
  const beats = (a: Hit, b: Hit, p: string) => {
    const [ia, ib] = [a.r.props.get(p)!.important, b.r.props.get(p)!.important];
    if (ia !== ib) return ia;
    for (let i = 0; i < 3; i++) if (a.spec[i] !== b.spec[i]) return a.spec[i] > b.spec[i];
    return a.r.order > b.r.order;
  };
  // Per declaration (rule and property): the elements its rule matches, and
  // on how many of them another of our rules overrides it, and with what.
  type Tally = { r: Ours; property: string; matched: number; lost: number; by: Map<Ours, number>; example?: Element };
  const tallies = new Map<string, Tally>();
  const tally = (r: Ours, p: string) => {
    const key = `${r.order}\n${r.file}\n${p}`;
    let t = tallies.get(key);
    if (!t) tallies.set(key, (t = { r, property: p, matched: 0, lost: 0, by: new Map() }));
    return t;
  };
  for (const [el, hits] of byElement) {
    for (const h of hits) for (const p of h.r.props.keys()) tally(h.r, p).matched++;
    if (hits.length < 2) continue;
    for (const p of new Set(hits.flatMap((h) => [...h.r.props.keys()]))) {
      const setting = hits.filter((h) => h.r.props.has(p));
      if (setting.length < 2) continue;
      const win = setting.reduce((a, b) => (beats(b, a, p) ? b : a));
      for (const h of setting) {
        if (h === win || h.r.props.get(p)!.value === win.r.props.get(p)!.value) continue;
        const t = tally(h.r, p);
        t.lost++;
        t.by.set(win.r, (t.by.get(win.r) ?? 0) + 1);
        t.example ??= el;
      }
    }
  }
  const lost = [...tallies.values()].filter((t) => t.lost);
  const dead = lost
    .filter((t) => t.lost === t.matched)
    .sort((a, b) => b.matched - a.matched)
    .map((t) => {
      const by = [...t.by.entries()].sort((a, b) => b[1] - a[1])[0][0];
      return {
        property: t.property,
        overridden: { file: t.r.file, selector: t.r.selector, value: t.r.props.get(t.property)!.value },
        by: { file: by.file, selector: by.selector, value: by.props.get(t.property)!.value },
        elements: t.matched,
        example: core.describe(t.example!),
      };
    });
  return { total: dead.length, clashes: dead.slice(0, limit), partlyOverridden: lost.length - dead.length };
}

/** Acts on an element the way a person's input would (the same events, in
 * the same order, though untrusted), waits for the page to settle, and says
 * what came up: elements added or shown since, top-most first (a menu, a
 * dialog, a popover portalled to the end of <body>). */
export async function interact(selector: string, action: string, key: string | null, waitMs: number) {
  const el = core.query(selector, false)[0];
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
  const init = (type: string) => ({
    bubbles: !type.endsWith("enter"),
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type.endsWith("down") ? 1 : 0,
    detail: type === "click" ? 1 : 0,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
  const pointer = (t: string) => el.dispatchEvent(new PointerEvent(t, init(t)));
  const mouse = (t: string) => el.dispatchEvent(new MouseEvent(t, init(t)));
  const focusedBefore = core.activeElement();
  const recorder = core.recordChanges();
  const hover = () => {
    pointer("pointerover");
    pointer("pointerenter");
    mouse("mouseover");
    mouse("mouseenter");
    pointer("pointermove");
    mouse("mousemove");
  };
  switch (action) {
    case "hover":
      hover();
      break;
    case "click":
      hover();
      pointer("pointerdown");
      mouse("mousedown");
      (el as HTMLElement).focus?.({ focusVisible: false } as FocusOptions);
      pointer("pointerup");
      mouse("mouseup");
      mouse("click");
      break;
    case "focus":
      (el as HTMLElement).focus?.({ focusVisible: true } as FocusOptions);
      break;
    case "press": {
      if (!key) return { error: "`press` needs `key`, e.g. Enter, Escape, ArrowDown or a letter" };
      (el as HTMLElement).focus?.();
      const k = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true };
      el.dispatchEvent(new KeyboardEvent("keydown", k));
      el.dispatchEvent(new KeyboardEvent("keyup", k));
      break;
    }
    default:
      return { error: `\`action\` must be click, hover, focus or press (got \`${action}\`)` };
  }
  // Until the page has been quiet for a moment, or waitMs. A background tab's
  // timers run about once a second (the page's, and this wait's), so a menu
  // opened after a short delay needs a little over that to show.
  const start = performance.now();
  const least = Math.min(waitMs, document.visibilityState === "hidden" ? 1100 : 200);
  while (performance.now() - start < waitMs && (performance.now() - start < least || recorder.quietFor() < 300)) {
    await new Promise((res) => setTimeout(res, 100));
  }
  // Overlays are listed even when they can't be seen yet (still fading in,
  // placed off-screen): they're what was asked for, and the result says why.
  const overlay = (e: Element) => e.matches(":popover-open, dialog[open], [role=dialog], [role=menu], [role=listbox], [role=tooltip]");
  const visible = (e: Element) => {
    if (e === el || e.contains(el) || !e.getClientRects().length) return false;
    const rect = box(e);
    if (rect.width < 2 || rect.height < 2) return false;
    if (overlay(e)) return true;
    const cs = getComputedStyle(e);
    return cs.visibility === "visible" && cs.display !== "none" && Number(cs.opacity) > 0 && e.getAttribute("aria-hidden") !== "true";
  };
  const shown = recorder.stop().filter((e) => e.isConnected && !["STYLE", "SCRIPT", "LINK", "META"].includes(e.tagName) && visible(e));
  // Top-most only: a menu, not each of its items.
  const set = new Set(shown);
  const top = shown.filter((e) => {
    for (let p = core.up(e); p; p = core.up(p)) if (set.has(p)) return false;
    return true;
  });
  const focusedAfter = core.activeElement();
  return {
    action,
    target: core.describe(el),
    ...(el.hasAttribute("aria-expanded") ? { expanded: el.getAttribute("aria-expanded") === "true" } : {}),
    ...(focusedAfter && focusedAfter !== focusedBefore ? { focused: core.describe(focusedAfter) } : {}),
    appeared: top.slice(0, 8).map((e) => {
      const b = box(e);
      const why = unseen(e, b);
      const role = e.getAttribute("role") ?? (e.tagName === "DIALOG" ? "dialog" : null);
      const label = e.getAttribute("aria-label");
      const text = ((e as HTMLElement).innerText ?? e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      return {
        element: core.describe(e),
        ...(role ? { role } : {}),
        ...(label ? { label } : {}),
        ...(text ? { text } : {}),
        rect: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
        ...(why ? { unseen: why } : {}),
      };
    }),
    ...(top.length > 8 ? { more: top.length - 8 } : {}),
  };
}

/** A colour as #rrggbb, or #rrggbbaa if it isn't opaque; null for one that
 * doesn't parse. Through a canvas, which reads every syntax the page can
 * use (oklch(), color-mix(), names) the way the browser does. */
const toHex = (() => {
  let ctx: OffscreenCanvasRenderingContext2D | undefined;
  const cache = new Map<string, string | null>();
  return (colour: string): string | null => {
    let out = cache.get(colour);
    if (out !== undefined) return out;
    ctx ??= new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#010203";
    ctx.fillStyle = colour;
    const parsed = ctx.fillStyle !== "#010203" || /^#010203$/i.test(colour.trim());
    if (!parsed) out = null;
    else {
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      out = `#${[r, g, b, ...(a < 255 ? [a] : [])].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    }
    cache.set(colour, out);
    return out;
  };
})();

/** Where an element's value for a property comes from: its inline style,
 * the rule that wins for it (with the token it uses, if it uses one), or
 * for colour, the ancestor it inherits from. */
function declaredBy(el: Element, property: string): Record<string, string> {
  const names = [property, ...shorthandsOf(property)];
  const inline = (el as HTMLElement).style;
  const own = inline && names.find((n) => inline.getPropertyValue(n));
  if (own) return { from: "inline style attribute", declaration: `${own}: ${inline.getPropertyValue(own)}` };
  type Best = { selector: string; sheet: string; declaration: string; value: string; important: boolean; spec: number[]; order: number };
  let best: Best | null = null;
  for (const { rule: r, selector, active, sheet, order } of core.rules(core.sheets(el.getRootNode() as core.Scope))) {
    if (!active) continue;
    const name = names.find((n) => r.style.getPropertyValue(n));
    if (!name) continue;
    const parts = core.splitTop(selector).filter((p) => {
      try {
        return el.matches(p);
      } catch {
        return false;
      }
    });
    if (!parts.length) continue;
    const hit = {
      selector,
      sheet: sheet.label,
      declaration: `${name}: ${r.style.getPropertyValue(name)}`,
      value: r.style.getPropertyValue(name),
      important: r.style.getPropertyPriority(name) === "important",
      spec: maxSpecificity(parts.map(specificity)),
      order,
    };
    const wins = (a: Best, b: Best) => {
      if (a.important !== b.important) return a.important;
      for (let i = 0; i < 3; i++) if (a.spec[i] !== b.spec[i]) return a.spec[i] > b.spec[i];
      return a.order > b.order;
    };
    if (!best || wins(hit, best)) best = hit;
  }
  if (best) {
    const token = /var\(\s*(--[\w-]+)/.exec(best.value)?.[1];
    return { from: `${best.selector} (${best.sheet})`, declaration: best.declaration, ...(token ? { token } : {}) };
  }
  if (property === "color") {
    const value = getComputedStyle(el).color;
    let origin: Element = el;
    for (let p = core.up(el); p && getComputedStyle(p).color === value; p = core.up(p)) origin = p;
    if (origin !== el) return { inheritedFrom: core.describe(origin, 1, 3), ...declaredBy(origin, property) };
  }
  return { from: "the browser's defaults" };
}

/** The colours a page draws with (text, backgrounds, borders, SVG fills and
 * strokes), each with how often, an example, and where it's declared; with
 * a palette, only those not in it. For sites without design tokens, where
 * colours are spread over atomic classes and inline styles, and for
 * finding a site's colours left over after styling. */
export function colourScan(scope: string | null, palette: string[] | null, tolerance: number, limit: number) {
  const root = scope ? core.query(scope, false)[0] : document.body;
  if (!root) return null;
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const swatches = (palette ?? []).map((c) => ({ c, hex: toHex(c) }));
  const unparsed = swatches.filter((s) => !s.hex).map((s) => s.c);
  const near = (hex: string) =>
    swatches.some((s) => s.hex && rgb(s.hex).every((v, i) => Math.abs(v - rgb(hex)[i]) <= tolerance));
  type Group = { kind: string; colour: string; count: number; examples: Element[]; property: string };
  const groups = new Map<string, Group>();
  let checked = 0;
  const add = (kind: string, property: string, value: string, el: Element) => {
    const hex = toHex(value);
    if (!hex || hex.length === 9 && hex.endsWith("00")) return; // unparsed, or transparent
    const key = `${kind} ${hex}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { kind, colour: hex, count: 0, examples: [], property }));
    g.count++;
    if (g.examples.length < 2) g.examples.push(el);
  };
  for (const [el] of core.elements(root).slice(0, 20000)) {
    if (el.closest("[data-atelier-extra], style, script, head, noscript, template")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility !== "visible" || Number(cs.opacity) === 0) continue;
    checked++;
    // Text colour where there's text of the element's own, not on every container that passes it down.
    if ([...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())) add("text", "color", cs.color, el);
    add("background", "background-color", cs.backgroundColor, el);
    for (const side of ["top", "right", "bottom", "left"]) {
      if (parseFloat(cs.getPropertyValue(`border-${side}-width`)) > 0 && !/none|hidden/.test(cs.getPropertyValue(`border-${side}-style`))) {
        add("border", `border-${side}-color`, cs.getPropertyValue(`border-${side}-color`), el);
      }
    }
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) {
      for (const p of ["fill", "stroke"]) {
        const v = cs.getPropertyValue(p);
        if (v && v !== "none" && !v.startsWith("url(")) add(p, p, v, el);
      }
    }
  }
  const all = [...groups.values()].sort((a, b) => b.count - a.count);
  const listed = palette ? all.filter((g) => !near(g.colour)) : all;
  return {
    checked,
    ...(palette ? { inPalette: all.length - listed.length, offPalette: listed.length } : { colours: all.length }),
    ...(unparsed.length ? { unparsedPalette: unparsed } : {}),
    groups: listed.slice(0, limit).map((g) => ({
      kind: g.kind,
      colour: g.colour,
      count: g.count,
      example: core.describe(g.examples[0]),
      ...(g.examples[1] ? { alsoOn: core.describe(g.examples[1]) } : {}),
      declared: declaredBy(g.examples[0], g.property),
    })),
    ...(listed.length > limit ? { note: `${listed.length} in all; showing the most used. Narrow with scope, or raise limit.` } : {}),
  };
}
