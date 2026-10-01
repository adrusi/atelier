// Spike R2: making one tab render as light or dark without changing the rest
// of the browser. See ../RESULTS.md.
//
// Per-tab emulation: a tab opts in by setting sessionStorage["atelier-scheme"]
// to "light" or "dark". sessionStorage is scoped to the tab (and origin) and
// readable synchronously at document_start, so the user scripts below know at
// once whether they're in an emulating tab.
//
// Global override: navigating any tab to #global-dark or #global-reset sets or
// clears browserSettings.overrideContentColorScheme.

const port = browser.runtime.connectNative("atelier_dev");
const log = (event, params = {}) => port.postMessage({ jsonrpc: "2.0", method: `spike/${event}`, params });

// Page world: make matchMedia agree with the forced scheme.
function emulateMatchMedia() {
  const forced = sessionStorage.getItem("atelier-scheme");
  if (!forced) return;
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
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

// User-script world: rewrite prefers-color-scheme conditions in stylesheets
// and media attributes, and force color-scheme on the root.
function emulateStyles() {
  const root = document.documentElement;
  const forced = sessionStorage.getItem("atelier-scheme");
  root.setAttribute("data-atelier-marker", forced ?? "none");
  if (!forced) return;

  const TRUE = "(min-width: 0px)";
  const FALSE = "(max-width: 0px) and (min-width: 1px)";
  const fix = (text) =>
    text.replace(/\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/g, (_, s) => (s === forced ? TRUE : FALSE));

  const rewriteRules = (rules) => {
    for (const rule of rules) {
      if (rule.media && /prefers-color-scheme/.test(rule.media.mediaText)) rule.media.mediaText = fix(rule.media.mediaText);
      if (rule.cssRules) rewriteRules(rule.cssRules);
    }
  };
  // Cross-origin sheets can't be read through the CSSOM, even from here. Fetch
  // the text with the extension's privileges (via the background), insert a
  // rewritten copy right after the original, and disable the original.
  // Relative url()s are made absolute against the sheet's own URL.
  const replaced = new Set();
  const replaceCrossOrigin = async (sheet) => {
    const href = sheet.href;
    replaced.add(href);
    try {
      const text = await browser.runtime.sendMessage({ fetchCss: href });
      if (typeof text !== "string") throw new Error(String(text?.error ?? "no text"));
      const absolute = text.replace(/url\(\s*(['"]?)(?!data:|[a-z]+:\/\/|\/\/)([^'")]+)\1\s*\)/gi, (_, q, u) => `url(${q}${new URL(u, href)}${q})`);
      const copy = document.createElement("style");
      copy.textContent = fix(absolute);
      copy.setAttribute("data-atelier-copy-of", href);
      sheet.ownerNode.after(copy);
      sheet.disabled = true;
      report[href] = "replaced with rewritten copy";
    } catch (e) {
      report[href] = `copy failed: ${e}`;
    }
    root.setAttribute("data-atelier-rewrite", JSON.stringify(report));
  };

  const report = {};
  const rewriteAll = () => {
    for (const sheet of document.styleSheets) {
      if (replaced.has(sheet.href) || sheet.ownerNode?.hasAttribute?.("data-atelier-copy-of")) continue;
      try {
        rewriteRules(sheet.cssRules);
        report[sheet.href ?? "inline"] = "ok";
      } catch (e) {
        if (e.name === "SecurityError" && sheet.href) replaceCrossOrigin(sheet);
        else report[sheet.href ?? "inline"] = String(e);
      }
    }
    for (const el of document.querySelectorAll("link[media], source[media], style[media]")) {
      if (/prefers-color-scheme/.test(el.media)) el.media = fix(el.media);
    }
    root.setAttribute("data-atelier-rewrite", JSON.stringify(report));
  };

  const style = document.createElement("style");
  style.textContent = `:root { color-scheme: ${forced} !important; }`;
  root.append(style);

  new MutationObserver((records) => {
    for (const r of records)
      for (const n of r.addedNodes) {
        if (n.nodeName === "LINK") n.addEventListener("load", rewriteAll);
        if (n.nodeName === "STYLE" || n.nodeName === "SOURCE" || n.nodeName === "LINK") rewriteAll();
      }
  }).observe(document, { childList: true, subtree: true });
  document.addEventListener("DOMContentLoaded", rewriteAll);
  addEventListener("load", rewriteAll);
}

// User scripts in the USER_SCRIPT world can message the background once the
// world allows it. The background fetches with the extension's host
// permissions, so CORS doesn't apply.
// (onUserScriptMessage only exists once the userScripts permission is granted.)
function onUserScriptMessage(msg, sender, sendResponse) {
  if (!msg?.fetchCss) return;
  fetch(msg.fetchCss)
    .then((r) => r.text())
    .then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
}
function listenToUserScripts() {
  const event = browser.runtime.onUserScriptMessage;
  if (event && !event.hasListener(onUserScriptMessage)) event.addListener(onUserScriptMessage);
}
listenToUserScripts();

async function registerUserScripts() {
  try {
    await browser.userScripts.configureWorld({ messaging: true });
    listenToUserScripts();
    await browser.userScripts.unregister();
    await browser.userScripts.register([
      { id: "main", matches: ["<all_urls>"], js: [{ code: `(${emulateMatchMedia})();` }], runAt: "document_start", world: "MAIN" },
      { id: "styles", matches: ["<all_urls>"], js: [{ code: `(${emulateStyles})();` }], runAt: "document_start", world: "USER_SCRIPT" },
    ]);
    log("userscripts-registered");
  } catch (e) {
    log("userscripts-failed", { error: String(e) });
  }
}

browser.tabs.onUpdated.addListener(async (tabId, info) => {
  const action = info.url?.match(/#global-(dark|reset)$/)?.[1];
  if (!action) return;
  try {
    if (action === "dark") await browser.browserSettings.overrideContentColorScheme.set({ value: "dark" });
    else await browser.browserSettings.overrideContentColorScheme.clear({});
    log("global", { action, now: await browser.browserSettings.overrideContentColorScheme.get({}) });
  } catch (e) {
    log("global-failed", { action, error: String(e) });
  }
});

browser.permissions.onAdded.addListener((p) => {
  if (p.permissions?.includes("userScripts")) registerUserScripts();
});

browser.runtime.onInstalled.addListener(async () => {
  log("installed", { userScripts: Boolean(browser.userScripts) });
  if (browser.userScripts) await registerUserScripts();
  else browser.tabs.create({ url: browser.runtime.getURL("grant.html") });
});
