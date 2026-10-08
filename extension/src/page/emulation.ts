// The emulation layer (ARCHITECTURE.md, "Media features"; spike R2; SPEC
// §10): one agent tab renders as if some media features had other values,
// without touching the rest of the browser. Emulated features are a set
// (media.ts): the colour scheme, and the viewport's size. They're applied to
// every scope through core: media conditions in readable sheets are
// rewritten, sheets the page can't read are replaced by rewritten copies,
// and media attributes are rewritten. Each feature then adds what it needs
// beyond media queries: the colour scheme narrows the schemes a page
// offers; the viewport size sets the root's width and rewrites viewport
// units. The page-world half (main.ts) makes scripts agree.
//
// A tab opts in with a sessionStorage marker (markers.ts), readable
// synchronously at document_start, which holds the emulated features.

import * as core from "./core";
import { EMULATION_MARKER } from "./markers";
import { type Features, forThisFrame, mentions, rewriteMedia, rewriteMediaInCss } from "./media";

export type { Features };

/** Whether this document is in a frame. */
const inFrame = () => {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
};

/** The features the tab's marker asks this document to emulate, if any
 * (in a frame, only the colour scheme: forThisFrame). */
export function fromMarker(): Features | null {
  try {
    const f = JSON.parse(sessionStorage.getItem(EMULATION_MARKER) ?? "null") as Features | null;
    return forThisFrame(f && typeof f === "object" && Object.keys(f).length ? f : null, inFrame());
  } catch {
    return null;
  }
}

/** A comparable form of a feature set. */
export const canonical = (f: Features | null) =>
  JSON.stringify({ scheme: f?.["prefers-color-scheme"] ?? null, width: f?.width ?? null, height: f?.height ?? null });

/** A color-scheme value as the browser would use it under the emulated
 * preference: where the page offers both schemes ("light dark"), only the
 * preferred one; anything else ("light", "normal", "only dark") as it is.
 * The browser picks from what the page offers, so a page that doesn't offer
 * dark stays light under a dark preference. */
export function narrowScheme(value: string, scheme: "light" | "dark"): string {
  const words = value.trim().toLowerCase().split(/\s+/);
  if (!(words.includes("light") && words.includes("dark"))) return value;
  return words.includes("only") ? `only ${scheme}` : scheme;
}

/** CSS text with each color-scheme declaration narrowed (narrowScheme). */
export function narrowSchemeText(text: string, scheme: "light" | "dark"): string {
  return text.replace(/(color-scheme\s*:\s*)([^;}!]*)/gi, (_, head: string, value: string) => head + narrowScheme(value, scheme));
}

const VIEWPORT_UNIT = /(-?\d*\.?\d+)([sld]?)(vw|vh|vmin|vmax|vi|vb)\b/gi;

/** CSS text with viewport units (vw, vh, svh, dvw, vmin…) turned into
 * pixels of the emulated viewport. */
export function viewportUnits(text: string, width: number, height: number): string {
  return text.replace(VIEWPORT_UNIT, (_, n: string, _variant: string, unit: string) => {
    const u = unit.toLowerCase();
    const base = u === "vw" || u === "vi" ? width : u === "vh" || u === "vb" ? height : u === "vmin" ? Math.min(width, height) : Math.max(width, height);
    return `${Math.round(Number(n) * base * 100) / 10000}px`;
  });
}

let started = false;

/** Whether any selector in a list matches the root element. */
function matchesRoot(selector: string): boolean {
  return core.splitTop(selector).some((part) => {
    try {
      return document.documentElement.matches(part);
    } catch {
      return false;
    }
  });
}

/** Applies the marker's emulation to the page, and keeps applying it as
 * stylesheets and shadow roots come and go. Does nothing without a marker. */
export function start() {
  const features = fromMarker();
  const root = document.documentElement;
  if (!features || !root || started) return;
  started = true;
  const scheme = features["prefers-color-scheme"];
  const size = features.width !== undefined && features.height !== undefined ? { width: features.width, height: features.height } : null;
  if (scheme) root.setAttribute("data-atelier-scheme", scheme);
  if (size) {
    root.setAttribute("data-atelier-viewport", `${size.width}x${size.height}`);
    // The page lays out in the emulated width; what's right of it is empty.
    // The identity transform makes the root the containing block for
    // position: fixed elements, so they span the emulated width too.
    const style = document.createElement("style");
    style.setAttribute("data-atelier-emulation", "");
    style.textContent = `html { width: ${size.width}px !important; height: ${size.height}px !important; transform: scale(1); }`;
    root.append(style);
    // The userScripts world (where eval runs) has its own view of window:
    // the emulated size there too, as main.ts does for the page's world.
    const getter = (target: object, name: string, value: number) => {
      try {
        Object.defineProperty(target, name, { get: () => value, configurable: true });
      } catch {
        // Not redefinable here.
      }
    };
    for (const name of ["innerWidth", "outerWidth"]) getter(window, name, size.width);
    for (const name of ["innerHeight", "outerHeight"]) getter(window, name, size.height);
    getter(root, "clientWidth", size.width);
    getter(root, "clientHeight", size.height);
  }
  // The marker is the page's; the background has the truth. A tab that
  // shouldn't be emulating this (a copy of an agent tab) drops it and reloads.
  void (browser.runtime.sendMessage({ type: "emulation" }) as Promise<Features | null>).then(
    (wanted) => {
      if (canonical(forThisFrame(wanted, inFrame())) === canonical(features)) return;
      try {
        if (wanted) sessionStorage.setItem(EMULATION_MARKER, JSON.stringify(wanted));
        else sessionStorage.removeItem(EMULATION_MARKER);
      } catch {}
      location.reload();
    },
    () => {},
  );

  /** CSS text as the emulation wants it: media queries, schemes, units. */
  const rewriteCss = (css: string) => {
    let out = rewriteMediaInCss(css, features);
    if (scheme) out = narrowSchemeText(out, scheme);
    if (size) out = viewportUnits(out, size.width, size.height);
    return out;
  };

  const copied = new Set<string>();
  const copyCrossOrigin = async (sheet: core.Sheet) => {
    const href = sheet.href!;
    copied.add(href);
    try {
      const text = (await browser.runtime.sendMessage({ type: "fetch-css", href })) as string | null;
      if (typeof text !== "string" || !text || !sheet.node) return;
      const absolute = text.replace(
        /url\(\s*(['"]?)(?!data:|[a-z]+:\/\/|\/\/)([^'")]+)\1\s*\)/gi,
        (_, q, u) => `url(${q}${new URL(u, href)}${q})`,
      );
      const copy = document.createElement("style");
      copy.textContent = rewriteCss(absolute);
      copy.setAttribute("data-atelier-scheme-copy", href);
      sheet.node.after(copy);
      sheet.css.disabled = true;
    } catch {
      // Left as it is: that sheet won't follow the emulation.
    }
  };

  // Rewritten once each: rules keep their objects, so these mark what's done.
  const doneMedia = new WeakSet<MediaList>();
  const doneStyles = new WeakSet<CSSStyleDeclaration>();
  /** The root's percentage heights are of the viewport (the initial
   * containing block): turned into pixels of the emulated one. */
  const rootHeights = (style: CSSStyleDeclaration) => {
    for (const name of ["height", "min-height", "max-height"]) {
      const value = style.getPropertyValue(name);
      if (!value.includes("%")) continue;
      const rewritten = value.replace(/(-?\d*\.?\d+)%/g, (_, n: string) => `${Math.round(Number(n) * size!.height) / 100}px`);
      style.setProperty(name, rewritten, style.getPropertyPriority(name));
    }
  };
  const rewriteStyle = (style: CSSStyleDeclaration) => {
    if (scheme) {
      const value = style.getPropertyValue("color-scheme");
      const narrowed = value && narrowScheme(value, scheme);
      if (narrowed && narrowed !== value) style.setProperty("color-scheme", narrowed, style.getPropertyPriority("color-scheme"));
    }
    if (size && /\dv|\d[sld]v/i.test(core.declarations(style))) {
      // Longhands, custom properties, and shorthands written with var()
      // (whose longhands read as empty until computed).
      for (const name of new Set([...style, ...core.SHORTHANDS])) {
        const value = style.getPropertyValue(name);
        if (!value) continue;
        const rewritten = viewportUnits(value, size.width, size.height);
        if (rewritten !== value) style.setProperty(name, rewritten, style.getPropertyPriority(name));
      }
    }
  };

  const apply = () => {
    for (const scope of core.scopes()) {
      const sheets = core.sheets(scope);
      for (const rule of core.mediaRules(sheets)) {
        if (doneMedia.has(rule.media)) continue;
        doneMedia.add(rule.media);
        const text = rule.media.mediaText;
        if (mentions(text, features)) rule.media.mediaText = rewriteMedia(text, features);
      }
      for (const s of sheets) {
        // Unreadable (or read from the tools' copy, which isn't what the page renders).
        const unreadable = !s.rules || s.owner === "fetched";
        if (unreadable && s.href && !copied.has(s.href) && s.node) void copyCrossOrigin(s);
        // A sheet's own condition (<link media>, <style media>) is its node's attribute, below.
      }
      if (scheme || size) {
        for (const { rule, selector } of core.rules(sheets.filter((s) => s.owner !== "fetched"))) {
          if (doneStyles.has(rule.style)) continue;
          doneStyles.add(rule.style);
          rewriteStyle(rule.style);
          if (size && scope === document && matchesRoot(selector)) rootHeights(rule.style);
        }
      }
    }
    for (const el of core.mediaElements()) {
      if (mentions(el.media, features)) el.media = rewriteMedia(el.media, features);
    }
    // Inline styles: checked each time, as scripts set them.
    if (scheme) for (const el of core.queryAll("[style*='color-scheme' i]")) rewriteStyle((el as HTMLElement).style);
    if (size) for (const el of core.queryAll("[style*='vw' i], [style*='vh' i], [style*='vmin' i], [style*='vmax' i]")) rewriteStyle((el as HTMLElement).style);
    if (size) rootHeights(root.style);
    if (scheme) {
      for (const meta of core.queryAll("meta[name='color-scheme' i]")) {
        const content = meta.getAttribute("content") ?? "";
        const narrowed = narrowScheme(content, scheme);
        if (narrowed !== content) meta.setAttribute("content", narrowed);
      }
    }
  };
  core.watch(apply);
  apply();
  if (size) followScroll();
}

/** position: fixed elements are laid out in the root (the emulated
 * viewport at the top of the page), so on their own they'd scroll away with
 * it. While the page is scrolled, each is moved down by the scroll offset
 * (the translate property), which puts it where a real viewport would
 * hold it. Elements inside a container of the page's own that's already
 * their containing block (a transform, a filter, containment) never
 * followed the viewport, and are left alone. */
function followScroll() {
  let fixed: HTMLElement[] = [];
  let scanned = 0;
  const ownContainingBlock = (el: Element) => {
    for (let e = core.up(el); e && e !== document.documentElement; e = core.up(e)) {
      const cs = getComputedStyle(e);
      if (cs.transform !== "none" || cs.filter !== "none" || cs.perspective !== "none" || cs.backdropFilter !== "none" ||
        /paint|layout|strict|content/.test(cs.contain) || /transform|filter|perspective/.test(cs.willChange)) return true;
    }
    return false;
  };
  const scan = () => {
    scanned = performance.now();
    fixed = core
      .elements()
      .map(([el]) => el)
      .filter((el): el is HTMLElement => el instanceof HTMLElement && getComputedStyle(el).position === "fixed" && !ownContainingBlock(el));
    place();
  };
  const moved = new Set<HTMLElement>();
  /** The scroll offset fixed elements were last placed for. */
  let placedFor = 0;
  const place = () => {
    const y = window.scrollY;
    placedFor = y;
    for (const el of moved) if (!fixed.includes(el)) {
      el.style.removeProperty("translate");
      moved.delete(el);
    }
    for (const el of fixed) {
      if (y) {
        el.style.setProperty("translate", `0px ${y}px`, "important");
        moved.add(el);
      } else if (moved.delete(el)) el.style.removeProperty("translate");
    }
  };
  // Rescanned as the page changes, at most a few times a second.
  core.watch(() => {
    if (performance.now() - scanned > 300) scan();
    else setTimeout(scan, 300);
  });
  // Scroll events come with animation frames, which background tabs (agent
  // tabs) don't get: a timer too, and the screenshot tool syncs first.
  addEventListener("scroll", place, { passive: true });
  setInterval(() => window.scrollY !== placedFor && place(), 250);
  sync = place;
  scan();
}

/** Brings what emulation keeps up to date (fixed elements' places) up to
 * date now, for a screenshot. */
let sync = () => {};
export const syncNow = () => sync();
