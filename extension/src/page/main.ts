// The page-world half of the emulation layer (emulation.ts): makes the
// page's own scripts see the emulated media features, from their first
// line: matchMedia evaluates emulated features as the stylesheets do, and an
// emulated viewport size is what innerWidth, innerHeight, the root's
// clientWidth and clientHeight, and visualViewport report. Kept minimal, as
// it runs in the page's own world on every page; it reads the same marker.

import { EMULATION_MARKER } from "./markers";
import { type Features, forThisFrame, mentions, rewriteMedia } from "./media";

let features: Features | null = null;
try {
  features = JSON.parse(sessionStorage.getItem(EMULATION_MARKER) ?? "null");
} catch {
  // Storage blocked, or no marker: nothing to emulate.
}
let framed = true;
try {
  framed = window.top !== window;
} catch {
  // A cross-origin parent: a frame.
}
features = forThisFrame(features && typeof features === "object" ? features : null, framed);
if (features) {
  const f = features;
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => original(mentions(query, f) ? rewriteMedia(query, f) : query);
  if (f.width !== undefined && f.height !== undefined) {
    const { width, height } = f;
    const getter = (target: object, name: string, value: number) => {
      try {
        Object.defineProperty(target, name, { get: () => value, configurable: true });
      } catch {
        // Not redefinable here; scripts see the real value.
      }
    };
    for (const name of ["innerWidth", "outerWidth"]) getter(window, name, width);
    for (const name of ["innerHeight", "outerHeight"]) getter(window, name, height);
    const root = document.documentElement;
    if (root) {
      getter(root, "clientWidth", width);
      getter(root, "clientHeight", height);
    }
    if (window.visualViewport) {
      getter(window.visualViewport, "width", width);
      getter(window.visualViewport, "height", height);
    }
  }
}
