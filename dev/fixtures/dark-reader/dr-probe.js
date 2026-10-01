// Reports whether Dark Reader is acting on this page. Dark Reader marks <html>
// with data-darkreader-mode, adds <style class="darkreader ..."> elements, and
// paints a .darkreader--fallback style immediately at document_start, before
// it has decided whether to apply.
const drState = () => ({
  mode: document.documentElement.getAttribute("data-darkreader-mode"),
  styles: document.querySelectorAll("style.darkreader").length,
  fallback: Boolean(document.querySelector(".darkreader--fallback")),
  lock: Boolean(document.querySelector('meta[name="darkreader-lock"]')),
  background: getComputedStyle(document.documentElement).backgroundColor,
});
window.__dr = { firstFrame: null, now: drState };
requestAnimationFrame(() => (window.__dr.firstFrame = drState()));
