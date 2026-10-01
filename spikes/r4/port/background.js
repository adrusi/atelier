// R4 variant "port": holds a native-messaging port open and never sends
// traffic after startup. Lifecycle events go over the port.
const startedAt = Date.now();
const port = browser.runtime.connectNative("atelier_dev");
const log = (method, params = {}) =>
  port.postMessage({ jsonrpc: "2.0", method, params: { ...params, variant: "port", startedAt, at: Date.now() } });

browser.runtime.onInstalled.addListener((d) => log("extension/installed", { reason: d.reason }));
browser.runtime.onSuspend.addListener(() => log("extension/suspending"));
browser.tabs.onCreated.addListener(() => log("extension/tab-created"));
log("extension/hello");
