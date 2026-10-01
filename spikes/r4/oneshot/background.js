// R4 variant "oneshot" (the control): no persistent port. Each lifecycle event
// is logged with a one-shot sendNativeMessage, which runs the host only for the
// duration of that call.
const startedAt = Date.now();
const log = (method, params = {}) =>
  browser.runtime
    .sendNativeMessage("atelier_dev", { jsonrpc: "2.0", method, params: { ...params, variant: "oneshot", startedAt, at: Date.now() } })
    .catch((e) => console.error("atelier spike: log failed", e));

browser.runtime.onInstalled.addListener((d) => log("extension/installed", { reason: d.reason }));
browser.runtime.onSuspend.addListener(() => log("extension/suspending"));
browser.tabs.onCreated.addListener(() => log("extension/tab-created"));
log("extension/hello");
