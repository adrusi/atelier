// Spike R1: candidate ways of getting a stylesheet into a page (see
// ../RESULTS.md). Each strategy X sets --atelier-probe-X and
// --atelier-cascade-X on <html>, which the fixtures' probe.js reads.

// Holding a native port keeps this background resident (spike R4), as the
// real extension will. Log lines go to the stub host's log.
const port = browser.runtime.connectNative("atelier_dev");
const log = (event, params = {}) => port.postMessage({ jsonrpc: "2.0", method: `spike/${event}`, params });

const css = (name) => `html { --atelier-probe-${name}: 1; --atelier-cascade-${name}: ext; }`;

// --- S1 and S2: user scripts, which accept code strings, so the CSS can be
// embedded at registration time and applied synchronously at document_start.

// S1: a <style> element, kept as the last child of <html> so it wins ties
// with the page's own stylesheets, and put back if something removes it.
function injectStyle(name, text) {
  const root = document.documentElement;
  const el = document.createElement("style");
  el.textContent = text;
  el.setAttribute("data-atelier", name);
  const off = () => root.hasAttribute(`data-atelier-off-${name}`);
  root.append(el);
  new MutationObserver(() => {
    if (off()) el.remove();
    else if (!el.isConnected || el.nextSibling) root.append(el);
  }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: [`data-atelier-off-${name}`] });
}

// S2: a constructed stylesheet in document.adoptedStyleSheets.
function adoptSheet(name, text) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch (e) {
    document.documentElement.setAttribute(`data-atelier-error-${name}`, String(e));
  }
}

async function registerUserScripts() {
  if (!browser.userScripts) return log("userscripts-unavailable");
  try {
    await browser.userScripts.unregister();
    await browser.userScripts.register([
      {
        id: "s1",
        matches: ["<all_urls>"],
        js: [{ code: `(${injectStyle})("s1", ${JSON.stringify(css("s1"))});` }],
        runAt: "document_start",
        world: "USER_SCRIPT",
      },
      {
        id: "s2",
        matches: ["<all_urls>"],
        js: [{ code: `(${adoptSheet})("s2", ${JSON.stringify(css("s2"))});` }],
        runAt: "document_start",
        world: "USER_SCRIPT",
      },
    ]);
    log("userscripts-registered");
  } catch (e) {
    log("userscripts-failed", { error: String(e) });
  }
}

// --- S3: scripting.insertCSS when a navigation commits, as author (S3) and
// user (S3u) origin. Per-tab and invisible to the page, but asynchronous.
browser.webNavigation.onCommitted.addListener(async ({ tabId, frameId, url }) => {
  if (frameId !== 0 || !url.startsWith("http")) return;
  for (const [name, origin] of [["s3", "AUTHOR"], ["s3u", "USER"]]) {
    browser.scripting
      .insertCSS({ target: { tabId }, css: css(name), origin })
      .catch((e) => log("insertcss-failed", { name, error: String(e) }));
  }
});

// --- S4: a packaged CSS file registered as a content script. Synchronous and
// invisible to the page, but the CSS can't be dynamic. The baseline.
// --- S5: Firefox's contentScripts.register, which accepts CSS code, if MV3 has it.
async function registerStatic() {
  try {
    await browser.scripting.unregisterContentScripts();
    await browser.scripting.registerContentScripts([
      { id: "s4", matches: ["<all_urls>"], css: ["s4.css"], runAt: "document_start" },
    ]);
    log("s4-registered");
  } catch (e) {
    log("s4-failed", { error: String(e) });
  }
  if (!browser.contentScripts?.register) return log("s5-unavailable");
  try {
    await browser.contentScripts.register({ matches: ["<all_urls>"], css: [{ code: css("s5") }], runAt: "document_start" });
    log("s5-registered");
  } catch (e) {
    log("s5-failed", { error: String(e) });
  }
}

// --- Per-tab removal: navigating a tab to a URL ending in #remove removes
// every strategy's styles in that tab only.
browser.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url?.endsWith("#remove")) return;
  const results = {};
  const attempt = async (name, f) => {
    try {
      await f();
      results[name] = "ok";
    } catch (e) {
      results[name] = String(e);
    }
  };
  await attempt("s1", () =>
    browser.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.setAttribute("data-atelier-off-s1", ""),
    }),
  );
  await attempt("s2", async () => {
    const [r] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        const keep = [...document.adoptedStyleSheets].filter(
          (s) => ![...s.cssRules].some((r) => r.cssText.includes("--atelier-probe-s2")),
        );
        document.adoptedStyleSheets = keep;
        return document.adoptedStyleSheets.length;
      },
    });
    if (r.error) throw r.error;
  });
  for (const [name, origin] of [["s3", "AUTHOR"], ["s3u", "USER"]]) {
    await attempt(name, () => browser.scripting.removeCSS({ target: { tabId }, css: css(name), origin }));
  }
  log("removed", { tabId, results });
});

browser.permissions.onAdded.addListener((p) => {
  if (p.permissions?.includes("userScripts")) registerUserScripts();
});

browser.runtime.onInstalled.addListener(async () => {
  log("installed", { userScripts: Boolean(browser.userScripts), contentScripts: Boolean(browser.contentScripts) });
  await registerStatic();
  if (browser.userScripts) await registerUserScripts();
  else browser.tabs.create({ url: browser.runtime.getURL("grant.html") });
});
