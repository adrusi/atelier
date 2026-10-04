// Background script. It keeps a connection to the daemon through the native
// host (which also keeps this background resident; spike R4), fetches the
// bundle of compiled styles, and registers one user script per style that
// runs the page shim (shim.ts). When the bundle changes it updates the
// registrations and pushes the new bundle to pages that are already open.

import type { BlobChunk } from "./proto/BlobChunk";
import type { BlobRef } from "./proto/BlobRef";
import type { Bundle } from "./proto/Bundle";
import type { InitializeResult } from "./proto/InitializeResult";
import { cssFor } from "./matching";
import { Rpc } from "./rpc";
import * as tools from "./tools";
import { onUserScriptConnect, type UserScript, userScripts } from "./userscripts";

declare const ATELIER_NATIVE_HOST: string;
/** The compiled page shim, inlined by build.ts. */
declare const ATELIER_SHIM: string;

/** Must match atelier_proto::PROTOCOL_VERSION. */
const PROTOCOL_VERSION = 1;
/** Bytes per blob/get request; the daemon caps chunks at this anyway. */
const CHUNK = 512 * 1024;

export type State = {
  connection: "connecting" | "connected" | "disconnected";
  error?: string;
  atelierDir?: string;
  bundle?: Bundle;
  bundleHash?: string;
  needsPermission: boolean;
};

const state: State = { connection: "disconnected", needsPermission: !userScripts() };
let rpc: Rpc | null = null;
let retryDelay = 1000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------------------
// Connection to the daemon

async function connect() {
  clearTimeout(retryTimer);
  if (rpc) return;
  state.connection = "connecting";
  const { atelierDir } = (await browser.storage.local.get("atelierDir")) as { atelierDir?: string };
  const r = new Rpc(browser.runtime.connectNative(ATELIER_NATIVE_HOST));
  rpc = r;
  r.onClose = (error) => {
    if (rpc !== r) return;
    rpc = null;
    state.connection = "disconnected";
    state.error = error ?? state.error;
    scheduleReconnect();
  };
  r.onNotification = (method, params) => {
    if (method === "bundle/changed") void loadBundle(r, params as BlobRef);
  };
  // Browser tools, on behalf of agents (atelier mcp) and the CLI.
  r.onRequest = (method, params) =>
    tools.handle(method, params, {
      bundle: () => state.bundle,
      hasShim: (tabId) => [...shimPorts].some((p) => p.sender?.tab?.id === tabId),
      unmet: (tabId) => unmetByTab.get(tabId) ?? [],
    });
  try {
    const init = await r.call<InitializeResult>("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      role: "extension",
      ...(atelierDir ? { atelierDir } : {}),
    });
    state.connection = "connected";
    state.atelierDir = init.atelierDir;
    console.info(`atelier: connected to the daemon for ${init.atelierDir}`);
    state.error = undefined;
    retryDelay = 1000;
    await loadBundle(r, await r.call<BlobRef>("bundle/get"));
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    console.warn("atelier:", state.error);
    if (rpc === r) {
      rpc = null;
      state.connection = "disconnected";
      r.close();
      scheduleReconnect();
    }
  }
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60_000);
}

async function loadBundle(r: Rpc, ref: BlobRef) {
  if (ref.hash === state.bundleHash) return;
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await r.call<BlobChunk>("blob/get", { hash: ref.hash, offset, len: CHUNK });
    const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
    parts.push(bytes);
    offset += bytes.length;
    if (chunk.eof) break;
  }
  const blob = new Uint8Array(offset);
  let at = 0;
  for (const p of parts) {
    blob.set(p, at);
    at += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", blob));
  const hash = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  if (hash !== ref.hash) throw new Error(`bundle hash mismatch: expected ${ref.hash}, got ${hash}`);

  const bundle = JSON.parse(new TextDecoder().decode(blob)) as Bundle;
  state.bundle = bundle;
  state.bundleHash = hash;
  console.info(`atelier: bundle ${hash.slice(0, 12)}: ${bundle.styles.length} styles, ${bundle.diagnostics.length} diagnostics`);
  for (const d of bundle.diagnostics) {
    const place = d.path ? `${d.path}${d.line ? `:${d.line}` : ""}: ` : "";
    console.info(`atelier:   ${d.severity} ${place}${d.message}`);
  }
  await applyBundle(bundle);
}

// ---------------------------------------------------------------------------
// Applying styles

const scriptId = (styleId: string) => `style:${styleId}`;

async function applyBundle(bundle: Bundle) {
  const us = userScripts();
  state.needsPermission = !us;
  if (!us) {
    console.info("atelier: can't apply styles until the userScripts permission is granted");
    return;
  }

  await us.configureWorld({ messaging: true });
  listenToShims();

  const wanted: UserScript[] = bundle.styles.map((style) => ({
    id: scriptId(style.id),
    matches: style.patterns,
    js: [{ code: ATELIER_SHIM }, { code: `__atelier.add(${JSON.stringify(style)});` }],
    runAt: "document_start",
    world: "USER_SCRIPT",
  }));
  const existing = new Map((await us.getScripts()).map((s) => [s.id, s]));
  const wantedIds = new Set(wanted.map((s) => s.id));
  const removed = [...existing.keys()].filter((id) => !wantedIds.has(id));
  if (removed.length) await us.unregister({ ids: removed });
  // Only re-register what changed: an edit to one style shouldn't touch the rest.
  const same = (a: UserScript, b: UserScript) =>
    JSON.stringify([a.matches, a.js.map((j) => j.code)]) === JSON.stringify([b.matches, b.js.map((j) => j.code)]);
  const updates = wanted.filter((s) => existing.has(s.id) && !same(existing.get(s.id)!, s));
  if (updates.length) await us.update(updates);
  const added = wanted.filter((s) => !existing.has(s.id));
  if (added.length) await us.register(added);
  console.info(`atelier: user scripts: ${added.length} added, ${updates.length} updated, ${removed.length} removed`);

  for (const port of shimPorts) port.postMessage({ type: "bundle", styles: bundle.styles });
  await injectIntoOpenTabs(bundle);
}

/** Registered scripts only run on page loads, so pages that were already open
 * (when a style was added, or when the extension started) have no shim. Give
 * them one if some style now applies; it then gets live updates like any other. */
async function injectIntoOpenTabs(bundle: Bundle) {
  const us = userScripts();
  if (!us) return;
  const withShim = new Set([...shimPorts].map((p) => p.sender?.tab?.id));
  for (const tab of await browser.tabs.query({})) {
    if (tab.id === undefined || withShim.has(tab.id) || !tab.url || !/^(https?|file):/.test(tab.url)) continue;
    const url = tab.url;
    const styles = bundle.styles.filter((s) => cssFor(s, url) !== null);
    if (styles.length === 0) continue;
    try {
      await us.execute({
        target: { tabId: tab.id },
        js: [{ code: ATELIER_SHIM }, ...styles.map((s) => ({ code: `__atelier.add(${JSON.stringify(s)});` }))],
      });
    } catch (e) {
      // Restricted pages (e.g. addons.mozilla.org) refuse injection.
      console.debug(`atelier: couldn't inject into tab ${tab.id}:`, e);
    }
  }
}

// Pages running the shim connect back so they can get live updates.
const shimPorts = new Set<browser.runtime.Port>();

/** Prerequisites the page in each tab reported as unmet (SPEC §5.2). */
export type Unmet = { style: string; description: string };
const unmetByTab = new Map<number, Unmet[]>();

function setUnmet(tabId: number, unmet: Unmet[]) {
  if (unmet.length) unmetByTab.set(tabId, unmet);
  else unmetByTab.delete(tabId);
  void browser.action.setBadgeText({ tabId, text: unmet.length ? "!" : "" });
  if (unmet.length) void browser.action.setBadgeBackgroundColor({ tabId, color: "#fab387" });
}

function onShimConnect(port: browser.runtime.Port) {
  shimPorts.add(port);
  const tabId = port.sender?.tab?.id;
  port.onMessage.addListener((msg: any) => {
    if (msg?.type === "prerequisites" && tabId !== undefined && port.sender?.frameId === 0) setUnmet(tabId, msg.unmet ?? []);
  });
  port.onDisconnect.addListener(() => {
    shimPorts.delete(port);
    if (tabId !== undefined && port.sender?.frameId === 0) setUnmet(tabId, []);
  });
  // The page may have been registered from an older bundle.
  if (state.bundle) port.postMessage({ type: "bundle", styles: state.bundle.styles });
}

function listenToShims() {
  const event = onUserScriptConnect();
  if (event && !event.hasListener(onShimConnect)) event.addListener(onShimConnect);
}

function notifyUrlChange(details: { tabId: number; frameId: number }) {
  if (details.frameId !== 0) return;
  for (const port of shimPorts) {
    if (port.sender?.tab?.id === details.tabId) port.postMessage({ type: "url" });
  }
}

// ---------------------------------------------------------------------------
// Wiring. Listeners are registered synchronously, as event pages require.

browser.webNavigation.onHistoryStateUpdated.addListener(notifyUrlChange);
browser.webNavigation.onReferenceFragmentUpdated.addListener(notifyUrlChange);

browser.permissions.onAdded.addListener((p) => {
  if (!(p.permissions as string[] | undefined)?.includes("userScripts")) return;
  console.info("atelier: userScripts permission granted");
  if (state.bundle) void applyBundle(state.bundle);
});

browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install" && !userScripts()) {
    void browser.tabs.create({ url: browser.runtime.getURL("onboarding.html") });
  }
});

browser.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: string; tabId?: number };
  if (m?.type === "state") return Promise.resolve({ ...state, unmet: m.tabId === undefined ? [] : (unmetByTab.get(m.tabId) ?? []) });
  return undefined;
});

// If the background was suspended while disconnected, this wakes it to retry.
browser.alarms.create("reconnect", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect" && !rpc) void connect();
});

listenToShims();
void connect();
