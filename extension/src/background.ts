// Background script. For now it only holds the connection to the native host
// and reports its own lifecycle to it, which is what spike R4 needs: whether
// Firefox suspends an MV3 background while a native port is open (SPEC §16).

declare const ATELIER_NATIVE_HOST: string;

const startedAt = Date.now();
let port: browser.runtime.Port | undefined;

function notify(method: string, params: object) {
  port?.postMessage({ jsonrpc: "2.0", method, params: { ...params, at: Date.now() } });
}

function connect() {
  port = browser.runtime.connectNative(ATELIER_NATIVE_HOST);
  port.onMessage.addListener((msg) => console.debug("atelier: from host", msg));
  port.onDisconnect.addListener((p) => {
    console.warn("atelier: native host disconnected", p.error?.message);
    port = undefined;
  });
  notify("extension/hello", { startedAt });
}

// Event-page listeners have to be registered synchronously at the top level.
browser.runtime.onInstalled.addListener((details) => notify("extension/installed", { reason: details.reason }));
browser.runtime.onStartup.addListener(() => notify("extension/startup", {}));
browser.runtime.onSuspend.addListener(() =>
  notify("extension/suspending", { startedAt, uptimeMs: Date.now() - startedAt }),
);

connect();
