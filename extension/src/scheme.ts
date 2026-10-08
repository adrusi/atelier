// Per-tab colour-scheme emulation (spike R2; SPEC §10): one agent tab renders
// as light or dark without touching the rest of the browser, so agents can
// check a style's other scheme without changing the user's site settings.
//
// A tab opts in with a sessionStorage marker, readable synchronously at
// document_start. These functions run as source text (registered as user
// scripts, or injected), so each is self-contained.

/** The sessionStorage key holding "light" or "dark" in an emulating tab. */
export const SCHEME_MARKER = "atelier:scheme";

/** Page world: make matchMedia agree with the forced scheme, so the page's
 * own scripts see it from their first line. */
export function emulateMatchMedia() {
  let forced: string | null = null;
  try {
    forced = sessionStorage.getItem("atelier:scheme");
  } catch {
    return;
  }
  if (!forced) return;
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

/** userScripts world: rewrite prefers-color-scheme conditions in every
 * stylesheet and media attribute (atelier's own styles included), copy and
 * rewrite cross-origin sheets the CSSOM won't expose, and force color-scheme
 * on the root (light-dark(), form controls, scrollbars). */
export function emulateStyles() {
  let forced: string | null = null;
  try {
    forced = sessionStorage.getItem("atelier:scheme");
  } catch {
    return;
  }
  const root = document.documentElement;
  if (!forced || !root || root.hasAttribute("data-atelier-scheme")) return;
  root.setAttribute("data-atelier-scheme", forced);
  // The marker is the page's; the background has the truth. A tab that
  // shouldn't be emulating (a copy of an agent tab) drops it and reloads.
  void (browser.runtime.sendMessage({ type: "scheme" }) as Promise<string | null>).then(
    (wanted) => {
      if (wanted === forced) return;
      try {
        sessionStorage.removeItem("atelier:scheme");
      } catch {}
      location.reload();
    },
    () => {},
  );

  const TRUE = "(min-width: 0px)";
  const FALSE = "(max-width: 0px) and (min-width: 1px)";
  const fix = (text: string) =>
    text.replace(/\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/g, (_, s) => (s === forced ? TRUE : FALSE));
  const rewriteRules = (rules: CSSRuleList) => {
    for (const rule of rules as any) {
      if (rule.media && /prefers-color-scheme/.test(rule.media.mediaText)) rule.media.mediaText = fix(rule.media.mediaText);
      if (rule.cssRules) rewriteRules(rule.cssRules);
    }
  };
  const copied = new Set<string>();
  const copyCrossOrigin = async (sheet: CSSStyleSheet) => {
    const href = sheet.href!;
    copied.add(href);
    try {
      const text = (await browser.runtime.sendMessage({ type: "fetch-css", href })) as string | null;
      if (typeof text !== "string" || !text) return;
      const absolute = text.replace(
        /url\(\s*(['"]?)(?!data:|[a-z]+:\/\/|\/\/)([^'")]+)\1\s*\)/gi,
        (_, q, u) => `url(${q}${new URL(u, href)}${q})`,
      );
      const copy = document.createElement("style");
      copy.textContent = fix(absolute);
      copy.setAttribute("data-atelier-scheme-copy", href);
      (sheet.ownerNode as Element).after(copy);
      sheet.disabled = true;
    } catch {
      // Left as it is: that sheet won't follow the emulated scheme.
    }
  };
  const rewriteAll = () => {
    for (const sheet of document.styleSheets) {
      if ((sheet.href && copied.has(sheet.href)) || (sheet.ownerNode as Element | null)?.hasAttribute?.("data-atelier-scheme-copy")) continue;
      try {
        rewriteRules(sheet.cssRules);
      } catch (e) {
        if ((e as Error).name === "SecurityError" && sheet.href) void copyCrossOrigin(sheet);
      }
    }
    for (const el of document.querySelectorAll<HTMLLinkElement | HTMLSourceElement | HTMLStyleElement>("link[media], source[media], style[media]")) {
      if (/prefers-color-scheme/.test(el.media)) el.media = fix(el.media);
    }
  };
  const force = document.createElement("style");
  force.setAttribute("data-atelier-scheme-force", "");
  force.textContent = `:root { color-scheme: ${forced} !important; }`;
  root.append(force);
  // New or changed stylesheets (including atelier's, whose text changes on save).
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.target.nodeName === "STYLE") return rewriteAll();
      for (const n of r.addedNodes) {
        if (n.nodeName === "LINK") n.addEventListener("load", rewriteAll);
        if (n.nodeName === "STYLE" || n.nodeName === "SOURCE" || n.nodeName === "LINK") return rewriteAll();
      }
    }
  }).observe(document, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", rewriteAll);
  addEventListener("load", rewriteAll);
  rewriteAll();
}
