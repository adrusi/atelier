// Agent tabs as a resource (ARCHITECTURE.md, "State and recovery"): the tabs
// atelier opens for agents, and what it has set up in each (a throwaway
// container, an emulated colour scheme). Bindings to task trees are kept by
// the background with the other sources.
//
// The records live in session storage, so they survive the background
// being suspended, and each tab also carries a tab value with the browser
// session's epoch. Tab values are restored with the tab, so a tab restored
// from an earlier session (after a crash, or with "open previous windows")
// is recognised as a leftover agent tab, which reconcile closes; a tab whose
// value is current but isn't one of ours is a copy (a duplicated tab), and
// becomes the user's.

import * as containers from "./containers";
import type { Features } from "./page/media";

export type AgentTab = {
  /** The throwaway container the tab was opened in. */
  throwaway?: string;
  /** The colour scheme emulated in the tab (tab/color_scheme). */
  scheme?: "light" | "dark";
  /** The viewport size emulated in the tab (tab/viewport). */
  viewport?: { width: number; height: number };
  /** The agent session (`atelier mcp`) that opened it: its tabs close when it ends. */
  agent?: string;
};

/** The media features a tab emulates (page/media.ts), or null. */
export function features(id: number): Features | null {
  const r = records.get(id);
  if (!r?.scheme && !r?.viewport) return null;
  return { ...(r.scheme ? { "prefers-color-scheme": r.scheme } : {}), ...(r.viewport ?? {}) };
}

const TAB_VALUE = "atelier";

const records = new Map<number, AgentTab>();

/** Resolves once the records are loaded. */
export const ready: Promise<void> = browser.storage.session.get("agentTabs").then((v) => {
  for (const r of (v.agentTabs as ([number, AgentTab] | number)[] | undefined) ?? []) {
    // Earlier versions kept only the ids.
    if (typeof r === "number") records.set(r, {});
    else records.set(r[0], r[1]);
  }
});

const save = () => browser.storage.session.set({ agentTabs: [...records] });

let epochValue: Promise<string> | null = null;

/** This browser session's epoch: session storage is cleared when the browser
 * (or the extension) restarts, and a new one is made. */
export function epoch(): Promise<string> {
  epochValue ??= browser.storage.session.get("epoch").then(async (v) => {
    if (typeof v.epoch === "string") return v.epoch;
    const fresh = crypto.randomUUID();
    await browser.storage.session.set({ epoch: fresh });
    return fresh;
  });
  return epochValue;
}

export const has = (id: number) => records.has(id);
export const get = (id: number) => records.get(id);
export const ids = () => [...records.keys()];

export async function add(id: number, record: AgentTab) {
  await ready;
  records.set(id, record);
  await save();
  await browser.sessions.setTabValue(id, TAB_VALUE, { epoch: await epoch() }).catch(() => {});
}

export async function update(id: number, change: Partial<AgentTab>) {
  await ready;
  const record = records.get(id);
  if (!record) return;
  Object.assign(record, change);
  for (const k of Object.keys(record) as (keyof AgentTab)[]) if (record[k] === undefined) delete record[k];
  await save();
}

export async function forget(id: number) {
  await ready;
  if (records.delete(id)) await save();
}

browser.tabs.onRemoved.addListener((id) => {
  void forget(id).then(() => containers.sweep());
});

// The window each agent session's tabs go in, when they get one of their own
// (`[session] windows`). Kept in session storage like the tab records.
const windows = new Map<string, number>();
const windowsReady: Promise<void> = browser.storage.session.get("agentWindows").then((v) => {
  for (const [agent, id] of (v.agentWindows as [string, number][] | undefined) ?? []) windows.set(agent, id);
});
const saveWindows = () => browser.storage.session.set({ agentWindows: [...windows] });

/** The window of an agent session's tabs, if it's still open. */
export async function windowOf(agent: string): Promise<number | undefined> {
  await windowsReady;
  const id = windows.get(agent);
  if (id === undefined) return undefined;
  if (await browser.windows.get(id).then(() => true, () => false)) return id;
  windows.delete(agent);
  await saveWindows();
  return undefined;
}

export async function setWindow(agent: string, id: number) {
  await windowsReady;
  windows.set(agent, id);
  await saveWindows();
}

/** Closes the tabs an agent session opened (and so its window, if it had
 * one), when the session has ended. Returns how many. */
export async function end(agent: string): Promise<number> {
  await ready;
  await windowsReady;
  const mine = [...records].filter(([, r]) => r.agent === agent).map(([id]) => id);
  if (mine.length) await browser.tabs.remove(mine).catch(() => {});
  for (const id of mine) records.delete(id);
  await save();
  if (windows.delete(agent)) await saveWindows();
  return mine.length;
}

/** Makes the browser's tabs and containers agree with the records: closes
 * agent tabs restored from an earlier session, lets go of copies, forgets
 * tabs that are gone, and removes throwaway containers nothing needs. */
export async function reconcile() {
  await ready;
  const current = await epoch();
  const tabs = await browser.tabs.query({});
  const live = new Set(tabs.map((t) => t.id));
  let changed = false;
  for (const id of records.keys()) {
    if (!live.has(id)) changed = records.delete(id) || changed;
  }
  if (changed) await save();
  // Windows that are gone, or have no agent tabs left (the user may have
  // moved them), are no longer the agent's.
  await windowsReady;
  const used = new Set(tabs.filter((t) => t.id !== undefined && records.has(t.id)).map((t) => t.windowId));
  let windowsChanged = false;
  for (const [agent, id] of windows) {
    if (!used.has(id)) windowsChanged = windows.delete(agent) || windowsChanged;
  }
  if (windowsChanged) await saveWindows();
  const leftovers: number[] = [];
  for (const tab of tabs) {
    if (tab.id === undefined || records.has(tab.id)) continue;
    const value = (await browser.sessions.getTabValue(tab.id, TAB_VALUE).catch(() => undefined)) as { epoch?: string } | undefined;
    if (!value) continue;
    if (value.epoch !== current) leftovers.push(tab.id);
    else await browser.sessions.removeTabValue(tab.id, TAB_VALUE).catch(() => {});
  }
  if (leftovers.length) {
    console.info(`atelier: closing ${leftovers.length} agent tab(s) left from an earlier session`);
    await browser.tabs.remove(leftovers).catch(() => {});
  }
  await containers.sweep();
}

/** Reconciles soon after tabs appear (a restored session's tabs arrive
 * after the background has started), and every few minutes regardless. */
let pending: ReturnType<typeof setTimeout> | null = null;
browser.tabs.onCreated.addListener(() => {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void reconcile();
  }, 3000);
});
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "atelier:reconcile") void reconcile();
});
void browser.alarms.create("atelier:reconcile", { periodInMinutes: 5 });
