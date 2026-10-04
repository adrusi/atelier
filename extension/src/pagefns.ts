// Functions that run inside a page for the browser tools (tools.ts), in the
// userScripts world via userScripts.execute: they see the page's DOM and
// CSSOM, but not its JavaScript globals, and the page's CSP doesn't apply.
//
// Each is sent as source text (`${fn}`), so it must be self-contained: no
// references to anything outside its own body, and no imports. Results must
// be plain JSON.

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
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
}

export function query(selector: string, limit: number, maxLength: number) {
  const describe = (el: Element) => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && parts.length < 4; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) p += `#${e.id}`;
      for (const c of [...e.classList].slice(0, 3)) p += `.${c}`;
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const els = [...document.querySelectorAll(selector)];
  return {
    count: els.length,
    elements: els.slice(0, limit).map((el) => {
      const html = el.outerHTML;
      return { path: describe(el), html: html.length > maxLength ? `${html.slice(0, maxLength)}…` : html };
    }),
  };
}

export function computed(selector: string, properties: string[] | null) {
  const el = document.querySelector(selector);
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

/** Custom properties defined by the page's stylesheets (following @import):
 * where, under which conditions, and where they're used; and which selectors
 * other than :root re-declare them (nested theme scopes, which undo :root
 * overrides inside them). */
export function tokens(filter: string | null, limit: number, usage: boolean, scope: string | null, verbose: boolean) {
  type Def = { selector: string; value: string; context?: string; sheet: string };
  const SHORTHANDS = [
    "background", "border", "border-top", "border-right", "border-bottom", "border-left", "border-block",
    "border-inline", "border-color", "border-radius", "outline", "font", "margin", "padding", "inset",
    "text-decoration", "column-rule", "list-style", "transition", "animation", "box-shadow", "gap",
  ];
  // A declaration block's text, with shorthands restored where the CSSOM can
  // only serialise their longhands as empty (a var() shorthand mixed with
  // overriding longhands).
  const declarations = (style: CSSStyleDeclaration): string => {
    const text = style.cssText;
    if (!/:\s*;/.test(text)) return text;
    const restored = SHORTHANDS.map((sh) => [sh, style.getPropertyValue(sh)]).filter(([, v]) => v).map(([sh, v]) => `${sh}: ${v};`);
    return `${text.replace(/[\w-]+:\s*;\s*/g, "")} ${restored.join(" ")}`.trim();
  };
  const defs = new Map<string, Def[]>();
  const uses = new Map<string, { count: number; examples: string[] }>();
  const scopes = new Map<string, number>();
  const unreadable: string[] = [];
  const contextOf = (r: any): string => {
    const kind = (r.constructor?.name ?? "").replace(/^CSS|Rule$/g, "");
    if (r.media) return `@media ${r.media.mediaText}`;
    if (kind === "LayerBlock") return `@layer ${r.name}`;
    if (r.conditionText !== undefined) return `@${kind.toLowerCase()} ${r.conditionText}`;
    return `@${kind.toLowerCase()}`;
  };
  const visit = (rules: CSSRuleList, context: string, sheet: string) => {
    for (const r of rules as any) {
      if (r.styleSheet && r.href !== undefined) {
        // @import: the imported sheet's rules count as the page's.
        const c = [context, `@import${r.media?.mediaText ? ` ${r.media.mediaText}` : ""}`].filter(Boolean).join(" ");
        try {
          visit(r.styleSheet.cssRules, c, r.styleSheet.href ?? sheet);
        } catch {
          unreadable.push(r.styleSheet?.href ?? r.href);
        }
      } else if (r.selectorText !== undefined && r.style) {
        const inScope = !scope || r.selectorText.includes(scope);
        for (let i = 0; i < r.style.length; i++) {
          const name: string = r.style[i];
          if (!inScope || !name.startsWith("--") || (filter && !name.includes(filter))) continue;
          const list = defs.get(name) ?? [];
          const value: string = r.style.getPropertyValue(name).trim();
          list.push({
            selector: r.selectorText,
            value: value.length > 100 ? `${value.slice(0, 100)}…` : value,
            ...(context ? { context } : {}),
            sheet,
          });
          defs.set(name, list);
          if (!/^\s*(:root|html)\b/.test(r.selectorText)) scopes.set(r.selectorText, (scopes.get(r.selectorText) ?? 0) + 1);
        }
        if (usage) {
          for (const m of declarations(r.style).matchAll(/var\(\s*(--[\w-]+)/g)) {
            const u = uses.get(m[1]) ?? { count: 0, examples: [] };
            u.count++;
            if (u.examples.length < 3 && !u.examples.includes(r.selectorText)) u.examples.push(r.selectorText.slice(0, 80));
            uses.set(m[1], u);
          }
        }
        if (r.cssRules?.length) visit(r.cssRules, context, sheet);
      } else if (r.cssRules) {
        visit(r.cssRules, [context, contextOf(r)].filter(Boolean).join(" "), sheet);
      }
    }
  };
  for (const s of [...document.styleSheets, ...document.adoptedStyleSheets]) {
    const owner = s.ownerNode as Element | null;
    if (owner?.getAttribute?.("data-atelier") || owner?.hasAttribute?.("data-atelier-force")) continue; // atelier's own
    const name = s.href ?? (owner ? `<${owner.tagName.toLowerCase()}>` : "adopted");
    try {
      visit(s.cssRules, "", name);
    } catch {
      unreadable.push(name);
    }
  }
  const names = [...defs.keys()].sort();
  // Compact by default: one string per definition, and stylesheets listed once.
  const sheets: string[] = [];
  const sheetIndex = (name: string) => {
    let i = sheets.indexOf(name);
    if (i < 0) i = sheets.push(name) - 1;
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
    ...(verbose ? {} : { sheets }),
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
          nested = [...document.querySelectorAll(selector)]
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
    unreadableSheets: unreadable,
  };
}

/** Style rules that match an element, with specificity and conditions, most
 * specific first; ties are listed latest first, as later rules win. */
export function matchedRules(selector: string, property: string | null, limit: number) {
  const el = document.querySelector(selector);
  if (!el) return null;

  const splitTop = (s: string): string[] => {
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
  };
  const add = (a: number[], b: number[]) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const max = (xs: number[][]) =>
    xs.reduce((m, x) => (x[0] > m[0] || (x[0] === m[0] && (x[1] > m[1] || (x[1] === m[1] && x[2] > m[2]))) ? x : m), [0, 0, 0]);
  const specificity = (sel: string): number[] => {
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
      if (m[1] !== "where") total = add(total, max(splitTop(inner).map(specificity)));
      s = `${s.slice(0, m.index)} ${s.slice(i)}`;
    }
    s = s.replace(/\[[^\]]*\]/g, () => ((total = add(total, [0, 1, 0])), " "));
    s = s.replace(/#[\w-]+/g, () => ((total = add(total, [1, 0, 0])), " "));
    s = s.replace(/\.[\w-]+/g, () => ((total = add(total, [0, 1, 0])), " "));
    s = s.replace(/::[\w-]+(\([^)]*\))?|:(before|after|first-line|first-letter)\b/g, () => ((total = add(total, [0, 0, 1])), " "));
    s = s.replace(/:[\w-]+(\([^)]*\))?/g, () => ((total = add(total, [0, 1, 0])), " "));
    s.replace(/(^|[\s>+~])([a-zA-Z][\w-]*)/g, (_, __, tag) => ((total = add(total, [0, 0, 1])), tag));
    return total;
  };

  const SHORTHANDS = [
    "background", "border", "border-top", "border-right", "border-bottom", "border-left", "border-block",
    "border-inline", "border-color", "border-radius", "outline", "font", "margin", "padding", "inset",
    "text-decoration", "column-rule", "list-style", "transition", "animation", "box-shadow", "gap",
  ];
  // Rule text, with shorthands restored where the CSSOM serialises only empty
  // longhands (a var() shorthand mixed with overriding longhands).
  const declarationsOf = (style: CSSStyleDeclaration): string => {
    const text = style.cssText;
    if (!/:\s*;/.test(text)) return text;
    const restored = SHORTHANDS.map((sh) => [sh, style.getPropertyValue(sh)]).filter(([, v]) => v).map(([sh, v]) => `${sh}: ${v};`);
    return `${text.replace(/[\w-]+:\s*;\s*/g, "")} ${restored.join(" ")}`.trim();
  };

  // Shorthands that can set `property`.
  const FONT = ["font-style", "font-variant", "font-weight", "font-stretch", "font-width", "font-size", "line-height", "font-family"];
  const setters = property
    ? SHORTHANDS.filter((sh) => property.startsWith(`${sh}-`) || (sh === "font" && FONT.includes(property)) ||
        (sh === "border" && /^border-(top|right|bottom|left)-(color|style|width)$/.test(property)) ||
        (sh === "inset" && /^(top|right|bottom|left)$/.test(property)))
    : [];

  type Hit = { selector: string; specificity: number[]; declarations: string; context?: string; active: boolean; sheet: string; order: number };
  const hits: Hit[] = [];
  let order = 0;
  const visit = (rules: CSSRuleList, context: string, active: boolean, sheet: string) => {
    for (const r of rules as any) {
      order++;
      if (r.styleSheet && r.href !== undefined) {
        // @import: the imported sheet's rules, under its media condition.
        const media = r.media?.mediaText;
        try {
          visit(
            r.styleSheet.cssRules,
            [context, `@import${media ? ` ${media}` : ""}`].filter(Boolean).join(" "),
            active && (!media || matchMedia(media).matches),
            r.styleSheet.href ?? sheet,
          );
        } catch {
          // Unreadable cross-origin import.
        }
      } else if (r.selectorText !== undefined && r.style) {
        const matching = splitTop(r.selectorText).filter((part) => {
          try {
            return el.matches(part);
          } catch {
            return false; // e.g. pseudo-elements
          }
        });
        if (!matching.length) continue;
        let declarations: string = declarationsOf(r.style);
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
          selector: r.selectorText,
          specificity: max(matching.map(specificity)),
          declarations: declarations.length > 400 ? `${declarations.slice(0, 400)}…` : declarations,
          ...(context ? { context } : {}),
          active,
          sheet,
          order,
        });
      } else if (r.cssRules) {
        let c = "";
        let a = active;
        if (r.media) {
          c = `@media ${r.media.mediaText}`;
          a = a && matchMedia(r.media.mediaText).matches;
        } else if (r.conditionText !== undefined) {
          c = `@${(r.constructor?.name ?? "").replace(/^CSS|Rule$/g, "").toLowerCase()} ${r.conditionText}`;
        } else if (r.name !== undefined) c = `@layer ${r.name}`;
        visit(r.cssRules, [context, c].filter(Boolean).join(" "), a, sheet);
      }
    }
  };
  for (const s of [...document.styleSheets, ...document.adoptedStyleSheets]) {
    const owner = s.ownerNode as Element | null;
    const atelier = owner?.getAttribute?.("data-atelier");
    const forced = owner?.getAttribute?.("data-atelier-force");
    const name = atelier
      ? `atelier: ${atelier}`
      : forced
        ? `atelier: force_state clones (${forced})`
        : (s.href ?? (owner ? `<${owner.tagName.toLowerCase()}>` : "adopted"));
    try {
      visit(s.cssRules, "", true, name);
    } catch {
      // Unreadable cross-origin sheet.
    }
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
    for (let p = el.parentElement; p && getComputedStyle(p).getPropertyValue(property) === value; p = p.parentElement) origin = p;
    if (origin !== el) {
      inheritedFrom = origin.tagName.toLowerCase() + (origin.id ? `#${origin.id}` : "") + [...origin.classList].slice(0, 3).map((c) => `.${c}`).join("");
    }
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
  };
}

/** Visible text whose contrast with its background is below the WCAG
 * threshold (3:1 for large text). Backgrounds are composited from the element
 * up; text over background images is counted as unknown, not checked. */
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
    for (let e: Element | null = el; e; e = e.parentElement) {
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
  const describe = (el: Element) => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && parts.length < 3; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) p += `#${e.id}`;
      for (const c of [...e.classList].slice(0, 2)) p += `.${c}`;
      parts.unshift(p);
    }
    return parts.join(" > ");
  };

  const seen = new Set<Element>();
  const failures: object[] = [];
  let checked = 0;
  let unknown = 0;
  let disabled = 0;
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
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
        element: describe(el),
        text: node.textContent.trim().slice(0, 60),
        color: hex(text),
        background: hex(bg),
        ratio: Math.round(ratio * 100) / 100,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
      });
    }
  }
  failures.sort((a: any, b: any) => a.ratio - b.ratio);
  return { checked, failing: failures.length, failures: failures.slice(0, limit), unknownBackground: unknown, skippedDisabled: disabled };
}

/** Forces pseudo-class states on an element, like devtools' "force element
 * state": every readable rule using one of the states is cloned with the
 * pseudo-class replaced by an attribute, which is then set on the element
 * (and its ancestors, for :hover, :active and :focus-within, which apply
 * there too). The clones come after all other styles, so at equal
 * specificity they can win slightly more often than the real state would.
 * An empty `states` clears everything forced. */
export function forceState(selector: string, states: string[]) {
  const KNOWN = ["hover", "active", "focus", "focus-visible", "focus-within"];
  const attr = (s: string) => `data-atelier-force-${s}`;
  document.querySelector("style[data-atelier-force]")?.remove();
  for (const s of KNOWN) for (const e of document.querySelectorAll(`[${attr(s)}]`)) e.removeAttribute(attr(s));
  if (!states.length) return { cleared: true };
  const unknown = states.filter((s) => !KNOWN.includes(s));
  if (unknown.length) return { error: `unknown states: ${unknown.join(", ")}; known: ${KNOWN.join(", ")}` };
  const el = document.querySelector(selector);
  if (!el) return null;

  const pattern = new RegExp(`:(${states.map((s) => s.replace(/-/g, "\\-")).join("|")})(?![\\w-])`, "g");
  const clones: string[] = [];
  const visit = (rules: CSSRuleList, wrap: (css: string) => string) => {
    for (const r of rules as any) {
      if (r.selectorText !== undefined && r.style) {
        pattern.lastIndex = 0;
        if (pattern.test(r.selectorText)) {
          const sel = r.selectorText.replace(pattern, (_: string, s: string) => `[${attr(s)}]`);
          clones.push(wrap(`${sel} { ${r.style.cssText} }`));
        }
      } else if (r.cssRules) {
        const head = r.media ? `@media ${r.media.mediaText}` : r.conditionText !== undefined ? `@supports ${r.conditionText}` : null;
        visit(r.cssRules, head ? (css) => wrap(`${head} { ${css} }`) : wrap);
      }
    }
  };
  for (const s of [...document.styleSheets, ...document.adoptedStyleSheets]) {
    try {
      visit(s.cssRules, (css) => css);
    } catch {
      // Unreadable cross-origin sheet.
    }
  }
  const propagate = new Set(["hover", "active", "focus-within"]);
  for (const s of states) {
    for (let e: Element | null = el; e; e = propagate.has(s) ? e.parentElement : null) e.setAttribute(attr(s), "");
  }
  // Some sites react to hover from JavaScript (mouseover), not CSS.
  if (states.includes("hover")) {
    for (const type of ["mouseover", "mouseenter", "pointerover", "pointerenter"]) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith("over"), composed: true }));
    }
  }
  const style = document.createElement("style");
  style.setAttribute("data-atelier-force", states.join(" "));
  style.textContent = clones.join("\n");
  document.documentElement.append(style);
  return { forced: states, rulesCloned: clones.length };
}

/** Waits (up to timeoutMs) for images to load and decode, so a screenshot
 * doesn't catch them blank. */
export async function imagesReady(timeoutMs: number) {
  const pending = [...document.images].map((img) =>
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
    if (document.querySelector(selector)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Fills a form field as typing would: focuses it, sets the value, and
 * dispatches input and change events, so scripts listening for input (search
 * suggestions, filters) respond. */
export function fill(selector: string, text: string, submit: boolean) {
  const el = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return null;
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
  return { value: el.value, focused: document.activeElement === el };
}
