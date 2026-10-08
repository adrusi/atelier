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

/** The element's box in document coordinates, or null if nothing matches. */
export function rectOf(selector: string): { x: number; y: number; width: number; height: number } | null {
  const all = core.query(selector, true);
  if (!all.length) return null;
  // The first match that's actually showing: pages often keep hidden copies (templates, other breakpoints).
  const el = all.find((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; }) ?? all[0];
  const r = el.getBoundingClientRect();
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
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

/** Style rules that match an element, with specificity and conditions, most
 * specific first; ties are listed latest first, as later rules win. An
 * element inside a shadow root is styled by that root's sheets. */
export function matchedRules(selector: string, property: string | null, limit: number) {
  const el = core.query(selector, false)[0] ?? null;
  if (!el) return null;

  // Shorthands that can set `property`.
  const FONT = ["font-style", "font-variant", "font-weight", "font-stretch", "font-width", "font-size", "line-height", "font-family"];
  const setters = property
    ? core.SHORTHANDS.filter((sh) => property.startsWith(`${sh}-`) || (sh === "font" && FONT.includes(property)) ||
        (sh === "border" && /^border-(top|right|bottom|left)-(color|style|width)$/.test(property)) ||
        (sh === "inset" && /^(top|right|bottom|left)$/.test(property)))
    : [];

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
      const v = r.style.getPropertyValue(property);
      if (v) {
        declarations = `${property}: ${v}${r.style.getPropertyPriority(property) ? " !important" : ""}`;
        // Say so when it comes from a shorthand, which is easy to miss (font: … resets font-stretch).
        const via = setters.find((name) => r.style.getPropertyValue(name));
        if (via) declarations += ` (via ${via}: ${r.style.getPropertyValue(via)})`;
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
export function contrast(minRatio: number, limit: number) {
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
  return { checked, failing: failures.length, failures: failures.slice(0, limit), unknownBackground: unknown, skippedDisabled: disabled };
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
    const text = (el.textContent ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    const blocks: string[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === "{") {
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
