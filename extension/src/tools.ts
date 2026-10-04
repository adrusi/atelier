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
  /** A source's bundle: a task's tree's, or the owned directory's (undefined). */
  bundle: (source?: string) => Bundle | undefined;
  /** Fetches a task's tree's bundle, if it isn't already loaded. */
  loadSource: (source: string) => Promise<void>;
  /** The task a tab is bound to (SPEC §6.2), if any. */
  sourceOf: (tabId: number) => string | null;
  /** Binds a tab to a task's tree, or back to the owned directory. Throws
   * if the daemon doesn't serve that task's tree. */
  bind: (tabId: number, task: string | null) => Promise<void>;
  /** Whether the page in this tab is running the style shim. */
  hasShim: (tabId: number) => boolean;
  /** Prerequisites the page in this tab reported as unmet. */
  unmet: (tabId: number) => { style: string; description: string }[];
  /** Resolves once the daemon has loaded every file change it has seen, and
   * the extension has that bundle. */
  settle: (source?: string) => Promise<void>;
  /** The owned directory, as the daemon reports it. */
  atelierDir: () => string | undefined;
};

const INVALID_PARAMS = -32602;
const NOT_AN_AGENT_TAB = -32020;
const PAGE_ERROR = -32021;
const NEEDS_PERMISSION = -32022;
/** atelier_proto::error_code::NO_SUCH_SOURCE */
const NO_SUCH_SOURCE = -32031;

const sourceError = (task: string | null, e: unknown) =>
  new RpcError(NO_SUCH_SOURCE, `can't show task ${task}'s tree: ${e instanceof Error ? e.message : e}`);

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

function describeTab(tab: browser.tabs.Tab, ctx: ToolContext) {
  const task = ctx.sourceOf(tab.id!);
  return { tab: tab.id, url: tab.url, title: tab.title, status: tab.status, visible: Boolean(tab.active), ...(task ? { task } : {}) };
}

const HIDDEN_NOTE =
  "This tab is in the background, where Firefox doesn't run animation frames: content drawn with requestAnimationFrame (canvases, some JS animations) may be missing or stale. CSS animations were fast-forwarded to their end state.";

/** For pages that render after load (JavaScript apps): waits for the
 * `waitFor` selector, if given. */
async function waitFor(tabId: number, params: any): Promise<object> {
  const selector = param<string | null>(params, "waitFor", "string", null);
  if (!selector) return {};
  const found = await call(tabId, page.waitForSelector, selector, param<number>(params, "waitForMs", "number", 10_000));
  return found ? {} : { warning: `\`${selector}\` didn't appear within the time allowed; the page may still be loading` };
}

/** Forced states per agent tab, so they can be redone when styles change:
 * force_state clones rules when it's called, and a later save would
 * otherwise not show up in the forced state. */
const forced = new Map<number, { selector: string; states: string[] }>();

/** Called after a new bundle has reached open pages. */
export async function reapplyForcedStates() {
  await new Promise((r) => setTimeout(r, 300)); // let the shims swap their styles first
  for (const [tabId, f] of forced) {
    try {
      await call(tabId, page.forceState, f.selector, f.states);
    } catch {
      forced.delete(tabId);
    }
  }
}

/** Tabs that have already been told about background-tab rendering. */
const toldHidden = new Set<number>();

type Handler = (params: any, ctx: ToolContext) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  async "tab/open"(params, ctx) {
    await loaded;
    const url = param<string>(params, "url", "string");
    const task = param<string | null>(params, "task", "string", null);
    // Bound before anything loads, so the first load already shows the task's tree.
    const tab = await browser.tabs.create({ url: "about:blank", active: false });
    agentTabs.add(tab.id!);
    await saveTabs();
    if (task !== null) {
      try {
        await ctx.bind(tab.id!, task);
      } catch (e) {
        await browser.tabs.remove(tab.id!);
        throw sourceError(task, e);
      }
    }
    await browser.tabs.update(tab.id!, { url });
    await settled(tab.id!);
    return { ...describeTab(await browser.tabs.get(tab.id!), ctx), ...(await waitFor(tab.id!, params)) };
  },

  async "tab/bind"(params, ctx) {
    const tab = await agentTab(params);
    const task = param<string | null>(params, "task", "string", null);
    try {
      await ctx.bind(tab.id!, task);
    } catch (e) {
      throw sourceError(task, e);
    }
    await new Promise((r) => setTimeout(r, 300)); // let the page swap styles
    return describeTab(await browser.tabs.get(tab.id!), ctx);
  },

  async "tab/navigate"(params, ctx) {
    const tab = await agentTab(params);
    const url = param<string>(params, "url", "string");
    await browser.tabs.update(tab.id!, { url });
    await settled(tab.id!);
    return { ...describeTab(await browser.tabs.get(tab.id!), ctx), ...(await waitFor(tab.id!, params)) };
  },

  async "tab/reload"(params, ctx) {
    const tab = await agentTab(params);
    await browser.tabs.reload(tab.id!);
    await settled(tab.id!);
    return describeTab(await browser.tabs.get(tab.id!), ctx);
  },

  async "tab/list"(_params, ctx) {
    await loaded;
    const tabs = await Promise.all([...agentTabs].map((id) => browser.tabs.get(id).catch(() => null)));
    return { tabs: tabs.filter((t): t is browser.tabs.Tab => Boolean(t)).map((t) => describeTab(t, ctx)) };
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
    await call(tab.id!, page.imagesReady, 3000);
    if (!tab.active && !toldHidden.has(tab.id!)) {
      notes.push(HIDDEN_NOTE);
      toldHidden.add(tab.id!);
    }

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
    const scale = param<number>(params, "scale", "number", 1);
    if (scale <= 0 || scale > 8) throw new RpcError(INVALID_PARAMS, "`scale` must be between 0 and 8");
    const dataUrl: string = await (browser.tabs as any).captureTab(tab.id, {
      format,
      ...(format === "jpeg" ? { quality: 85 } : {}),
      ...(rect ? { rect } : {}),
      ...(scale !== 1 ? { scale } : {}),
    });
    const [header, data] = dataUrl.split(",", 2);
    return { mimeType: header.slice(5).split(";")[0], data, notes };
  },

  async "page/eval"(params) {
    const tab = await agentTab(params);
    // In a block of its own, so declarations don't collide with earlier calls'.
    return { result: (await run(tab.id!, `{\n${param<string>(params, "expression", "string")}\n}`)) ?? null };
  },

  async "page/type"(params) {
    const tab = await agentTab(params);
    const selector = param<string>(params, "selector", "string");
    const r = await call(tab.id!, page.fill, selector, param<string>(params, "text", "string"), param<boolean>(params, "submit", "boolean", false));
    if (r === null) throw new RpcError(PAGE_ERROR, `no element matches \`${selector}\``);
    await new Promise((res) => setTimeout(res, 300)); // let the page react
    return r;
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
    const maxChars = param<number>(params, "maxChars", "number", 30_000);
    const r = (await call(
      tab.id!,
      page.tokens,
      param<string | null>(params, "filter", "string", null),
      param<number>(params, "limit", "number", 200),
      param<boolean>(params, "usage", "boolean", true),
      param<string | null>(params, "scope", "string", null),
      param<boolean>(params, "verbose", "boolean", false),
    )) as { total: number; shown: number; tokens: unknown[]; note?: string };
    // Big design systems define thousands of tokens; past the budget, show
    // fewer and say how to narrow it, rather than flooding the agent.
    const size = () => JSON.stringify(r).length;
    if (size() > maxChars) {
      while (r.tokens.length > 1 && size() > maxChars) r.tokens.length = Math.floor(r.tokens.length * 0.8);
      r.shown = r.tokens.length;
      r.note = `Output capped at about ${maxChars} characters: showing the first ${r.shown} of ${r.total} tokens alphabetically. \`families\` counts tokens by name prefix; narrow with filter (e.g. one of those prefixes) or scope, set usage: false, or raise maxChars.`;
    }
    return r;
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
    if (states.length) forced.set(tab.id!, { selector, states });
    else forced.delete(tab.id!);
    return r;
  },

  async "styles/status"(params, ctx) {
    const tab = params?.tab === undefined ? undefined : await agentTab(params);
    // A tab's own source; else the task asked about; else the owned directory.
    const source = tab ? (ctx.sourceOf(tab.id!) ?? undefined) : (param<string | null>(params, "task", "string", null) ?? undefined);
    if (source !== undefined && !tab) {
      try {
        await ctx.loadSource(source);
      } catch (e) {
        throw sourceError(source, e);
      }
    }
    await ctx.settle(source);
    const bundle = ctx.bundle(source);
    const byService: Record<string, number> = {};
    for (const s of bundle?.styles ?? []) byService[s.service ?? "(theme-wide)"] = (byService[s.service ?? "(theme-wide)"] ?? 0) + 1;
    const out: Record<string, unknown> = {
      showing: source === undefined ? "the owned directory: the styles the user's tabs have" : `task ${source}'s tree`,
      atelierDir: ctx.atelierDir() ?? null,
      theme: bundle?.theme ?? null,
      styles: bundle?.styles.length ?? 0,
      byService,
      diagnostics: bundle?.diagnostics ?? [],
    };
    if (tab) {
      out.tab = {
        ...describeTab(tab, ctx),
        applying: (bundle?.styles ?? []).filter((s) => tab.url && cssFor(s, tab.url) !== null).map((s) => s.id),
        shim: ctx.hasShim(tab.id!),
        unmetPrerequisites: ctx.unmet(tab.id!),
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
