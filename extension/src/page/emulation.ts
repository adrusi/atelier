// The emulation layer (ARCHITECTURE.md, "Media features"; spike R2; SPEC
// §10): one agent tab renders as if some media features had other values,
// without touching the rest of the browser. Emulated features are a set
// (`prefers-color-scheme` now; `width` and others to come), applied to every
// scope through core: conditions in readable sheets are rewritten, sheets
// the page can't read are replaced by rewritten copies, and media attributes
// are rewritten. The page-world half (main.ts) makes matchMedia agree.
//
// A tab opts in with a sessionStorage marker (markers.ts), readable
// synchronously at document_start, which holds the emulated features.

import * as core from "./core";
import { SCHEME_MARKER } from "./markers";

/** Emulated media features and their values. */
export type Features = { "prefers-color-scheme"?: "light" | "dark" };

const TRUE = "(min-width: 0px)";
const FALSE = "(max-width: 0px) and (min-width: 1px)";

/** A media query's text with each emulated feature's test replaced by one
 * that's always true or always false. */
export function rewrite(text: string, features: Features): string {
  return text.replace(/\(\s*([a-z-]+)\s*:\s*([a-z-]+)\s*\)/g, (whole, name: string, value: string) => {
    const emulated = features[name as keyof Features];
    if (emulated === undefined) return whole;
    return value === emulated ? TRUE : FALSE;
  });
}

const mentions = (text: string, features: Features) => Object.keys(features).some((f) => text.includes(f));

/** The features the tab's marker asks for, if any. */
export function fromMarker(): Features | null {
  let scheme: string | null = null;
  try {
    scheme = sessionStorage.getItem(SCHEME_MARKER);
  } catch {
    return null;
  }
  return scheme === "light" || scheme === "dark" ? { "prefers-color-scheme": scheme } : null;
}

let started = false;

/** Applies the marker's emulation to the page, and keeps applying it as
 * stylesheets and shadow roots come and go. Does nothing without a marker. */
export function start() {
  const features = fromMarker();
  const root = document.documentElement;
  if (!features || !root || started) return;
  started = true;
  const scheme = features["prefers-color-scheme"];
  if (scheme) root.setAttribute("data-atelier-scheme", scheme);
  // The marker is the page's; the background has the truth. A tab that
  // shouldn't be emulating (a copy of an agent tab) drops it and reloads.
  void (browser.runtime.sendMessage({ type: "scheme" }) as Promise<string | null>).then(
    (wanted) => {
      if (wanted === scheme) return;
      try {
        sessionStorage.removeItem(SCHEME_MARKER);
      } catch {}
      location.reload();
    },
    () => {},
  );

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
      copy.textContent = rewrite(absolute, features);
      copy.setAttribute("data-atelier-scheme-copy", href);
      sheet.node.after(copy);
      sheet.css.disabled = true;
    } catch {
      // Left as it is: that sheet won't follow the emulation.
    }
  };
  const apply = () => {
    for (const scope of core.scopes()) {
      const sheets = core.sheets(scope);
      for (const rule of core.mediaRules(sheets)) {
        const text = rule.media.mediaText;
        if (mentions(text, features)) rule.media.mediaText = rewrite(text, features);
      }
      for (const s of sheets) {
        // Unreadable (or read from the tools' copy, which isn't what the page renders).
        const unreadable = !s.rules || s.owner === "fetched";
        if (unreadable && s.href && !copied.has(s.href) && s.node) void copyCrossOrigin(s);
        // A sheet's own condition (<link media>, <style media>) is its node's attribute, below.
      }
    }
    for (const el of core.mediaElements()) {
      if (mentions(el.media, features)) el.media = rewrite(el.media, features);
    }
  };
  if (scheme) {
    // light-dark(), form controls and scrollbars follow color-scheme.
    const force = document.createElement("style");
    force.setAttribute("data-atelier-scheme-force", "");
    force.textContent = `:root { color-scheme: ${scheme} !important; }`;
    root.append(force);
  }
  core.watch(apply);
  apply();
}
