// Browser tools (SPEC §10), called by the daemon on behalf of `atelier mcp`
// and `atelier browser`. Agents work in tabs atelier opens for them ("agent
// tabs"); page tools refuse any other tab, so an agent never touches the
// user's own tabs.

import { cssFor } from "./matching";
import type { PageRuntime } from "./page/index";
import type { Bundle } from "./proto/Bundle";
import { RpcError } from "./rpc";
import * as containers from "./containers";
import { EMULATION_MARKER } from "./page/markers";
import * as agentTabs from "./agenttabs";
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

// Agent tabs, and what's set up in them: agenttabs.ts.
const loaded = agentTabs.ready;

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
      `tab ${id} isn't one of atelier's agent tabs (open one with tab_open; agent tools never touch the user's own tabs). Agent tabs: ${agentTabs.ids().join(", ") || "none"}`,
    );
  }
  try {
    return await browser.tabs.get(id);
  } catch {
    await agentTabs.forget(id);
    throw new RpcError(NOT_AN_AGENT_TAB, `tab ${id} has been closed`);
  }
}

/** Waits for a tab to finish loading. Navigations start asynchronously, so
 * this first gives the tab a moment to start loading if it hasn't. */
/** Returns a warning if the page was still loading when the time ran out:
 * some pages never finish (live updates, long polling), and that's no
 * reason to fail the call. */
async function settled(tabId: number, timeoutMs = 20_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await sleep(150);
  while (Date.now() < deadline) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === "complete") {
      await sleep(250); // let late layout and our shim settle
      return null;
    }
    await sleep(100);
  }
  return `The page was still loading after ${timeoutMs / 1000}s (some pages never finish, e.g. with live updates); carried on anyway. If something's missing, give it a moment, or use waitFor.`;
}

/** Runs code in the page's userScripts world and returns its completion value. */
async function run(tabId: number, code: string): Promise<unknown> {
  const us = userScripts();
  if (!us) throw new RpcError(NEEDS_PERMISSION, "atelier needs the userScripts permission to inspect pages; grant it from the toolbar button");
  let results: any[];
  try {
    results = await us.execute({ target: { tabId }, js: [{ code }] });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A result that can't be passed back fails here too; say which it was.
    if (/clon|serializ|structured/i.test(message)) {
      throw new RpcError(PAGE_ERROR, `the result couldn't be passed back (${message}): return plain data, e.g. {...el.dataset} rather than el.dataset, or JSON.parse(JSON.stringify(x))`);
    }
    throw new RpcError(PAGE_ERROR, `couldn't run in tab ${tabId}: ${message}. Pages like about: and addons.mozilla.org can't be inspected; if this is an ordinary page, it may still be loading.`);
  }
  const r = results[0];
  if (r?.error) {
    const message = String(r.error.message ?? r.error);
    if (/await is only valid/i.test(message)) {
      throw new RpcError(PAGE_ERROR, `${message}: there's no top-level await here. Wrap the code in an async function and await it as the last expression: (async () => { … return value; })()`);
    }
    throw new RpcError(PAGE_ERROR, `the page code threw: ${message}`);
  }
  return r?.result;
}

declare const ATELIER_PAGE: string;

type PageTools = PageRuntime["tools"];
const MISSING = "atelier: no page runtime";

/** Calls one of the page runtime's tools (page/tools.ts) with JSON
 * arguments, injecting the runtime first if the page doesn't have it yet. */
async function call<K extends keyof PageTools>(tabId: number, name: K, ...args: Parameters<PageTools[K]>): Promise<unknown> {
  const invoke = `__atelierPage.tools.${name}(...${JSON.stringify(args)})`;
  const r = await run(tabId, `globalThis.__atelierPage ? ${invoke} : ${JSON.stringify(MISSING)}`);
  return r === MISSING ? run(tabId, `${ATELIER_PAGE}\n${invoke}`) : r;
}

function describeTab(tab: browser.tabs.Tab, ctx: ToolContext) {
  const task = ctx.sourceOf(tab.id!);
  return {
    tab: tab.id,
    url: tab.url,
    title: tab.title,
    status: tab.status,
    visible: Boolean(tab.active),
    ...(task ? { task } : {}),
    ...(agentTabs.get(tab.id!)?.throwaway ? { throwaway: true } : {}),
  };
}

const VIEWPORT_NOTE =
  "it's a desktop window of that size, not a phone: hover styles still apply, there's no touch, and meta viewport and text inflation don't apply.";

const HIDDEN_NOTE =
  "This tab is in the background, where Firefox doesn't run animation frames: content drawn with requestAnimationFrame (canvases, some JS animations) may be missing or stale. CSS animations were fast-forwarded to their end state.";

/** For pages that render after load (JavaScript apps): waits for the
 * `waitFor` selector, if given. Returns a warning if it never matched. */
async function waitFor(tabId: number, params: any): Promise<string | null> {
  const selector = param<string | null>(params, "waitFor", "string", null);
  if (!selector) return null;
  const ms = param<number>(params, "waitForMs", "number", 10_000);
  const found = await call(tabId, "waitForSelector", selector, ms);
  return found
    ? null
    : `\`${selector}\` matched nothing within ${ms / 1000}s: either the page renders it later, or it doesn't match this page (try query).`;
}

/** A tab's description after loading, with any warnings about the load. */
async function afterLoad(tabId: number, params: any, ctx: ToolContext, slow: string | null) {
  const check = (await call(tabId, "botCheck").catch(() => null)) as string | null;
  const bot = check
    ? `This is a bot check ("${check}"), not the page itself: screenshots and tools see the check. It may pass on its own; wait a few seconds and tab_reload, or try another page of the site.`
    : null;
  const warnings = [slow, bot, await waitFor(tabId, params)].filter(Boolean);
  return { ...describeTab(await browser.tabs.get(tabId), ctx), ...(warnings.length ? { warning: warnings.join(" ") } : {}) };
}

/** Cross-origin stylesheets fetched for the CSSOM tools, by URL. Small,
 * since they're refetched when evicted. */
const fetchedSheets = new Map<string, string>();

/** Fetches the stylesheets a page can't read itself (cross-origin, no CORS)
 * and gives the page copies, so css_tokens and matched_rules see their rules
 * in their place. The extension's host permissions aren't bound by CORS. */
async function fetchUnreadable(tabId: number): Promise<void> {
  const sheets = ((await call(tabId, "unreadableSheets")) as { href: string; media: string }[]).slice(0, 20);
  const out: { href: string; media: string; text: string }[] = [];
  for (const sh of sheets) {
    let text = fetchedSheets.get(sh.href);
    if (text === undefined) {
      try {
        const r = await fetch(sh.href, { credentials: "omit" });
        text = r.ok ? await r.text() : "";
      } catch {
        text = "";
      }
      if (text.length > 4_000_000) text = "";
      fetchedSheets.set(sh.href, text);
      if (fetchedSheets.size > 40) fetchedSheets.delete(fetchedSheets.keys().next().value!);
    }
    if (text) out.push({ ...sh, text });
  }
  if (out.length) await call(tabId, "provideFetched", out);
}

/** Whether each SVG image carries its own prefers-color-scheme rules, by URL. */
const adaptiveSvg = new Map<string, boolean>();

/** What colour-scheme emulation can't reach in the tab, said plainly, or
 * null if there's nothing (ARCHITECTURE.md: limits are reported). */
async function schemeGaps(tabId: number): Promise<{ frames?: number; svgImages?: string[]; note: string } | null> {
  const gaps = (await call(tabId, "emulationGaps")) as { frames: number; svgImages: string[] };
  const adaptive: string[] = [];
  for (const url of gaps.svgImages) {
    let known = adaptiveSvg.get(url);
    if (known === undefined) {
      try {
        const r = await fetch(url, { credentials: "omit" });
        known = r.ok && /prefers-color-scheme/.test(await r.text());
      } catch {
        known = false;
      }
      adaptiveSvg.set(url, known);
      if (adaptiveSvg.size > 500) adaptiveSvg.delete(adaptiveSvg.keys().next().value!);
    }
    if (known) adaptive.push(url);
  }
  if (!gaps.frames && !adaptive.length) return null;
  const parts: string[] = [];
  if (gaps.frames) parts.push(`${gaps.frames} frame(s) from other origins (emulated as they load, so scripts that run first in them may see the real scheme)`);
  if (adaptive.length) parts.push(`${adaptive.length} SVG image(s) with their own prefers-color-scheme rules, which follow the browser's real setting`);
  return {
    ...(gaps.frames ? { frames: gaps.frames } : {}),
    ...(adaptive.length ? { svgImages: adaptive.slice(0, 5) } : {}),
    note: `Not fully emulated on this page: ${parts.join("; ")}. Parts of them may show the user's actual scheme, not the emulated one; judge them by another means, or say what you couldn't check.`,
  };
}

/** Code that sets (or clears) a tab's emulation marker. */
const markerCode = (features: unknown) =>
  features
    ? `try { sessionStorage.setItem(${JSON.stringify(EMULATION_MARKER)}, ${JSON.stringify(JSON.stringify(features))}); } catch {}`
    : `try { sessionStorage.removeItem(${JSON.stringify(EMULATION_MARKER)}); } catch {}`;

/** Media features emulated per agent tab (color_scheme, viewport). The
 * marker in sessionStorage is per origin, so on each navigation the
 * emulation is injected again, and the marker set for the loads after. */
browser.webNavigation.onCommitted.addListener(async (d) => {
  await loaded;
  const features = agentTabs.features(d.tabId);
  const us = userScripts();
  if (!features || !us) return;
  // Frames too: a same-origin frame sees the marker itself, but one from
  // another origin has storage of its own, so its first load gets it here
  // (emulation.ts keeps only the colour scheme in a frame).
  void us
    .execute({
      target: { tabId: d.tabId, frameIds: [d.frameId] },
      injectImmediately: true,
      js: [{ code: `${markerCode(features)}\n${ATELIER_PAGE}\n__atelierPage.emulation.start();` }],
    })
    .catch(() => {});
});

/** Applies a tab's recorded emulation: pages decide their layout and scheme
 * as they load, so it takes a fresh load. */
async function reloadEmulated(tabId: number, params: any, ctx: ToolContext) {
  await run(tabId, `${markerCode(agentTabs.features(tabId))} 0`);
  await browser.tabs.reload(tabId);
  return afterLoad(tabId, params, ctx, await settled(tabId));
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
      await call(tabId, "forceState", f.selector, f.states);
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
    // A throwaway container: the user's cookies for the site, nothing else of theirs.
    let container: { cookieStoreId: string; copied: number } | null = null;
    if (param<boolean>(params, "throwaway", "boolean", false)) {
      try {
        container = await containers.fork(url, param<string>(params, "from", "string", "firefox-default"), param<boolean>(params, "cookies", "boolean", true));
      } catch (e) {
        throw new RpcError(PAGE_ERROR, `couldn't make a throwaway container: ${e instanceof Error ? e.message : e} (Firefox's containers may be turned off)`);
      }
    }
    // Bound before anything loads, so the first load already shows the task's tree.
    const cookies = container ? { cookieStoreId: container.cookieStoreId } : {};
    const agent = param<string | null>(params, "agent", "string", null);
    // In a window of the session's own (`[session] windows`), out of the user's way,
    // and the active tab there, so it renders as a visible page does.
    let window: { id: number; created: boolean } | undefined;
    let tab: browser.tabs.Tab;
    if (agent !== null && param<boolean>(params, "window", "boolean", false)) {
      const existing = await agentTabs.windowOf(agent);
      if (existing !== undefined) {
        tab = await browser.tabs.create({ url: "about:blank", windowId: existing, active: true, ...cookies });
        window = { id: existing, created: false };
      } else {
        const w = await browser.windows.create({ url: "about:blank", focused: false, ...cookies });
        tab = w.tabs![0];
        await agentTabs.setWindow(agent, w.id!);
        window = { id: w.id!, created: true };
      }
    } else {
      tab = await browser.tabs.create({ url: "about:blank", active: false, ...cookies });
    }
    await agentTabs.add(tab.id!, { ...(container ? { throwaway: container.cookieStoreId } : {}), ...(agent !== null ? { agent } : {}) });
    if (task !== null) {
      try {
        await ctx.bind(tab.id!, task);
      } catch (e) {
        await browser.tabs.remove(tab.id!);
        throw sourceError(task, e);
      }
    }
    await browser.tabs.update(tab.id!, { url });
    const result = { ...(await afterLoad(tab.id!, params, ctx, await settled(tab.id!))), ...(window ? { window } : {}) };
    return container ? { ...result, cookiesCopied: container.copied } : result;
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
    return afterLoad(tab.id!, params, ctx, await settled(tab.id!));
  },

  async "tab/reload"(params, ctx) {
    const tab = await agentTab(params);
    await browser.tabs.reload(tab.id!);
    return afterLoad(tab.id!, {}, ctx, await settled(tab.id!));
  },

  async "tab/list"(_params, ctx) {
    await loaded;
    const tabs = await Promise.all(agentTabs.ids().map((id) => browser.tabs.get(id).catch(() => null)));
    return { tabs: tabs.filter((t): t is browser.tabs.Tab => Boolean(t)).map((t) => describeTab(t, ctx)) };
  },

  /** An agent session ended (its harness closed): its tabs go with it. */
  async "agent/end"(params) {
    return { closed: await agentTabs.end(param<string>(params, "agent", "string")) };
  },

  async "tab/close"(params) {
    const tab = await agentTab(params);
    await browser.tabs.remove(tab.id!);
    await agentTabs.forget(tab.id!);
    return { closed: tab.id };
  },

  async "page/screenshot"(params, ctx) {
    const tab = await agentTab(params);
    // Saves just made should show: wait until their styles have reached the page.
    await ctx.settle(ctx.sourceOf(tab.id!) ?? undefined);
    await new Promise((r) => setTimeout(r, 150));
    const extraCss = param<string | null>(params, "extraCss", "string", null);
    if (extraCss !== null) await call(tab.id!, "extraCss", extraCss);
    const selector = param<string | null>(params, "selector", "string", null);
    const full = param<boolean>(params, "fullPage", "boolean", false);
    const format = param<string>(params, "format", "string", "png");
    if (format !== "png" && format !== "jpeg") throw new RpcError(INVALID_PARAMS, "`format` must be png or jpeg");
    const notes: string[] = [];
    if (param<boolean>(params, "settleAnimations", "boolean", true)) await call(tab.id!, "finishAnimations");
    await call(tab.id!, "imagesReady", 3000);
    await call(tab.id!, "syncEmulation");
    const viewport = agentTabs.get(tab.id!)?.viewport;
    if (viewport) notes.push(`This tab lays out as if its viewport were ${viewport.width}×${viewport.height} (viewport); ${VIEWPORT_NOTE}`);
    const emulated = agentTabs.get(tab.id!)?.scheme;
    if (emulated) {
      notes.push(`This tab emulates the ${emulated} colour scheme (color_scheme); it isn't the user's setting.`);
      const gaps = await schemeGaps(tab.id!).catch(() => null);
      if (gaps) notes.push(gaps.note);
    }
    if (!tab.active && !toldHidden.has(tab.id!)) {
      notes.push(HIDDEN_NOTE);
      toldHidden.add(tab.id!);
    }

    let rect: { x: number; y: number; width: number; height: number } | undefined;
    if (selector) {
      const r = (await call(tab.id!, "rectOf", selector)) as typeof rect | null;
      if (!r) throw new RpcError(PAGE_ERROR, `no element matches \`${selector}\``);
      if (r!.width === 0 || r!.height === 0) throw new RpcError(PAGE_ERROR, `\`${selector}\` matches an element with no size (hidden?)`);
      // A very tall element (a long sidebar's contents) makes an unreadable
      // strip, or fails to capture at all: take its top.
      const maxHeight = param<number>(params, "maxHeight", "number", 4000);
      if (r!.height > maxHeight) {
        notes.push(`\`${selector}\` is ${Math.round(r!.height)}px tall; captured its top ${maxHeight}px (raise maxHeight, or pick a smaller element).`);
        r!.height = maxHeight;
      }
      rect = r;
    } else if (full) {
      const s = (await call(tab.id!, "pageState")) as { width: number; height: number };
      const maxHeight = param<number>(params, "maxHeight", "number", 4000);
      rect = { x: 0, y: 0, width: s.width, height: Math.min(s.height, maxHeight) };
      if (s.height > maxHeight) notes.push(`The page is ${s.height}px tall; captured the top ${maxHeight}px (raise maxHeight, or capture elements with \`selector\`).`);
      if (viewport) rect.width = viewport.width;
    } else if (viewport) {
      // The emulated viewport, at the current scroll position.
      const s = (await call(tab.id!, "pageState")) as { scrollY: number };
      rect = { x: 0, y: s.scrollY, width: viewport.width, height: viewport.height };
    }
    const scale = param<number>(params, "scale", "number", 1);
    if (scale <= 0 || scale > 8) throw new RpcError(INVALID_PARAMS, "`scale` must be between 0 and 8");
    let dataUrl: string;
    try {
      dataUrl = await (browser.tabs as any).captureTab(tab.id, {
        format,
        ...(format === "jpeg" ? { quality: 85 } : {}),
        ...(rect ? { rect } : {}),
        ...(scale !== 1 ? { scale } : {}),
      });
    } finally {
      if (extraCss !== null) await call(tab.id!, "extraCss", null);
    }
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
    const r = await call(tab.id!, "fill", selector, param<string>(params, "text", "string"), param<boolean>(params, "submit", "boolean", false));
    if (r === null) throw new RpcError(PAGE_ERROR, `no element matches \`${selector}\`, in the page or its open shadow roots`);
    if ((r as { error?: string }).error) throw new RpcError(PAGE_ERROR, (r as { error: string }).error);
    await new Promise((res) => setTimeout(res, 300)); // let the page react
    return r;
  },

  async "page/query"(params) {
    const tab = await agentTab(params);
    return call(
      tab.id!,
      "query",
      param<string>(params, "selector", "string"),
      param<number>(params, "limit", "number", 10),
      param<number>(params, "maxLength", "number", 500),
    );
  },

  async "page/computed"(params) {
    const tab = await agentTab(params);
    const selector = param<string>(params, "selector", "string");
    // Values mid-transition aren't the ones a page settles on.
    await call(tab.id!, "finishAnimations");
    const r = await call(tab.id!, "computed", selector, params?.properties ?? null);
    if (r === null) throw new RpcError(PAGE_ERROR, `no element matches \`${selector}\``);
    return r;
  },

  async "page/tokens"(params) {
    const tab = await agentTab(params);
    await fetchUnreadable(tab.id!);
    const maxChars = param<number>(params, "maxChars", "number", 30_000);
    const r = (await call(
      tab.id!,
      "tokens",
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
    await fetchUnreadable(tab.id!);
    const selector = param<string>(params, "selector", "string");
    const r = await call(
      tab.id!,
      "matchedRules",
      selector,
      param<string | null>(params, "property", "string", null),
      param<number>(params, "limit", "number", 30),
    );
    if (r === null) throw new RpcError(PAGE_ERROR, `no element matches \`${selector}\``);
    return r;
  },

  async "page/contrast"(params) {
    const tab = await agentTab(params);
    // Colours mid-transition (just after a hover, or a colour-scheme switch) aren't the ones to judge.
    await call(tab.id!, "finishAnimations");
    return call(tab.id!, "contrast", param<number>(params, "minRatio", "number", 4.5), param<number>(params, "limit", "number", 40), param<string | null>(params, "exclude", "string", null));
  },

  async "page/shapes"(params) {
    const tab = await agentTab(params);
    const scope = param<string | null>(params, "scope", "string", null);
    await call(tab.id!, "finishAnimations");
    const r = await call(tab.id!, "shapeScan", scope, param<number>(params, "limit", "number", 40));
    if (r === null) throw new RpcError(PAGE_ERROR, `no element matches \`${scope}\``);
    return r;
  },

  async "tab/color_scheme"(params, ctx) {
    const tab = await agentTab(params);
    const scheme = param<string | null>(params, "scheme", "string", null);
    if (scheme !== null && scheme !== "light" && scheme !== "dark") throw new RpcError(INVALID_PARAMS, "`scheme` is light, dark or null");
    await agentTabs.update(tab.id!, { scheme: scheme ?? undefined });
    const loaded = await reloadEmulated(tab.id!, params, ctx);
    const gaps = scheme === null ? null : await schemeGaps(tab.id!);
    return gaps ? { ...loaded, notEmulated: gaps } : loaded;
  },

  async "tab/viewport"(params, ctx) {
    const tab = await agentTab(params);
    const width = param<number | null>(params, "width", "number", null);
    const height = param<number | null>(params, "height", "number", null);
    if (width === null) {
      await agentTabs.update(tab.id!, { viewport: undefined });
    } else {
      if (width < 200 || width > 4000) throw new RpcError(INVALID_PARAMS, "`width` is in CSS pixels, between 200 and 4000");
      const h = height ?? Math.round(width * (width < 600 ? 2.16 : 0.75));
      if (h < 200 || h > 4000) throw new RpcError(INVALID_PARAMS, "`height` is in CSS pixels, between 200 and 4000");
      await agentTabs.update(tab.id!, { viewport: { width, height: h } });
    }
    const loaded = await reloadEmulated(tab.id!, params, ctx);
    const viewport = agentTabs.get(tab.id!)?.viewport;
    return viewport ? { ...loaded, viewport, note: VIEWPORT_NOTE } : loaded;
  },

  async "page/force_state"(params) {
    const tab = await agentTab(params);
    const selector = param<string>(params, "selector", "string");
    const states = params?.states ?? [];
    if (!Array.isArray(states)) throw new RpcError(INVALID_PARAMS, "`states` must be an array");
    const r = (await call(tab.id!, "forceState", selector, states)) as any;
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
      const applying = (bundle?.styles ?? []).filter((s) => tab.url && cssFor(s, tab.url) !== null).map((s) => s.id);
      const inPage = (await call(tab.id!, "atelierStyleCheck").catch(() => null)) as { present: string[]; dropped: { style: string; selector: string; effect: string }[] } | null;
      const missing = inPage ? applying.filter((id) => !inPage.present.includes(id)) : [];
      out.tab = {
        ...describeTab(tab, ctx),
        applying,
        shim: ctx.hasShim(tab.id!),
        unmetPrerequisites: ctx.unmet(tab.id!),
        ...(missing.length
          ? { notInPage: missing, notInPageNote: "These should apply to this page but aren't in it, so the page doesn't show them. tab_reload usually fixes it; if it doesn't, say so in your feedback." }
          : {}),
        ...(inPage?.dropped.length
          ? {
              droppedSelectors: inPage.dropped,
              droppedNote: "Firefox can't use these selectors, and says nothing. \"dropped\": it can't parse the selector, so the whole rule is thrown away. \"ignored\": inside :is() or :where(), which forgive what they can't parse, so the rule stays but those arguments match nothing; usually a pseudo-element (::before) or a leading > inside :is(). Write those outside the :is(), e.g. :is(.a, .b)::before.",
            }
          : {}),
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
