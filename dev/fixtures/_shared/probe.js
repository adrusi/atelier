// Probe for style-injection tests. Load it synchronously in <head>, and list
// the probe names on <html>:
//
//   <html data-probes="a b c"> ... <script src="/_shared/probe.js"></script>
//
// For each name X, a test stylesheet is expected to set, on <html>:
//   --atelier-probe-X: 1          (the style is applied at all)
//   --atelier-cascade-X: ext      (competing with the page's own `html` rule,
//                                  which sets it to "page", at equal specificity)
// window.__probe.firstFrame is a snapshot taken in the first animation frame,
// i.e. just before first paint; window.__probe.now() takes a fresh one.
// CSP violations and any data-atelier-* attributes on <html> are recorded too.

(() => {
  const root = document.documentElement;
  const names = (root.dataset.probes || "").split(/\s+/).filter(Boolean);

  const snapshot = () => {
    const style = getComputedStyle(root);
    const probes = {};
    for (const n of names) {
      probes[n] = {
        applied: style.getPropertyValue(`--atelier-probe-${n}`).trim() === "1",
        cascade: style.getPropertyValue(`--atelier-cascade-${n}`).trim() || null,
      };
    }
    const attrs = {};
    for (const a of root.attributes) if (a.name.startsWith("data-atelier")) attrs[a.name] = a.value;
    return { probes, attrs };
  };

  const probe = { firstFrame: null, firstFrameMs: null, violations: [], now: snapshot };
  window.__probe = probe;
  document.addEventListener("securitypolicyviolation", (e) =>
    probe.violations.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample }),
  );
  requestAnimationFrame(() => {
    probe.firstFrame = snapshot();
    probe.firstFrameMs = performance.now();
  });
})();
