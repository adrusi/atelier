// The page model (ARCHITECTURE.md, "The page model"): scopes, sheets, rules
// and elements. This is the only module in the page runtime that reaches into
// the page's structure directly (styleSheets, adoptedStyleSheets, shadow
// roots, cssRules); everything else asks it, so a feature built on it covers
// shadow roots and cross-origin stylesheets without having to remember them.
// `npm run check` fails if anything else does (check-layering.ts).

export type Scope = Document | ShadowRoot;

// ---------------------------------------------------------------------------
// Scopes

/** The open shadow root of an element. Closed ones can't be reached from the
 * userScripts world (no openOrClosedShadowRoot there), and aren't counted:
 * nothing tells them apart from an element without one. */
export const shadowRootOf = (el: Element): ShadowRoot | null => el.shadowRoot;
const shadowOf = shadowRootOf;

/** Every scope under `from` (the document by default): itself, if it's a
 * scope, and every open shadow root, nested to any depth, in tree order. */
export function scopes(from: Scope | Element = document): Scope[] {
  const out: Scope[] = from instanceof Element ? [] : [from];
  const visit = (root: ParentNode) => {
    for (const el of root.querySelectorAll("*")) {
      const shadow = shadowOf(el);
      if (shadow) {
        out.push(shadow);
        visit(shadow);
      }
    }
  };
  if (from instanceof Element) {
    const own = shadowOf(from);
    if (own) {
      out.push(own);
      visit(own);
    }
  }
  visit(from);
  return out;
}

/** Every element under `from` across scopes, with the scope it's in. */
export function elements(from: Scope | Element = document): [Element, Scope][] {
  const out: [Element, Scope][] = [];
  const visit = (root: ParentNode, scope: Scope) => {
    for (const el of root.querySelectorAll("*")) {
      out.push([el, scope]);
      const shadow = shadowOf(el);
      if (shadow) visit(shadow, shadow);
    }
  };
  if (from instanceof Element) {
    const scope = from.getRootNode() as Scope;
    out.push([from, scope]);
    const own = shadowOf(from);
    if (own) visit(own, own);
    visit(from, scope);
  } else visit(from, from);
  return out;
}

/** Text nodes with content under `from`, across scopes. */
export function* textNodes(from: Scope | Element = document): Generator<Text> {
  const roots: Node[] = from instanceof Document ? [from.body ?? from.documentElement] : [from];
  for (const s of scopes(from)) if (s !== from && !(s instanceof Document)) roots.push(s);
  for (const root of roots) {
    if (!root) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) yield n as Text;
  }
}

/** The element's parent, crossing from the top of a shadow tree to its host. */
export const up = (el: Element): Element | null => el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);

/** The scope's root element to append things to. */
export const rootOf = (scope: Scope): ParentNode => (scope instanceof Document ? scope.documentElement : scope);

/** "x-card > x-icon" for the hosts an element is inside, or "". */
export function hostPath(el: Element | Scope): string {
  const hosts: string[] = [];
  for (let root = el instanceof Element ? el.getRootNode() : el; root instanceof ShadowRoot; root = root.host.getRootNode()) {
    hosts.unshift(root.host.tagName.toLowerCase());
  }
  return hosts.join(" >>> ");
}

/** A short CSS-ish path to the element, prefixed with its shadow hosts. */
export function describe(el: Element, depth = 3, classes = 2): string {
  const parts: string[] = [];
  for (let e: Element | null = el; e && parts.length < depth; e = e.parentElement) {
    let p = e.tagName.toLowerCase();
    if (e.id) p += `#${e.id}`;
    for (const c of [...e.classList].slice(0, classes)) p += `.${c}`;
    parts.unshift(p);
  }
  const hosts = hostPath(el);
  return (hosts ? `${hosts} >>> ` : "") + parts.join(" > ");
}

/** Elements matching a selector. `host >>> inner` (chainable) looks for
 * `inner` inside the open shadow root of each `host`. */
export function query(selector: string, all = true): Element[] {
  const parts = selector.split(">>>").map((p) => p.trim());
  let roots: Scope[] = [document];
  for (let i = 0; i < parts.length; i++) {
    const found: Element[] = [];
    for (const root of roots) found.push(...root.querySelectorAll(parts[i]));
    if (i === parts.length - 1) return all ? found : found.slice(0, 1);
    roots = found.map(shadowOf).filter((r): r is ShadowRoot => r !== null);
  }
  return [];
}

/** The first element matching `selector` in any scope, document first. */
export function find(selector: string): Element | null {
  if (selector.includes(">>>")) return query(selector, false)[0] ?? null;
  for (const scope of scopes()) {
    const hit = scope.querySelector(selector);
    if (hit) return hit;
  }
  return null;
}

/** Elements matching `selector` in `scope` and the scopes nested in it. */
export function queryAll(selector: string, scope: Scope = document): Element[] {
  return scopes(scope).flatMap((s) => [...s.querySelectorAll(selector)]);
}

/** Calls `onChange` (once per batch, in a microtask) whenever any scope's
 * content changes: elements added or removed, style text changed, a shadow
 * root appearing as a component is defined, and at DOMContentLoaded and
 * load. A microtask, not a timer: background tabs (agent tabs among them)
 * throttle timers to a second or more. */
export function watch(onChange: () => void) {
  watchers.push(onChange);
  if (watchers.length === 1) {
    document.addEventListener("DOMContentLoaded", changed, { once: true });
    addEventListener("load", changed, { once: true });
  }
  observeAll();
}

const watchers: (() => void)[] = [];
const observed = new WeakSet<Node>();
const awaited = new Set<string>();
let pending = false;

function changed() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    observeAll();
    for (const w of watchers) w();
  });
}

function observeAll() {
  const root = document.documentElement;
  if (!root) return;
  for (const scope of scopes()) {
    const target = scope instanceof Document ? root : scope;
    if (observed.has(target)) continue;
    observed.add(target);
    new MutationObserver(changed).observe(target, { childList: true, subtree: true, characterData: true });
    // A <link>'s sheet arrives when it loads, after the element did.
    target.addEventListener("load", (e) => (e.target as Element).tagName === "LINK" && changed(), true);
  }
  // Components usually attach their shadow root when they're defined, which
  // no observer sees: wait for each undefined custom element's definition.
  for (const el of queryAll(":not(:defined)")) {
    const tag = el.tagName.toLowerCase();
    if (awaited.has(tag)) continue;
    awaited.add(tag);
    customElements.whenDefined(tag).then(changed, () => {});
  }
}

// ---------------------------------------------------------------------------
// Sheets

/** A stylesheet the page can't read through the CSSOM, fetched by the
 * extension (whose host permissions aren't bound by CORS). */
export type Fetched = { href: string; media: string; text: string };

export type Sheet = {
  scope: Scope;
  /** For people: the URL, `<style>`, `adopted`, or which of atelier's. */
  label: string;
  /** Whose it is: the page's, one of atelier's styles, force_state's
   * clones, or the page's but read from a copy the extension fetched. */
  owner: "page" | "atelier" | "forced" | "fetched";
  href: string | null;
  /** The sheet's own media condition (a <link media>, say), or "". */
  media: string;
  /** Its rules, or null if it can't be read. */
  rules: CSSRuleList | null;
  /** The element that brought it in (absent for adopted sheets). */
  node: Element | null;
  css: CSSStyleSheet;
};

const copies = new Map<string, CSSStyleSheet | null>();

/** Gives the page copies of sheets it couldn't read, so `sheets()` lists
 * them in their place. Copies are kept for the page's lifetime. */
export function provideFetched(fetched: Fetched[]) {
  for (const f of fetched) {
    if (copies.has(f.href)) continue;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(f.text);
      copies.set(f.href, sheet);
    } catch {
      copies.set(f.href, null);
    }
  }
}

function readable(css: CSSStyleSheet): CSSRuleList | null {
  try {
    return css.cssRules;
  } catch {
    return null;
  }
}

/** A scope's stylesheets, in cascade order: its <style> and <link> sheets,
 * then adopted sheets. A sheet the page can't read is replaced by the
 * extension's copy where there is one (`provideFetched`). */
export function sheets(scope: Scope): Sheet[] {
  const out: Sheet[] = [];
  const prefix = scope instanceof ShadowRoot ? `${hostPath(scope)} >>> ` : "";
  for (const css of [...scope.styleSheets, ...scope.adoptedStyleSheets]) {
    const node = (css.ownerNode as Element | null) ?? null;
    const atelier = node?.getAttribute?.("data-atelier");
    const forced = node?.getAttribute?.("data-atelier-force");
    const media = css.media?.mediaText ?? "";
    let rules = readable(css);
    let owner: Sheet["owner"] = atelier ? "atelier" : forced ? "forced" : "page";
    let label = atelier
      ? `atelier: ${atelier}`
      : forced
        ? `atelier: force_state clones (${forced})`
        : (css.href ?? (node ? `<${node.tagName.toLowerCase()}>` : "adopted"));
    if (!rules && css.href) {
      const copy = copies.get(css.href);
      if (copy) {
        rules = copy.cssRules;
        owner = "fetched";
        label = `${css.href} (fetched: cross-origin)`;
      }
    }
    out.push({ scope, label: prefix + label, owner, href: css.href, media, rules, node, css });
  }
  return out;
}

/** Every scope's sheets. A sheet shared by many scopes (one adopted sheet in
 * every instance of a component, or the same <style> text in each) is
 * listed once, for the first scope it's in. */
export function allSheets(from: Scope | Element = document): Sheet[] {
  const seen = new Set<CSSStyleSheet>();
  const texts = new Set<string>();
  const out: Sheet[] = [];
  for (const scope of scopes(from)) {
    for (const s of sheets(scope)) {
      if (seen.has(s.css)) continue;
      seen.add(s.css);
      if (scope instanceof ShadowRoot && s.node?.tagName === "STYLE") {
        const key = `${hostPath(scope)}\n${s.node.textContent}`;
        if (texts.has(key)) continue;
        texts.add(key);
      }
      out.push(s);
    }
  }
  return out;
}

/** Stylesheets that can't be read through the CSSOM and have no copy yet. */
export function unreadableSheets(): { href: string; media: string }[] {
  const out = new Map<string, string>();
  for (const s of allSheets()) if (!s.rules && s.href && !copies.has(s.href)) out.set(s.href, s.media);
  return [...out].map(([href, media]) => ({ href, media }));
}

// ---------------------------------------------------------------------------
// Rules

/** A style rule, flattened out of its sheet: its selector made absolute
 * (CSS nesting resolved against its parents), the conditions it's under, and
 * whether they hold now. */
export type Rule = {
  /** The rule (a CSSStyleRule, or bare declarations nested in one). */
  rule: CSSRule & { style: CSSStyleDeclaration };
  /** Whether it has a selector of its own (nested bare declarations don't). */
  own: boolean;
  selector: string;
  /** "@media (x) @layer y", or "". */
  context: string;
  /** Whether every condition holds now (container queries count as holding). */
  active: boolean;
  /** The sheet it's in (an @import's own sheet for imported rules). */
  sheet: Sheet;
  /** Its position in the walk, for "later wins". */
  order: number;
};

/** Splits a selector list at its top-level commas. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A nested rule's selector, made absolute: & is the parent; without &, it's a descendant. */
const resolve = (sel: string, parent: string | null) =>
  parent === null
    ? sel
    : splitTop(sel)
        .map((part) => (part.includes("&") ? part.replaceAll("&", `:is(${parent})`) : `:is(${parent}) ${part}`))
        .join(", ");

const matchesMedia = (media: string) => !media || matchMedia(media).matches;

/** The condition a grouping rule adds, and whether it holds. */
function conditionOf(r: any): { text: string; holds: boolean } {
  const kind = (r.constructor?.name ?? "").replace(/^CSS|Rule$/g, "");
  if (r.media) return { text: `@media ${r.media.mediaText}`, holds: matchesMedia(r.media.mediaText) };
  if (kind === "LayerBlock") return { text: `@layer ${r.name}`, holds: true };
  if (r.conditionText !== undefined) {
    let holds = true;
    if (kind === "Supports") {
      try {
        holds = CSS.supports(r.conditionText);
      } catch {
        // Left as holding if the condition can't be evaluated.
      }
    }
    return { text: `@${kind.toLowerCase()} ${r.conditionText}`, holds };
  }
  return { text: `@${kind.toLowerCase()}`, holds: true };
}

/** What `rules()` couldn't read: @imported sheets it couldn't open. */
export type Unread = string[];

/** Every style rule in the sheets, in order. Unreadable sheets and imports
 * are added to `unread` (by label) rather than skipped silently. */
export function* rules(list: Sheet[], unread: Unread = []): Generator<Rule> {
  let order = 0;
  function* visit(ruleList: CSSRuleList, context: string, active: boolean, sheet: Sheet, parent: string | null): Generator<Rule> {
    for (const r of ruleList as any) {
      order++;
      if (r.styleSheet && r.href !== undefined) {
        // @import: the imported sheet's rules count as the importing sheet's scope's.
        const media = r.media?.mediaText ?? "";
        const imported = readable(r.styleSheet);
        const label = r.styleSheet.href ?? r.href;
        if (!imported) {
          unread.push(label);
          continue;
        }
        const c = [context, `@import${media ? ` ${media}` : ""}`].filter(Boolean).join(" ");
        yield* visit(imported, c, active && matchesMedia(media), { ...sheet, label, href: label, rules: imported, css: r.styleSheet }, null);
      } else if (r.style && (r.selectorText !== undefined || parent !== null)) {
        // A style rule, possibly nested; or bare declarations after nested rules, which are the parent's.
        const own = r.selectorText !== undefined;
        const selector = own ? resolve(r.selectorText, parent) : parent!;
        yield { rule: r, own, selector, context, active, sheet, order };
        if (own && r.cssRules?.length) yield* visit(r.cssRules, context, active, sheet, selector);
      } else if (r.cssRules) {
        const c = conditionOf(r);
        yield* visit(r.cssRules, [context, c.text].filter(Boolean).join(" "), active && c.holds, sheet, parent);
      }
    }
  }
  for (const sheet of list) {
    if (!sheet.rules) {
      unread.push(sheet.label);
      continue;
    }
    const context = sheet.media ? `@media ${sheet.media}` : "";
    yield* visit(sheet.rules, context, matchesMedia(sheet.media), sheet, null);
  }
}

/** Rules with a media condition (@media, and @import with media), in readable
 * sheets, for rewriting conditions (the emulation layer). */
export function* mediaRules(list: Sheet[]): Generator<CSSRule & { media: MediaList }> {
  function* visit(ruleList: CSSRuleList): Generator<CSSRule & { media: MediaList }> {
    for (const r of ruleList as any) {
      if (r.media) yield r;
      if (r.styleSheet) {
        const imported = readable(r.styleSheet);
        if (imported) yield* visit(imported);
      }
      if (r.cssRules) yield* visit(r.cssRules);
    }
  }
  for (const s of list) if (s.rules && s.owner !== "fetched") yield* visit(s.rules);
}

/** Elements whose media attribute picks styles or sources, in every scope. */
export function mediaElements(): (HTMLLinkElement | HTMLSourceElement | HTMLStyleElement)[] {
  return queryAll("link[media], source[media], style[media]") as (HTMLLinkElement | HTMLSourceElement | HTMLStyleElement)[];
}

/** Restores shorthands where the CSSOM serialises only empty longhands (a
 * var() shorthand mixed with overriding longhands). */
export const SHORTHANDS = [
  "background", "border", "border-top", "border-right", "border-bottom", "border-left", "border-block",
  "border-inline", "border-color", "border-radius", "outline", "font", "margin", "padding", "inset",
  "text-decoration", "column-rule", "list-style", "transition", "animation", "box-shadow", "gap",
];

export function declarations(style: CSSStyleDeclaration): string {
  const text = style.cssText;
  if (!/:\s*;/.test(text)) return text;
  const restored = SHORTHANDS.map((sh) => [sh, style.getPropertyValue(sh)]).filter(([, v]) => v).map(([sh, v]) => `${sh}: ${v};`);
  return `${text.replace(/[\w-]+:\s*;\s*/g, "")} ${restored.join(" ")}`.trim();
}
