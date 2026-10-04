// Browser tools (SPEC §10), called by the daemon on behalf of `atelier mcp`
// and `atelier browser`. Agents work in tabs atelier opens for them ("agent
// tabs"); page tools refuse any other tab, so an agent never touches the
// user's own tabs.

import { cssFor } from "./matching";
import * as page from "./pagefns";
import type { Bundle } from "./proto/Bundle";
import { RpcError } from "./rpc";
import { userScripts } from "./userscripts";

export type ToolContext = {
  bundle: () => Bundle | undefined;
  /** Whether the page in this tab is running the style shim. */
  hasShim: (tabId: number) => boolean;
};

const INVALID_PARAMS = -32602;
const NOT_AN_AGENT_TAB = -32020;
const PAGE_ERROR = -32021;
const NEEDS_PERMISSION = -32022;

// Agent tabs, kept in session storage so they survive the background restarting.
const agentTabs = new Set<number>();
const loaded = browser.storage.session.get("agentTabs").then((v) => {
  for (const id of (v.agentTabs as number[] | undefined) ?? []) agentTabs.add(id);
});
const saveTabs = () => browser.storage.session.set({ agentTabs: [...agentTabs] });
browser.tabs.onRemoved.addListener((id) => {
  if (agentTabs.delete(id)) void saveTabs();
});

function param<T>(params: any, name: string, type: string, fallback?: T): T {
  const v = params?.[name];
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new RpcError(INVALID_PARAMS, `missing \`${name}\``);
  }
  if (typeof v !== type) throw new RpcError(INVALID_PARAMS, `\`${name}\` must be a ${type}`);
  return v as T;
}

async function agentTab(params: any): Promise<browser.tabs.Tab> {
  await loaded;
  const id = param<number>(params, "tab", "number");
  if (!agentTabs.has(id)) {
    throw new RpcError(
      NOT_AN_AGENT_TAB,
      `tab ${id} isn't one of atelier's agent tabs (open one with tab_open; agent tools never touch the user's own tabs). Agent tabs: ${[...agentTabs].join(", ") || "none"}`,
    );
  }
  try {
    return await browser.tabs.get(id);
  } catch {
    agentTabs.delete(id);
    void saveTabs();
    throw new RpcError(NOT_AN_AGENT_TAB, `tab ${id} has been closed`);
  }
}

/** Waits for a tab to finish loading. Navigations start asynchronously, so
 * this first gives the tab a moment to start loading if it hasn't. */
async function settled(tabId: number, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(150);
  while (Date.now() < deadline) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === "complete") {
      await sleep(250); // let late layout and our shim settle
      return;
    }
    await sleep(100);
  }
  throw new RpcError(PAGE_ERROR, `the page in tab ${tabId} didn't finish loading within ${timeoutMs / 1000}s`);
}

/** Runs code in the page's userScripts world and returns its completion value. */
async function run(tabId: number, code: string): Promise<unknown> {
  const us = userScripts();
  if (!us) throw new RpcError(NEEDS_PERMISSION, "atelier needs the userScripts permission to inspect pages; grant it from the toolbar button");
  let results: any[];
  try {
    results = await us.execute({ target: { tabId }, js: [{ code }] });
  } catch (e) {
    throw new RpcError(PAGE_ERROR, `couldn't run in tab ${tabId}: ${e instanceof Error ? e.message : e} (pages like about: and addons.mozilla.org can't be inspected)`);
  }
  const r = results[0];
  if (r?.error) throw new RpcError(PAGE_ERROR, `the page code threw: ${r.error.message ?? r.error}`);
  return r?.result;
}

/** Calls one of pagefns.ts in the page with JSON arguments. */
const call = (tabId: number, fn: (...args: any[]) => unknown, ...args: unknown[]) =>
  run(tabId, `(${fn})(...${JSON.stringify(args)})`);

function describeTab(tab: browser.tabs.Tab) {
  return { tab: tab.id, url: tab.url, title: tab.title, status: tab.status, visible: Boolean(tab.active) };
}

const HIDDEN_NOTE =
  "This tab is in the background, where Firefox doesn't run animation frames: content drawn with requestAnimationFrame (canvases, some JS animations) may be missing or stale. CSS animations were fast-forwarded to their end state.";

type Handler = (params: any, ctx: ToolContext) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  async "tab/open"(params) {
    await loaded;
    const url = param<string>(params, "url", "string");
    const tab = await browser.tabs.create({ url, active: false });
    agentTabs.add(tab.id!);
    await saveTabs();
    await settled(tab.id!);
    return describeTab(await browser.tabs.get(tab.id!));
  },

  async "tab/navigate"(params) {
    const tab = await agentTab(params);
    const url = param<string>(params, "url", "string");
    await browser.tabs.update(tab.id!, { url });
    await settled(tab.id!);
    return describeTab(await browser.tabs.get(tab.id!));
  },

  async "tab/reload"(params) {
    const tab = await agentTab(params);
    await browser.tabs.reload(tab.id!);
    await settled(tab.id!);
    return describeTab(await browser.tabs.get(tab.id!));
  },

  async "tab/list"() {
    await loaded;
    const tabs = await Promise.all([...agentTabs].map((id) => browser.tabs.get(id).catch(() => null)));
    return { tabs: tabs.filter((t): t is browser.tabs.Tab => Boolean(t)).map(describeTab) };
  },

  async "tab/close"(params) {
    const tab = await agentTab(params);
    await browser.tabs.remove(tab.id!);
    agentTabs.delete(tab.id!);
    await saveTabs();
    return { closed: tab.id };
  },

  async "page/screenshot"(params) {
    const tab = await agentTab(params);
    const selector = param<string | null>(params, "selector", "string", null);
    const full = param<boolean>(params, "fullPage", "boolean", false);
    const format = param<string>(params, "format", "string", "png");
    if (format !== "png" && format !== "jpeg") throw new RpcError(INVALID_PARAMS, "`format` must be png or jpeg");
    const notes: string[] = [];
    if (param<boolean>(params, "settleAnimations", "boolean", true)) await call(tab.id!, page.finishAnimations);
    if (!tab.active) notes.push(HIDDEN_NOTE);

    let rect: { x: number; y: number; width: number; height: number } | undefined;
    if (selector) {
      const r = (await call(tab.id!, page.rectOf, selector)) as typeof rect | null;
      if (!r) throw new RpcError(PAGE_ERROR, `no element matches \`${selector}\``);
      if (r.width === 0 || r.height === 0) throw new RpcError(PAGE_ERROR, `\`${selector}\` matches an element with no size (hidden?)`);
      rect = r;
    } else if (full) {
      const s = (await call(tab.id!, page.pageState)) as { width: number; height: number };
      const maxHeight = param<number>(params, "maxHeight", "number", 4000);
      rect = { x: 0, y: 0, width: s.width, height: Math.min(s.height, maxHeight) };
      if (s.height > maxHeight) notes.push(`The page is ${s.height}px tall; captured the top ${maxHeight}px (raise maxHeight, or capture elements with \`selector\`).`);
    }
    const dataUrl: string = await (browser.tabs as any).captureTab(tab.id, {
      format,
      ...(format === "jpeg" ? { quality: 85 } : {}),
      ...(rect ? { rect } : {}),
    });
    const [header, data] = dataUrl.split(",", 2);
    return { mimeType: header.slice(5).split(";")[0], data, notes };
  },

  async "page/eval"(params) {
    const tab = await agentTab(params);
    return { result: (await run(tab.id!, param<string>(params, "expression", "string"))) ?? null };
  },

  async "page/query"(params) {
    const tab = await agentTab(params);
    return call(
      tab.id!,
      page.query,
      param<string>(params, "selector", "string"),
      param<number>(params, "limit", "number", 10),
      param<number>(params, "maxLength", "number", 500),
    );
  },

  async "page/computed"(params) {
    const tab = await agentTab(params);
    const selector = param<string>(params, "selector", "string");
    const r = await call(tab.id!, page.computed, selector, params?.properties ?? null);
    if (r === null) throw new RpcError(PAGE_ERROR, `no element matches \`${selector}\``);
    return r;
  },

  async "page/tokens"(params) {
    const tab = await agentTab(params);
    return call(tab.id!, page.tokens, param<string | null>(params, "filter", "string", null), param<number>(params, "limit", "number", 200));
  },

  async "page/matched_rules"(params) {
    const tab = await agentTab(params);
    const selector = param<string>(params, "selector", "string");
    const r = await call(
      tab.id!,
      page.matchedRules,
      selector,
      param<string | null>(params, "property", "string", null),
      param<number>(params, "limit", "number", 30),
    );
    if (r === null) throw new RpcError(PAGE_ERROR, `no element matches \`${selector}\``);
    return r;
  },

  async "page/contrast"(params) {
    const tab = await agentTab(params);
    return call(tab.id!, page.contrast, param<number>(params, "minRatio", "number", 4.5), param<number>(params, "limit", "number", 40));
  },

  async "page/force_state"(params) {
    const tab = await agentTab(params);
    const selector = param<string>(params, "selector", "string");
    const states = params?.states ?? [];
    if (!Array.isArray(states)) throw new RpcError(INVALID_PARAMS, "`states` must be an array");
    const r = (await call(tab.id!, page.forceState, selector, states)) as any;
    if (r === null) throw new RpcError(PAGE_ERROR, `no element matches \`${selector}\``);
    if (r.error) throw new RpcError(INVALID_PARAMS, r.error);
    return r;
  },

  async "styles/status"(params, ctx) {
    const bundle = ctx.bundle();
    const out: Record<string, unknown> = {
      theme: bundle?.theme ?? null,
      styles: bundle?.styles.length ?? 0,
      diagnostics: bundle?.diagnostics ?? [],
    };
    if (params?.tab !== undefined) {
      const tab = await agentTab(params);
      out.tab = {
        ...describeTab(tab),
        applying: (bundle?.styles ?? []).filter((s) => tab.url && cssFor(s, tab.url) !== null).map((s) => s.id),
        shim: ctx.hasShim(tab.id!),
      };
    }
    return out;
  },
};

export const TOOL_METHODS = Object.keys(handlers);

export async function handle(method: string, params: unknown, ctx: ToolContext): Promise<unknown> {
  const h = handlers[method];
  if (!h) throw new RpcError(-32601, `unknown browser method \`${method}\`; known: ${TOOL_METHODS.join(", ")}`);
  return h(params, ctx);
}
