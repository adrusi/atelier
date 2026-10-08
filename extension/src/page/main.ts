// The page-world half of the emulation layer (emulation.ts): makes the
// page's own scripts see the emulated media features through matchMedia,
// from their first line. Kept minimal, as it runs in the page's own world on
// every page; it reads the same marker as the rest.

import { SCHEME_MARKER } from "./markers";

let forced: string | null = null;
try {
  forced = sessionStorage.getItem(SCHEME_MARKER);
} catch {
  // Storage blocked: nothing to emulate.
}
if (forced) {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => {
    const mql = original(query);
    const m = /prefers-color-scheme\s*:\s*(light|dark)/.exec(query);
    if (!m) return mql;
    const matches = m[1] === forced;
    return new Proxy(mql, {
      get(target, prop) {
        if (prop === "matches") return matches;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}
