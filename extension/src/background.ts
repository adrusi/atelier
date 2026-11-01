// Background script. It keeps a connection to the daemon through the native
// host (which also keeps this background resident; spike R4), fetches the
// bundle of compiled styles, and registers one user script per style that
// runs the page runtime (page/), whose shim applies them. When the bundle
// changes it updates the registrations and pushes the new bundle to pages
// that are already open.
// Agent tabs can be bound to a task's tree instead (SPEC §6.2); those get
// that tree's bundle, fetched and kept up to date the same way.

import type { BlobChunk } from "./proto/BlobChunk";
import type { BlobRef } from "./proto/BlobRef";
import type { Bundle } from "./proto/Bundle";
import type { CompiledStyle } from "./proto/CompiledStyle";
import type { Batch } from "./proto/Batch";
import type { Proposal } from "./proto/Proposal";
import type { BundleChanged } from "./proto/BundleChanged";
import type { InitializeResult } from "./proto/InitializeResult";
import type { JournalEntry } from "./proto/JournalEntry";
import type { SessionStatus } from "./proto/SessionStatus";
import type { Task } from "./proto/Task";
import { cssFor } from "./matching";
import { Rpc } from "./rpc";
import * as agentTabs from "./agenttabs";
import * as tools from "./tools";
import { EMULATION_MARKER, SOURCE_MARKER } from "./page/markers";
import { hasRequiredPermissions, onUserScriptConnect, onUserScriptMessage, type UserScript, userScripts } from "./userscripts";

declare const ATELIER_NATIVE_HOST: string;
/** The compiled page shim, inlined by build.ts. */
/** The page runtime (page/index.ts) and its page-world half (page/main.ts), built by build.ts. */
declare const ATELIER_PAGE: string;
declare const ATELIER_PAGE_MAIN: string;

/** Must match atelier_proto::PROTOCOL_VERSION. */
const PROTOCOL_VERSION = 2;
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
void hasRequiredPermissions().then((ok) => (state.needsPermission = !ok));
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
    if (method === "bundle/changed") {
      const { source, ...ref } = params as BundleChanged;
      if (source === undefined) void loadBundle(r, ref);
      else if (sources.has(source)) void loadSource(r, source, ref);
    } else if (method === "call/changed" || method === "theme/changed") {
      void updateInboxBadge();
    } else if (method === "task/changed") {
      const task = params as Task;
      if (task.state === "landed" || task.state === "declined" || task.state === "abandoned") void closeSource(task.id);
    }
  };
  // Browser tools, on behalf of agents (atelier mcp) and the CLI.
  r.onRequest = (method, params) =>
    tools.handle(method, params, {
      bundle: (source) => (source === undefined ? state.bundle : sources.get(source)?.bundle),
      loadSource: async (source) => {
        if (!rpc) throw new Error("atelier's daemon isn't connected");
        await loadSource(rpc, source);
      },
      sourceOf: (tabId) => bindings.get(tabId) ?? null,
      bind: bindTab,
      hasShim: (tabId) => [...shimPorts].some((p) => p.sender?.tab?.id === tabId && (p.sender?.frameId ?? 0) === 0),
      unmet: (tabId) => unmetByTab.get(tabId) ?? [],
      atelierDir: () => state.atelierDir,
      settle: async (source) => {
        const have = () => (source === undefined ? state.bundleHash : sources.get(source)?.hash);
        const deadline = Date.now() + 3000;
        while (rpc === r && Date.now() < deadline) {
          const s = await r.call<{ reloadPending: boolean; bundleHash: string }>("status", source === undefined ? {} : { source });
          if (!s.reloadPending && s.bundleHash === have()) return;
          await new Promise((res) => setTimeout(res, 100));
        }
      },
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
    void updateInboxBadge();
    await bindingsLoaded;
    for (const source of new Set(bindings.values())) {
      await loadSource(r, source).catch(() => closeSource(source));
    }
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    // An atelier program older than this extension (an update that reached
    // one but not the other) says so in its own terms; say it in the user's.
    const older = /protocol version \d+ isn't supported; this daemon speaks (\d+)/.exec(state.error);
    if (older && Number(older[1]) < PROTOCOL_VERSION) {
      state.error = `The atelier program on this computer is older than the extension (protocol ${older[1]}; the extension needs ${PROTOCOL_VERSION}). Update atelier (with home-manager, \`home-manager switch\` after updating the flake input), then restart Firefox.`;
    }
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

async function fetchBundle(r: Rpc, ref: BlobRef): Promise<Bundle> {
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
  return JSON.parse(new TextDecoder().decode(blob)) as Bundle;
}

function logBundle(label: string, hash: string, bundle: Bundle) {
  console.info(`atelier: ${label} ${hash.slice(0, 12)}: ${bundle.styles.length} styles, ${bundle.diagnostics.length} diagnostics`);
  for (const d of bundle.diagnostics) {
    const place = d.path ? `${d.path}${d.line ? `:${d.line}` : ""}: ` : "";
    console.info(`atelier:   ${d.severity} ${place}${d.message}`);
  }
}

async function loadBundle(r: Rpc, ref: BlobRef) {
  if (ref.hash === state.bundleHash) return;
  const bundle = await fetchBundle(r, ref);
  state.bundle = bundle;
  state.bundleHash = ref.hash;
  logBundle("bundle", ref.hash, bundle);
  await applyBundle(bundle);
}

// ---------------------------------------------------------------------------
// Sources: agent tabs bound to a task's tree (SPEC §6.2)

/** Bundles of the task trees that tabs are bound to, by task id. */
const sources = new Map<string, { bundle: Bundle; hash: string }>();
/** Agent tabs bound to a task, kept in session storage so they survive the
 * background restarting. Every other tab gets the owned directory's styles. */
const bindings = new Map<number, string>();
const bindingsLoaded = browser.storage.session.get("bindings").then((v) => {
  for (const [tab, source] of (v.bindings as [number, string][] | undefined) ?? []) bindings.set(tab, source);
});
const saveBindings = () => browser.storage.session.set({ bindings: [...bindings] });

/** Fetches a task tree's bundle (the daemon starts watching it), and gives
 * it to the tabs bound to it. Throws if the daemon doesn't serve it. */
async function loadSource(r: Rpc, source: string, ref?: BlobRef) {
  ref ??= await r.call<BlobRef>("bundle/get", { source });
  if (sources.get(source)?.hash === ref.hash) return;
  const bundle = await fetchBundle(r, ref);
  sources.set(source, { bundle, hash: ref.hash });
  logBundle(`task ${source}`, ref.hash, bundle);
  for (const port of shimPorts) {
    const tabId = port.sender?.tab?.id;
    if (tabId !== undefined && bindings.get(tabId) === source) sendStyles(port);
  }
  void tools.reapplyForcedStates();
}

/** Binds a tab to a task's tree, or back to the owned directory (null). */
async function bindTab(tabId: number, source: string | null) {
  await bindingsLoaded;
  if (source !== null) {
    if (!rpc) throw new Error("atelier's daemon isn't connected");
    await loadSource(rpc, source);
    bindings.set(tabId, source);
  } else if (!bindings.delete(tabId)) {
    return;
  }
  await saveBindings();
  const ports = [...shimPorts].filter((p) => p.sender?.tab?.id === tabId);
  for (const port of ports) sendStyles(port);
  if (source !== null && ports.length === 0) await ensureShim(tabId);
}

/** Puts every tab bound to a finished task back on the owned directory. */
async function closeSource(source: string) {
  await bindingsLoaded;
  sources.delete(source);
  for (const [tabId, s] of [...bindings]) if (s === source) await bindTab(tabId, null);
}

/** Bound tabs need a shim even on pages the owned directory has no style for
 * (the task may be styling a new site), so they get one on every load. */
async function ensureShim(tabId: number, frameId = 0) {
  const us = userScripts();
  if (!us) return;
  try {
    await us.execute({
      target: { tabId, frameIds: [frameId] },
      injectImmediately: true,
      js: [{ code: ATELIER_PAGE }, { code: "__atelierPage.shim.attach();" }],
    });
  } catch (e) {
    console.debug(`atelier: couldn't inject into bound tab ${tabId}:`, e);
  }
}

/** Sends a shim its tab's source and styles. */
function sendStyles(port: browser.runtime.Port) {
  const tabId = port.sender?.tab?.id;
  const source = tabId === undefined ? undefined : bindings.get(tabId);
  port.postMessage({ type: "bind", source: source ?? null });
  if (source === undefined) {
    if (state.bundle) port.postMessage({ type: "bundle", styles: withOverride(tabId, state.bundle.styles) });
    return;
  }
  const loaded = sources.get(source);
  if (loaded) port.postMessage({ type: "bundle", styles: withOverride(tabId, loaded.bundle.styles) });
  else if (rpc) void loadSource(rpc, source).catch(() => closeSource(source));
}

// ---------------------------------------------------------------------------
// Applying styles

const scriptId = (styleId: string) => `style:${styleId}`;

async function applyBundle(bundle: Bundle) {
  const us = userScripts();
  state.needsPermission = !(await hasRequiredPermissions());
  if (!us) {
    console.info("atelier: can't apply styles until the userScripts permission is granted");
    return;
  }

  await us.configureWorld({ messaging: true });
  listenToShims();

  const wanted: UserScript[] = bundle.styles.map((style) => ({
    id: scriptId(style.id),
    matches: style.patterns,
    js: [{ code: ATELIER_PAGE }, { code: `__atelierPage.shim.add(${JSON.stringify(style)});` }],
    runAt: "document_start",
    world: "USER_SCRIPT",
    // Every document is matched by its own URL, frames included (as Stylus does).
    allFrames: true,
  }));
  // Per-tab emulation (page/emulation.ts): inert unless a tab opts in with
  // its marker, and the runtime only runs where one does.
  wanted.push(
    { id: "scheme:main", matches: ["<all_urls>"], js: [{ code: ATELIER_PAGE_MAIN }], runAt: "document_start", world: "MAIN", allFrames: true },
    { id: "scheme:styles", matches: ["<all_urls>"], js: [{ code: emulationStub }], runAt: "document_start", world: "USER_SCRIPT", allFrames: true },
    // Tabs bound to a task's tree (SPEC §6.2), on pages the owned directory
    // has no style for: inert unless the page carries the binding marker.
    { id: "bound:shim", matches: ["<all_urls>"], js: [{ code: boundStub }], runAt: "document_start", world: "USER_SCRIPT", allFrames: true },
  );
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

  for (const port of shimPorts) {
    const tabId = port.sender?.tab?.id;
    if (tabId === undefined || !bindings.has(tabId)) port.postMessage({ type: "bundle", styles: withOverride(tabId, bundle.styles) });
  }
  await injectIntoOpenTabs(bundle);
  void tools.reapplyForcedStates();
}

/** Starts the page runtime's shim in a page whose binding marker says its
 * tab shows a task's tree: on every load after the first on an origin
 * (the marker is per origin), the shim is there from document_start. */
const boundStub = `(() => {
  try { if (!sessionStorage.getItem(${JSON.stringify(SOURCE_MARKER)})) return; } catch { return; }
  ${ATELIER_PAGE}
  __atelierPage.shim.attach();
})();`;

/** Starts the page runtime's emulation in a page whose marker asks for it. */
const emulationStub = `(() => {
  try { if (!sessionStorage.getItem(${JSON.stringify(EMULATION_MARKER)})) return; } catch { return; }
  ${ATELIER_PAGE}
  __atelierPage.emulation.start();
})();`;

/** Registered scripts only run on page loads, so pages that were already open
 * (when a style was added, or when the extension started) have no shim. Give
 * them one if some style now applies; it then gets live updates like any other. */
async function injectIntoOpenTabs(bundle: Bundle) {
  const us = userScripts();
  if (!us) return;
  const withShim = new Set([...shimPorts].map((p) => `${p.sender?.tab?.id}/${p.sender?.frameId ?? 0}`));
  for (const tab of await browser.tabs.query({})) {
    if (tab.id === undefined || bindings.has(tab.id)) continue;
    // Each document, frames included, by its own URL.
    const frames = (await browser.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null)) ?? [];
    for (const frame of frames) {
      if (withShim.has(`${tab.id}/${frame.frameId}`) || !/^(https?|file):/.test(frame.url)) continue;
      const styles = bundle.styles.filter((s) => cssFor(s, frame.url) !== null);
      if (styles.length === 0) continue;
      try {
        await us.execute({
          target: { tabId: tab.id, frameIds: [frame.frameId] },
          js: [{ code: ATELIER_PAGE }, ...styles.map((s) => ({ code: `__atelierPage.shim.add(${JSON.stringify(s)});` }))],
        });
      } catch (e) {
        // Restricted pages (e.g. addons.mozilla.org) refuse injection.
        console.debug(`atelier: couldn't inject into tab ${tab.id} frame ${frame.frameId}:`, e);
      }
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
  // The page may have been registered from an older bundle, or its tab bound
  // to a task (bindings may not have loaded yet if this woke the background).
  void bindingsLoaded.then(() => sendStyles(port));
}

function listenToShims() {
  const event = onUserScriptConnect();
  if (event && !event.hasListener(onShimConnect)) event.addListener(onShimConnect);
  const messages = onUserScriptMessage();
  if (messages && !messages.hasListener(onUserScriptRequest)) messages.addListener(onUserScriptRequest);
}

/** Requests from page scripts (page/emulation.ts): the text of a cross-origin
 * stylesheet, which the page can't read but the extension can fetch; and
 * which media features the tab should emulate, if any, so a page holding a
 * stale marker (a duplicated agent tab, say) can drop it. */
function onUserScriptRequest(msg: unknown, sender: browser.runtime.MessageSender): Promise<unknown> | undefined {
  const m = msg as { type?: string; href?: string };
  if (m?.type === "emulation") {
    const tabId = sender.tab?.id;
    return agentTabs.ready.then(() => (tabId === undefined ? null : agentTabs.features(tabId)));
  }
  if (m?.type !== "fetch-css" || !m.href || !/^https?:/.test(m.href)) return undefined;
  return fetch(m.href, { credentials: "omit" })
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null);
}

function notifyUrlChange(details: { tabId: number; frameId: number }) {
  for (const port of shimPorts) {
    if (port.sender?.tab?.id === details.tabId && (port.sender?.frameId ?? 0) === details.frameId) port.postMessage({ type: "url" });
  }
}

// ---------------------------------------------------------------------------
// Wiring. Listeners are registered synchronously, as event pages require.

browser.webNavigation.onHistoryStateUpdated.addListener(notifyUrlChange);
browser.webNavigation.onReferenceFragmentUpdated.addListener(notifyUrlChange);
// Bound tabs, on an origin whose page has no marker yet (the first load
// there): the shim is injected as the load commits, and again once the DOM
// is ready, as an injection racing the commit can miss the new document.
// A second injection finds the runtime and shim already there.
for (const event of [browser.webNavigation.onCommitted, browser.webNavigation.onDOMContentLoaded]) {
  event.addListener((details) => {
    // Frames too: they show the tab's task's styles, by their own URLs.
    void bindingsLoaded.then(() => {
      if (bindings.has(details.tabId)) void ensureShim(details.tabId, details.frameId);
    });
  });
}
browser.tabs.onRemoved.addListener((tabId) => {
  void bindingsLoaded.then(() => {
    if (bindings.delete(tabId)) void saveBindings();
  });
});

browser.permissions.onAdded.addListener((p) => {
  // APIs that need site access (tabs.captureTab) only exist in pages started
  // with it, this background included: start again to have them. (Rare: only
  // when the person grants it.)
  console.info(`atelier: permissions added: ${JSON.stringify(p)}`);
  if (p.origins?.length) {
    console.info("atelier: site access granted; restarting to use it");
    // Onboarding closes with the restart: open it again after, to finish.
    void browser.storage.local.set({ resumeOnboarding: true }).then(() => browser.runtime.reload());
    return;
  }
  if (!(p.permissions as string[] | undefined)?.includes("userScripts")) return;
  console.info("atelier: userScripts permission granted");
  if (state.bundle) void applyBundle(state.bundle);
});

browser.runtime.onInstalled.addListener((details) => {
  // On install, and on an update that still lacks something (an install
  // without a prompt never got site access); and after the restart a grant of
  // site access causes, to finish what onboarding was doing.
  if (details.reason !== "install" && details.reason !== "update") return;
  void Promise.all([hasRequiredPermissions(), browser.storage.local.get("resumeOnboarding")]).then(([ok, v]) => {
    if (v.resumeOnboarding) void browser.storage.local.remove("resumeOnboarding");
    if (!ok || v.resumeOnboarding) void browser.tabs.create({ url: browser.runtime.getURL(`onboarding.html${ok ? "?granted" : ""}`) });
  });
});

browser.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: string; tabId?: number; text?: string; screenshot?: boolean; seq?: number };
  if (m?.type === "state") return Promise.resolve({ ...state, unmet: m.tabId === undefined ? [] : (unmetByTab.get(m.tabId) ?? []) });
  if (m?.type === "site" && m.tabId !== undefined) return siteInfo(m.tabId);
  if (m?.type === "request" && m.tabId !== undefined) return request(m.tabId, m.text ?? "", Boolean(m.screenshot));
  if (m?.type === "undo" && m.seq !== undefined) return daemon().call<JournalEntry>("journal/undo", { seq: m.seq });
  if (m?.type === "start-session") return daemon().call("session/start", {});
  const i = msg as { type?: string; batch?: string; name?: string; answers?: unknown[]; task?: string; url?: string; stage?: string };
  if (i?.type === "inbox") return inbox();
  if (i?.type === "attachment" && i.batch && i.name) return attachment(i.batch, i.name);
  if (i?.type === "answer" && i.batch) return daemon().call<Batch>("call/answer", { batch: i.batch, answers: i.answers ?? [] });
  if (i?.type === "preview" && i.task && i.url) return preview(i.task, i.url);
  const v = msg as { type?: string; key?: string; task?: string | null; url?: string; file?: string; name?: string; css?: string };
  if (v?.type === "variant" && v.key && v.url && v.file && v.name && v.css !== undefined)
    return showVariant({ key: v.key, task: v.task ?? null, url: v.url, file: v.file, name: v.name, css: v.css });
  const d = msg as { type?: string; id?: string; accept?: boolean; note?: string; text?: string; undo?: boolean };
  if (d?.type === "decide" && d.id) return daemon().call<Proposal>("theme/decide", { id: d.id, accept: Boolean(d.accept), note: d.note ?? null, text: d.text ?? null });
  if (d?.type === "review" && d.id) return daemon().call<Proposal>("theme/review", { id: d.id, undo: Boolean(d.undo) });
  if (i?.type === "stage") return daemon().call("call/stage", i.stage ? { stage: i.stage } : {});
  if (i?.type === "open-inbox") return browser.tabs.create({ url: browser.runtime.getURL("inbox.html") }).then(() => true);
  return undefined;
});

// ---------------------------------------------------------------------------
// The inbox: calls from agents (SPEC §9.5)

export type Inbox = {
  batches: Batch[];
  /** Proposed THEME.md edits: open ones, then a few recent decisions. */
  proposals: Proposal[];
  /** The tasks they belong to, by id. */
  tasks: Record<string, Task>;
  theme: string | null;
  stage: string | null;
};

async function inbox(): Promise<Inbox> {
  const r = daemon();
  const [open, all] = await Promise.all([r.call<Batch[]>("call/list", { open: true }), r.call<Batch[]>("call/list", { open: false })]);
  // Waiting ones first, then the latest few answered, for reference.
  const answered = all.filter((b) => b.state === "answered").slice(0, 5);
  const batches = [...open, ...answered];
  const tasks: Record<string, Task> = {};
  for (const id of new Set(batches.map((b) => b.task))) {
    tasks[id] = await r.call<Task>("task/get", { id });
  }
  const stage = await r.call<{ theme: string; stage: string }>("call/stage", {}).catch(() => null);
  const allProposals = await r.call<Proposal[]>("theme/proposals", {}).catch(() => [] as Proposal[]);
  const proposals = [...allProposals.filter((p) => p.state === "open"), ...allProposals.filter((p) => p.state !== "open").slice(0, 3)];
  return { batches, proposals, tasks, theme: stage?.theme ?? null, stage: stage?.stage ?? null };
}

/** An attachment, as a data URL the inbox can show. */
async function attachment(batch: string, name: string): Promise<string> {
  const r = daemon();
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await r.call<BlobChunk>("call/attachment", { batch, name, offset, len: CHUNK });
    const bytes = Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0));
    parts.push(bytes);
    offset += bytes.length;
    if (chunk.eof || bytes.length === 0) break;
  }
  let binary = "";
  for (const p of parts) for (let j = 0; j < p.length; j += 0x8000) binary += String.fromCharCode(...p.subarray(j, j + 0x8000));
  const type = name.endsWith(".png") ? "image/png" : name.endsWith(".jpg") || name.endsWith(".jpeg") ? "image/jpeg" : "application/octet-stream";
  return `data:${type};base64,${btoa(binary)}`;
}

/** Opens a page in a new tab of the user's showing a task's tree, so they
 * can look at the work in progress before answering (SPEC §6.2). */
async function preview(task: string, url: string): Promise<boolean> {
  const tab = await browser.tabs.create({ url: "about:blank", active: true });
  await bindTab(tab.id!, task);
  await browser.tabs.update(tab.id!, { url });
  return true;
}

/** The toolbar badge counts batches waiting on the user (not ones for the
 * record), across all tabs. Per-tab badges (unmet prerequisites) win. */
async function updateInboxBadge() {
  if (!rpc || state.connection !== "connected") return;
  const open = await rpc.call<Batch[]>("call/list", { open: true }).catch(() => []);
  const proposals = await rpc.call<Proposal[]>("theme/proposals", { open: true }).catch(() => []);
  const waiting = open.filter((b) => b.wait !== "record").length + proposals.length;
  await browser.action.setBadgeText({ text: waiting ? String(waiting) : "" });
  if (waiting) await browser.action.setBadgeBackgroundColor({ color: "#b4befe" });
}

// ---------------------------------------------------------------------------
// Variants (SPEC §9.5): one tab per variant call, showing the page with an
// option swapped in, so the user can flip between options live.

type Override = { file: string; name: string; css: string };
/** Per tab: a variant block to replace in the styles it gets. */
const overrides = new Map<number, Override>();
/** The tab showing each variant call (by batch and call), for reuse. */
const variantTabs = new Map<string, number>();

/** The CSS between a variant's markers replaced (mirrors the daemon's). */
function replaceBlock(text: string, name: string, css: string): string {
  const start = `/* atelier:variant ${name} */`;
  const end = `/* atelier:end ${name} */`;
  const s = text.indexOf(start);
  if (s < 0) return text;
  const from = s + start.length;
  const e = text.indexOf(end, from);
  if (e < 0) return text;
  return `${text.slice(0, from)}\n${css.trimEnd()}\n${text.slice(e)}`;
}

function withOverride(tabId: number | undefined, styles: CompiledStyle[]): CompiledStyle[] {
  const o = tabId === undefined ? undefined : overrides.get(tabId);
  if (!o) return styles;
  return styles.map((s) => (s.id === o.file ? { ...s, sections: s.sections.map((sec) => ({ ...sec, css: replaceBlock(sec.css, o.name, o.css) })) } : s));
}

/** Shows a variant option in its own tab of the user's: the task's tree if
 * the work hasn't landed, else their own styles, with the option swapped in. */
const showing = new Map<string, Promise<boolean>>();
function showVariant(m: { key: string; task: string | null; url: string } & Override): Promise<boolean> {
  // One at a time per call, so two quick clicks can't open two tabs.
  const next = (showing.get(m.key) ?? Promise.resolve(true)).catch(() => true).then(() => showVariantNow(m));
  showing.set(m.key, next);
  return next;
}

async function showVariantNow(m: { key: string; task: string | null; url: string } & Override): Promise<boolean> {
  let tabId = variantTabs.get(m.key);
  const exists = tabId !== undefined && (await browser.tabs.get(tabId).then(() => true, () => false));
  overrides.set(-1, m); // placeholder until the tab id is known
  if (!exists) {
    const tab = await browser.tabs.create({ url: "about:blank", active: true });
    tabId = tab.id!;
    variantTabs.set(m.key, tabId);
    overrides.set(tabId, m);
    if (m.task) await bindTab(tabId, m.task);
    await browser.tabs.update(tabId, { url: m.url });
  } else {
    overrides.set(tabId!, m);
    for (const port of shimPorts) if (port.sender?.tab?.id === tabId) sendStyles(port);
    await browser.tabs.update(tabId!, { active: true });
  }
  overrides.delete(-1);
  return true;
}

browser.tabs.onRemoved.addListener((tabId) => {
  overrides.delete(tabId);
  for (const [k, t] of variantTabs) if (t === tabId) variantTabs.delete(k);
});

// ---------------------------------------------------------------------------
// Requests from the popup (SPEC §6.4)

function daemon(): Rpc {
  if (!rpc || state.connection !== "connected") throw new Error("atelier's daemon isn't connected, so requests can't be made right now.");
  return rpc;
}

/** The service whose styles apply to a URL, if any. */
function serviceAt(url: string): string | null {
  return state.bundle?.styles.find((s) => s.service && cssFor(s, url) !== null)?.service ?? null;
}

const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
};

export type SiteInfo = {
  host: string;
  service: string | null;
  /** Requests for this site, newest first. */
  tasks: Task[];
  /** The latest landing on this site's service that can still be undone. */
  landing: JournalEntry | null;
  /** Tasks whose landing has since been undone. */
  undone: string[];
  /** Agent sessions: what will happen to a queued request. */
  session: SessionStatus | null;
};

async function siteInfo(tabId: number): Promise<SiteInfo> {
  const tab = await browser.tabs.get(tabId);
  const host = hostOf(tab.url);
  const service = tab.url ? serviceAt(tab.url) : null;
  const r = daemon();
  const [tasks, journal, session] = await Promise.all([
    r.call<Task[]>("task/list", {}),
    r.call<JournalEntry[]>("journal/list", {}),
    r.call<SessionStatus>("session/status", {}).catch(() => null),
  ]);
  const here = tasks
    .filter((t) => (service !== null && t.service === service) || (host !== "" && hostOf(t.brief.origin) === host))
    .reverse()
    .slice(0, 5);
  const landing =
    service === null
      ? null
      : (journal.find((e) => e.undoOf === null && e.undoneBy === null && e.files.some((f) => f.path.startsWith(`services/${service}/`))) ?? null);
  const undone = journal.filter((e) => e.task !== null && e.undoOf === null && e.undoneBy !== null).map((e) => e.task!);
  return { host, service, tasks: here, landing, undone, session };
}

/** Queues a request for the page in a tab: a revise if a style applies
 * there, otherwise a create. With a screenshot of what the user sees. */
async function request(tabId: number, text: string, screenshot: boolean): Promise<Task> {
  const r = daemon();
  const tab = await browser.tabs.get(tabId);
  const service = tab.url ? serviceAt(tab.url) : null;
  const description = text.trim() || (service === null ? `Style ${hostOf(tab.url)}` : "");
  if (!description) throw new Error("Say what you'd like changed.");
  const uploads: { name: string; data: string }[] = [];
  // Without site access there's no captureTab: the request goes without one.
  if (screenshot && typeof (browser.tabs as { captureTab?: unknown }).captureTab === "function") {
    const dataUrl: string = await (browser.tabs as any).captureTab(tabId, { format: "jpeg", quality: 85 });
    uploads.push({ name: "page.jpg", data: dataUrl.split(",", 2)[1] });
  }
  return r.call<Task>("task/create", {
    kind: service === null ? "create" : "revise",
    ...(service === null ? {} : { service }),
    brief: { description, origin: tab.url ?? null, container: tab.cookieStoreId ?? null },
    uploads,
  });
}

// If the background was suspended while disconnected, this wakes it to retry.
browser.alarms.create("reconnect", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect" && !rpc) void connect();
});

listenToShims();
void agentTabs.reconcile();
void connect();
