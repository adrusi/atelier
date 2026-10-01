// Spike R3: can the extension screenshot tabs that aren't visible, and how
// accurate is the result? Navigating a tab to a URL ending in #capture-LABEL
// makes this script inject a style into it, capture it with tabs.captureTab
// (and captureVisibleTab when it's the active tab), sample the fixture's boxes,
// and log the result to the native host. See ../RESULTS.md.

const port = browser.runtime.connectNative("atelier_dev");
const log = (event, params = {}) => port.postMessage({ jsonrpc: "2.0", method: `spike/${event}`, params });

// Box centres in dev/fixtures/capture.
const POINTS = {
  background: [5, 5],
  static: [70, 70],
  timer: [190, 70],
  raf: [310, 70],
  injected: [430, 70],
  lazy: [550, 70],
  late: [670, 70],
  raf30: [790, 70],
  anim: [910, 70],
};

async function sample(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const colours = {};
  for (const [name, [x, y]] of Object.entries(POINTS)) colours[name] = [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)].join(",");
  return { width: img.width, height: img.height, colours };
}

async function attempt(f) {
  const t = performance.now();
  try {
    const result = await sample(await f());
    return { ok: true, ms: Math.round(performance.now() - t), ...result };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

browser.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const label = info.url?.match(/#capture-(.+)$/)?.[1];
  if (!label) return;
  await browser.scripting.insertCSS({ target: { tabId }, css: "#injected { background: rgb(200,200,0) !important; }" });
  // "settle" labels fast-forward CSS animations and transitions to their end first.
  if (label.includes("settle")) {
    await browser.scripting.executeScript({
      target: { tabId },
      func: () => document.getAnimations().forEach((a) => { try { a.finish(); } catch {} }),
    });
  }
  await new Promise((r) => setTimeout(r, 300));
  const result = {
    label,
    tab: { active: tab.active, discarded: tab.discarded, status: tab.status, windowId: tab.windowId },
    captureTab: await attempt(() => browser.tabs.captureTab(tabId)),
  };
  if (tab.active) result.captureVisibleTab = await attempt(() => browser.tabs.captureVisibleTab(tab.windowId));
  log("captured", result);
});
