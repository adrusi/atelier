// Spike R5: does <meta name="darkreader-lock">, added the way atelier's style
// shim would add it, keep Dark Reader off a page? See ../RESULTS.md.
//
// The user script below stands in for the style shim (spike R1): on pages
// loaded with ?lock=start it appends the lock to <html> at document_start,
// before <head> exists.

const port = browser.runtime.connectNative("atelier_dev");
const log = (event, params = {}) => port.postMessage({ jsonrpc: "2.0", method: `spike/${event}`, params });

function lockAtStart() {
  if (!/[?&]lock=start\b/.test(location.search)) return;
  const meta = document.createElement("meta");
  meta.name = "darkreader-lock";
  document.documentElement.append(meta);
}

async function registerUserScripts() {
  try {
    await browser.userScripts.unregister();
    await browser.userScripts.register([
      { id: "lock", matches: ["<all_urls>"], js: [{ code: `(${lockAtStart})();` }], runAt: "document_start", world: "USER_SCRIPT" },
    ]);
    log("userscripts-registered");
  } catch (e) {
    log("userscripts-failed", { error: String(e) });
  }
}

browser.permissions.onAdded.addListener((p) => {
  if (p.permissions?.includes("userScripts")) registerUserScripts();
});

browser.runtime.onInstalled.addListener(async () => {
  log("installed", { userScripts: Boolean(browser.userScripts) });
  if (browser.userScripts) await registerUserScripts();
  else browser.tabs.create({ url: browser.runtime.getURL("grant.html") });
});
