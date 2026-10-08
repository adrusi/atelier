// The fidelity harness (ARCHITECTURE.md, "Dev tooling that keeps it honest"):
// renders a page twice in one dev instance, once for real and once through
// atelier's in-page emulation, and diffs the two: every computed style of
// every element (open shadow roots and ::before/::after included), element
// geometry, which image a <picture> chose, and pixels. Emulation fails in
// subtle ways (a sheet it didn't rewrite, a mechanism it doesn't know about);
// this is how those get noticed, and how fixes get measured.
//
// Ground truth for the colour scheme is Firefox's own per-tab override
// (BrowsingContext.prefersColorSchemeOverride, what devtools uses), reached
// through BiDi's chrome scope, which needs an instance started with
// --system-access; for a viewport size, it's BiDi's setViewport. The tabs
// are background tabs in the same browser, loading the same URL: for a
// colour scheme all the same size; for a viewport, the emulated tab keeps
// a different real size (so emulation has work to do), and its screenshot
// is clipped to the emulated viewport.
//
// Real pages vary from one load to the next (ads, rotating content, clocks),
// so the real page is loaded twice, and whatever differs between those two
// loads is noise: it's left out of the comparison, and counted. What varies
// on every load but not between two (ad slots, typically) can be left out
// with --ignore: matching elements, their subtrees and their pixels.
//
//   node dev/fidelity.ts [--instance NAME] [--scheme dark|light | --viewport 390x844]
//                        [--size 1280x800] [--out DIR] [--no-emulation]
//                        [--ignore SELECTOR]... [--scroll Y] URL...
//
// Without --instance it starts its own (with the fixture server, so
// fixtures can be named as /color-scheme/ etc.) and stops it afterwards.
// Reports go to stdout as JSON; images to --out (default
// $XDG_RUNTIME_DIR/atelier-dev/fidelity-reports/). --no-emulation leaves the
// emulated tab alone: a control, which should show every difference the
// emulation is there to remove.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Bidi, Bidi as BidiClient, evaluate } from "./bidi.ts";
import * as png from "./png.ts";

export type Emulation =
  | { feature: "prefers-color-scheme"; value: "light" | "dark" }
  | { feature: "viewport"; width: number; height: number };

const describeEmulation = (e: Emulation) =>
  e.feature === "viewport" ? `viewport ${e.width}×${e.height}` : `${e.feature}: ${e.value}`;

type Snapshot = {
  props: string[];
  elements: { path: string; rect: number[]; values: string[]; src?: string }[];
  rootCustom: Record<string, string>;
  truncated: boolean;
  frames: number;
  /** Viewport boxes of the elements left out with --ignore. */
  ignored: number[][];
};

export type Report = {
  url: string;
  emulation: Emulation;
  size: { width: number; height: number };
  elements: { compared: number; onlyTruth: string[]; onlyEmulated: string[]; truncated: boolean; frames: number };
  /** What varied between two real loads, and so was left out. */
  noise: { styles: number; geometry: number; images: number; elements: number; pixels: number };
  /** Left out with --ignore: elements (with their subtrees) and pixels. */
  ignored: { elements: number; pixels: number };
  /** Differences that render the same (see EQUIVALENT), counted, not hidden. */
  equivalent: { property: string; elements: number; why: string }[];
  /** Computed properties that differ, with how many elements and examples. */
  styles: { property: string; elements: number; examples: { element: string; truth: string; emulated: string }[] }[];
  /** Custom properties on the root that differ. */
  rootCustom: { property: string; truth: string; emulated: string }[];
  /** Elements whose size differs, and those that only moved (usually
   * because something before them changed size). */
  geometry: { resized: number; moved: number; examples: { element: string; truth: number[]; emulated: number[] }[] };
  images: { element: string; truth: string; emulated: string }[];
  pixels: {
    differing: number;
    total: number;
    ratio: number;
    /** The elements the differing pixels are in: the smallest boxes holding
     * most of them, for pixel-only differences (images, frames, canvases). */
    in: { element: string; pixels: number; ofBox: number }[];
  };
  files: { truth: string; emulated: string; diff: string };
};

const RUNTIME = path.join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "atelier-dev");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Runs in each tab: a snapshot of every rendered element, in tree order,
 * across open shadow roots, skipping what atelier itself adds. */
const snapshotCode = (ignore: string[]) => `(() => {
  const IGNORE = ${JSON.stringify(ignore.join(", "))};
  const ignored = [];
  const MAX = 3000;
  const ATELIER = "[data-atelier], [data-atelier-extra], [data-atelier-scheme-force], [data-atelier-scheme-copy], [data-atelier-force], meta[name=darkreader-lock]";
  const UNRENDERED = new Set(["HEAD", "SCRIPT", "STYLE", "LINK", "META", "TITLE", "TEMPLATE", "NOSCRIPT"]);
  const props = [...getComputedStyle(document.documentElement)].filter((p) => !p.startsWith("--")).sort();
  const elements = [];
  let truncated = false;
  let frames = 0;
  const record = (el, p) => {
    if (elements.length >= MAX) { truncated = true; return; }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const entry = { path: p, rect: [r.left + scrollX, r.top + scrollY, r.width, r.height].map((v) => Math.round(v * 100) / 100), values: props.map((n) => cs.getPropertyValue(n)) };
    if (el instanceof HTMLImageElement) entry.src = el.currentSrc;
    elements.push(entry);
    for (const pseudo of ["::before", "::after"]) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content && ps.content !== "none" && ps.content !== "normal") elements.push({ path: p + pseudo, rect: [], values: props.map((n) => ps.getPropertyValue(n)) });
    }
  };
  const walk = (parent, prefix) => {
    const counts = new Map();
    for (const el of parent.children) {
      if (el.matches(ATELIER) || UNRENDERED.has(el.tagName)) continue;
      if (IGNORE && el.matches(IGNORE)) {
        const r = el.getBoundingClientRect();
        ignored.push([r.left, r.top, r.width, r.height]);
        continue;
      }
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") frames++;
      const tag = el.tagName.toLowerCase();
      const n = (counts.get(tag) ?? 0) + 1;
      counts.set(tag, n);
      // By tag and position only: ids are often generated afresh on each
      // load (React's, components' labels), which would break matching.
      const p = prefix + "/" + tag + "[" + n + "]";
      record(el, p);
      if (el.shadowRoot) walk(el.shadowRoot, p + "::shadow");
      walk(el, p);
    }
  };
  const root = document.documentElement;
  record(root, "html");
  walk(root, "html");
  const rootStyle = getComputedStyle(root);
  const rootCustom = {};
  for (const n of rootStyle) if (n.startsWith("--")) rootCustom[n] = rootStyle.getPropertyValue(n).trim();
  return JSON.stringify({ props, elements, rootCustom, truncated, frames, ignored });
})()`;

/** Runs in each tab before it's compared: waits until the page is at least
 * 3s old and its DOM has been quiet for a second (up to 10s), so pages that
 * add content on timers are compared at the same point; then finishes
 * animations and waits for images and fonts. */
const SETTLE = `(async () => {
  let last = performance.now();
  const observer = new MutationObserver(() => (last = performance.now()));
  observer.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  while (performance.now() < 10000 && (performance.now() < 3000 || performance.now() - last < 1000)) await new Promise((r) => setTimeout(r, 100));
  observer.disconnect();
  for (const a of document.getAnimations()) { try { a.finish(); } catch {} }
  await Promise.race([Promise.all([...document.images].map((i) => i.decode().catch(() => {}))), new Promise((r) => setTimeout(r, 3000))]);
  await document.fonts.ready;
  return true;
})()`;

async function contextWithUrl(bidi: Bidi, suffix: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { contexts } = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
    const hit = contexts.find((c: { url: string }) => c.url.endsWith(suffix));
    if (hit) return hit.context;
    if (Date.now() > deadline) throw new Error(`no tab showing …${suffix}`);
    await sleep(250);
  }
}

/** Navigates or reloads, waiting for the load. A page that navigates
 * itself while loading (a redirect in script, an emulation that corrects
 * its marker) aborts the wait; then wait for whatever load replaced it. */
async function load(bidi: Bidi, method: string, params: { context: string }) {
  try {
    await bidi.send(method, params);
  } catch (e) {
    if (!/NS_BINDING_ABORTED/.test((e as Error).message)) throw e;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await sleep(250);
      try {
        if ((await evaluate(bidi, params.context, "document.readyState")) === "complete") return;
      } catch {
        // Between documents.
      }
    }
  }
}

/** Sets Firefox's own colour-scheme override on the tab showing `suffix`. */
async function overrideScheme(bidi: Bidi, suffix: string, value: string) {
  const { contexts } = await bidi.send("browsingContext.getTree", { "moz:scope": "chrome" });
  const window = contexts[0]?.context;
  if (!window) throw new Error("no chrome window: was the instance started with --system-access?");
  const r = await bidi.send("script.evaluate", {
    expression: `(() => {
      const bc = [...gBrowser.browsers].map((b) => b.browsingContext).find((bc) => bc?.currentURI?.spec.endsWith(${JSON.stringify(suffix)}));
      if (!bc) return "missing";
      bc.prefersColorSchemeOverride = ${JSON.stringify(value)};
      return bc.prefersColorSchemeOverride;
    })()`,
    target: { context: window },
    awaitPromise: true,
  });
  if (r.type !== "success" || r.result.value !== value) throw new Error(`couldn't set the override: ${JSON.stringify(r)}`);
}

/** Pixels that differ by more than antialiasing would. */
function pixelsDiffer(a: png.Image, b: png.Image): Uint8Array {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      const delta = Math.max(Math.abs(a.data[i] - b.data[j]), Math.abs(a.data[i + 1] - b.data[j + 1]), Math.abs(a.data[i + 2] - b.data[j + 2]));
      out[y * width + x] = delta > 24 ? 1 : 0;
    }
  }
  return out;
}

/** The pixel comparison, leaving out pixels that differed between the two
 * real loads. The diff image shows the real page faded, differences in red
 * noise in yellow, and what --ignore left out in blue. */
function diffPixels(truth: png.Image, emulated: png.Image, again: png.Image, masked: number[][]) {
  const width = Math.min(truth.width, emulated.width);
  const height = Math.min(truth.height, emulated.height);
  const differ = pixelsDiffer(truth, emulated);
  const noisy = pixelsDiffer(truth, again);
  const diff = { width, height, data: new Uint8Array(width * height * 4) };
  let differing = 0;
  let noise = 0;
  let ignored = 0;
  const mask = new Uint8Array(width * height);
  for (const [left, top, w, h] of masked) {
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.ceil(top + h)); y++) {
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(width, Math.ceil(left + w)); x++) mask[y * width + x] = 1;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = y * width + x;
      const i = (y * truth.width + x) * 4;
      if (mask[k]) {
        ignored++;
        diff.data.set([90, 90, 200, 255], k * 4);
      } else if (noisy[k]) {
        noise++;
        diff.data.set([240, 200, 0, 255], k * 4);
      } else if (differ[k]) {
        differing++;
        diff.data.set([255, 0, 0, 255], k * 4);
      } else {
        const grey = Math.round((truth.data[i] + truth.data[i + 1] + truth.data[i + 2]) / 3 / 4 + 160);
        diff.data.set([grey, grey, grey, 255], k * 4);
      }
    }
  }
  return { differing, noise, ignored, total: width * height, diff, mask: { width, height, differ, skip: (k: number) => mask[k] || noisy[k] } };
}

/** Computed values that differ in ways that can't show, because of how
 * emulation works. Each says why; anything not listed here is a difference. */
/** What an equivalence check knows besides the two values. */
type Context = { emulation: Emulation; element: string; scrollY: number };
type Same = (truth: string, emulated: string, c: Context) => boolean;

/** The root's box under viewport emulation: it's the emulated viewport's
 * size, with an identity transform, to be the containing block that
 * position: fixed elements lay out in; content overflows it as it would the
 * viewport. Its own size, and the origins derived from it, differ. */
const ROOT_BOX = "viewport emulation makes the root the emulated viewport's size, with an identity transform, as the containing block for position: fixed elements; the page overflows it as it would the viewport";
const rootBox = (check: Same): { why: string; same: Same } => ({
  why: ROOT_BOX,
  same: (t, e, c) => c.emulation.feature === "viewport" && c.element === "html" && check(t, e, c),
});

const EQUIVALENT: Record<string, { why: string; same: Same }> = {
  transform: rootBox((t, e) => t === "none" && e === "matrix(1, 0, 0, 1, 0, 0)"),
  height: rootBox((_, e, { emulation: em }) => em.feature === "viewport" && e === `${em.height}px`),
  "block-size": rootBox((_, e, { emulation: em }) => em.feature === "viewport" && e === `${em.height}px`),
  translate: {
    why: "viewport emulation moves position: fixed elements down by the scroll offset, to keep them in the emulated viewport as the page scrolls",
    same: (t, e, c) => c.emulation.feature === "viewport" && t === "none" && e === `0px ${c.scrollY}px`,
  },
  "transform-origin": rootBox(() => true),
  "perspective-origin": rootBox(() => true),
  "color-scheme": {
    why: "emulation narrows a page's offered schemes to the emulated one (light dark → dark); the scheme in use is the same",
    same: (t, e, { emulation: em }) => {
      const used = (v: string) => {
        const w = v.split(/\s+/);
        const value = em.feature === "prefers-color-scheme" ? em.value : "light";
        return w.includes(value) ? value : w.includes("light") ? "light" : w.includes("dark") ? "dark" : "light";
      };
      if (em.feature !== "prefers-color-scheme") return false;
      return used(t) === used(e);
    },
  },
};

/** Where the differing pixels are: elements whose box holds many of them,
 * smallest first, leaving out ancestors of elements already named. */
function locatePixels(snap: Snapshot, m: { width: number; height: number; differ: Uint8Array; skip: (k: number) => boolean }) {
  const scored: { element: string; pixels: number; ofBox: number; area: number }[] = [];
  for (const e of snap.elements) {
    if (e.rect.length < 4 || e.rect[2] < 1 || e.rect[3] < 1) continue;
    const [left, top, w, h] = e.rect;
    let n = 0;
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(m.height, Math.ceil(top + h)); y++) {
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(m.width, Math.ceil(left + w)); x++) {
        const k = y * m.width + x;
        if (m.differ[k] && !m.skip(k)) n++;
      }
    }
    if (n >= 20) scored.push({ element: e.path, pixels: n, ofBox: Math.round((n / (w * h)) * 100) / 100, area: w * h });
  }
  scored.sort((a, b) => a.area - b.area);
  const out: typeof scored = [];
  for (const s of scored) {
    if (out.some((o) => o.element.startsWith(s.element))) continue; // an ancestor of one already named
    out.push(s);
    if (out.length >= 8) break;
  }
  return out.map(({ area: _, ...o }) => o);
}

/** Whether two computed values are the same, allowing numbers to differ by
 * up to 0.05 (sub-pixel rounding, which can't show). */
function same(a: string, b: string): boolean {
  if (a === b) return true;
  const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
  if (a.replace(NUM, "#") !== b.replace(NUM, "#")) return false;
  const x = a.match(NUM) ?? [];
  const y = b.match(NUM) ?? [];
  return x.length === y.length && x.every((n, i) => Math.abs(Number(n) - Number(y[i])) <= 0.05);
}

/** Custom properties keep viewport units as text (50vw), where viewport
 * emulation has turned them into pixels of the emulated viewport (195px):
 * the same value. As the emulation does it (page/emulation.ts). */
const CUSTOM_UNITS = "custom properties keep viewport units as written (50vw); emulation has turned them into the emulated viewport's pixels (195px), the same value";
function pxForViewportUnits(text: string, e: { width: number; height: number }): string {
  return text.replace(/(-?\d*\.?\d+)([sld]?)(vw|vh|vmin|vmax|vi|vb)\b/gi, (_, n: string, _v: string, unit: string) => {
    const u = unit.toLowerCase();
    const base = u === "vw" || u === "vi" ? e.width : u === "vh" || u === "vb" ? e.height : u === "vmin" ? Math.min(e.width, e.height) : Math.max(e.width, e.height);
    return `${Math.round(Number(n) * base * 100) / 10000}px`;
  });
}

/** Every difference between two snapshots, by element. */
function differences(a: Snapshot, b: Snapshot) {
  const byPath = new Map(b.elements.map((e) => [e.path, e]));
  const aPaths = new Set(a.elements.map((e) => e.path));
  const styles: { path: string; property: string; a: string; b: string }[] = [];
  const geometry: { path: string; resized: boolean; a: number[]; b: number[] }[] = [];
  const images: { path: string; a: string; b: string }[] = [];
  let compared = 0;
  for (const x of a.elements) {
    const y = byPath.get(x.path);
    if (!y) continue;
    compared++;
    x.values.forEach((value, i) => {
      if (!same(value, y.values[i])) styles.push({ path: x.path, property: a.props[i], a: value, b: y.values[i] });
    });
    if (x.rect.length && x.rect.some((v, i) => Math.abs(v - y.rect[i]) > 0.5)) {
      const resized = Math.abs(x.rect[2] - y.rect[2]) > 0.5 || Math.abs(x.rect[3] - y.rect[3]) > 0.5;
      geometry.push({ path: x.path, resized, a: x.rect, b: y.rect });
    }
    if ((x.src ?? "") !== (y.src ?? "")) images.push({ path: x.path, a: x.src ?? "", b: y.src ?? "" });
  }
  const rootCustom = [...new Set([...Object.keys(a.rootCustom), ...Object.keys(b.rootCustom)])]
    .filter((k) => a.rootCustom[k] !== b.rootCustom[k])
    .map((property) => ({ property, a: a.rootCustom[property] ?? "(unset)", b: b.rootCustom[property] ?? "(unset)" }));
  return {
    compared,
    onlyA: a.elements.filter((e) => !byPath.has(e.path)).map((e) => e.path),
    onlyB: b.elements.filter((e) => !aPaths.has(e.path)).map((e) => e.path),
    styles,
    geometry,
    images,
    rootCustom,
  };
}

function compareSnapshots(truth: Snapshot, emulated: Snapshot, again: Snapshot, emulation: Emulation, scrollY = 0) {
  const real = differences(truth, emulated);
  const noise = differences(truth, again);
  const noisyStyles = new Set(noise.styles.map((d) => `${d.path}\n${d.property}`));
  const noisyGeometry = new Set(noise.geometry.map((d) => d.path));
  const noisyImages = new Set(noise.images.map((d) => d.path));
  const noisyElements = new Set([...noise.onlyA, ...noise.onlyB]);
  const noisyCustom = new Set(noise.rootCustom.map((d) => d.property));
  const counted = { styles: 0, geometry: 0, images: 0 };

  const styles = new Map<string, { elements: number; examples: { element: string; truth: string; emulated: string }[] }>();
  const equivalent = new Map<string, number>();
  for (const d of real.styles) {
    if (noisyStyles.has(`${d.path}\n${d.property}`) || noisyElements.has(d.path)) {
      counted.styles++;
      continue;
    }
    if (EQUIVALENT[d.property]?.same(d.a, d.b, { emulation, element: d.path, scrollY })) {
      equivalent.set(d.property, (equivalent.get(d.property) ?? 0) + 1);
      continue;
    }
    const s = styles.get(d.property) ?? { elements: 0, examples: [] };
    s.elements++;
    if (s.examples.length < 3) s.examples.push({ element: d.path, truth: d.a, emulated: d.b });
    styles.set(d.property, s);
  }
  // The root's own box under viewport emulation (ROOT_BOX).
  const rootBoxed = (d: { path: string; b: number[] }) =>
    emulation.feature === "viewport" && d.path === "html" && d.b[2] === emulation.width && d.b[3] === emulation.height;
  for (const d of real.geometry) if (rootBoxed(d)) equivalent.set("(box)", (equivalent.get("(box)") ?? 0) + 1);
  const kept = real.geometry.filter((d) => !noisyGeometry.has(d.path) && !noisyElements.has(d.path) && !rootBoxed(d));
  counted.geometry = real.geometry.length - kept.length;
  const geometry: Report["geometry"] = {
    resized: kept.filter((d) => d.resized).length,
    moved: kept.filter((d) => !d.resized).length,
    // Resized elements are the causes; shown first.
    examples: [...kept.filter((d) => d.resized), ...kept.filter((d) => !d.resized)]
      .slice(0, 5)
      .map((d) => ({ element: d.path, truth: d.a, emulated: d.b })),
  };
  const images: Report["images"] = [];
  for (const d of real.images) {
    if (noisyImages.has(d.path) || noisyElements.has(d.path)) counted.images++;
    else images.push({ element: d.path, truth: d.a, emulated: d.b });
  }
  return {
    elements: {
      compared: real.compared,
      onlyTruth: real.onlyA.filter((p) => !noisyElements.has(p)).slice(0, 20),
      onlyEmulated: real.onlyB.filter((p) => !noisyElements.has(p)).slice(0, 20),
      truncated: truth.truncated || emulated.truncated,
      frames: truth.frames,
    },
    noise: { ...counted, elements: noisyElements.size, pixels: 0 },
    ignored: { elements: truth.ignored.length, pixels: 0 },
    equivalent: [...equivalent].map(([property, elements]) => ({
      property,
      elements,
      why: EQUIVALENT[property]?.why ?? (property === "custom properties" ? CUSTOM_UNITS : ROOT_BOX),
    })),
    styles: [...styles].map(([property, s]) => ({ property, ...s })).sort((a, b) => b.elements - a.elements),
    rootCustom: real.rootCustom
      .filter((d) => !noisyCustom.has(d.property))
      .filter((d) => {
        if (emulation.feature !== "viewport" || pxForViewportUnits(d.a, emulation) !== d.b) return true;
        equivalent.set("custom properties", (equivalent.get("custom properties") ?? 0) + 1);
        return false;
      })
      .map((d) => ({ property: d.property, truth: d.a, emulated: d.b })),
    geometry,
    images,
  };
}

/** Compares `url` rendered with the emulated feature for real and through
 * atelier, in the running instance `instance`. */
export async function compare(
  instance: string,
  url: string,
  emulation: Emulation,
  opts: { width?: number; height?: number; out?: string; emulate?: boolean; ignore?: string[]; scrollY?: number } = {},
): Promise<Report> {
  const state = JSON.parse(fs.readFileSync(path.join(RUNTIME, instance, "state.json"), "utf8"));
  const size = { width: opts.width ?? 1280, height: opts.height ?? 800 };
  const slug = url.replace(/^\w+:\/\//, "").replace(/[^\w.-]+/g, "_").slice(0, 80);
  const out = path.join(opts.out ?? path.join(RUNTIME, "fidelity-reports"), slug);
  fs.mkdirSync(out, { recursive: true });
  const atelier = (method: string, params: object) => JSON.parse(dev("atelier", instance, "browser", method, JSON.stringify(params)));
  const base = url.split("#")[0];

  // The emulated tab: an agent tab, through atelier's own tools.
  const agentTab = atelier("tab/open", { url: `${base}#atelier-emulated` }).tab as number;
  if (opts.emulate !== false) {
    if (emulation.feature === "viewport") atelier("tab/viewport", { tab: agentTab, width: emulation.width, height: emulation.height });
    else atelier("tab/color_scheme", { tab: agentTab, scheme: emulation.value });
  }
  // The real tabs' size: the emulated one for a viewport (that's the truth).
  const realSize = emulation.feature === "viewport" ? { width: emulation.width, height: emulation.height } : size;
  // The emulated tab's: for a viewport, a different one, at least as tall.
  const emulatedSize = emulation.feature === "viewport"
    ? { width: emulation.width === size.width ? size.width + 200 : size.width, height: Math.max(size.height, emulation.height + 150) }
    : size;
  /** Makes a real tab real: the override for a scheme (size is set already). */
  const makeReal = async (bidi: Bidi, suffix: string) => {
    if (emulation.feature === "prefers-color-scheme") await overrideScheme(bidi, suffix, emulation.value);
  };

  const bidi = await BidiClient.connect(state.bidiPort);
  try {
    await bidi.send("session.new", { capabilities: {} });
    // The truth: an ordinary tab, with Firefox's own override.
    const { context: truth } = await bidi.send("browsingContext.create", { type: "tab", background: true });
    await bidi.send("browsingContext.setViewport", { context: truth, viewport: realSize });
    await load(bidi, "browsingContext.navigate", { context: truth, url: `${base}#atelier-truth`, wait: "complete" });
    await makeReal(bidi, "#atelier-truth");
    await load(bidi, "browsingContext.reload", { context: truth, wait: "complete" });
    // The real page again, for what varies between loads anyway.
    const { context: again } = await bidi.send("browsingContext.create", { type: "tab", background: true });
    await bidi.send("browsingContext.setViewport", { context: again, viewport: realSize });
    await load(bidi, "browsingContext.navigate", { context: again, url: `${base}#atelier-again`, wait: "complete" });
    await makeReal(bidi, "#atelier-again");
    await load(bidi, "browsingContext.reload", { context: again, wait: "complete" });

    // Loaded again at the same size as the others: pages lay out (and
    // scroll things into view) as they load.
    const emulated = await contextWithUrl(bidi, "#atelier-emulated");
    await bidi.send("browsingContext.setViewport", { context: emulated, viewport: emulatedSize });
    await load(bidi, "browsingContext.reload", { context: emulated, wait: "complete" });
    await sleep(1000); // late layout, the shims and the emulation's rescans
    for (const c of [truth, emulated, again]) await evaluate(bidi, c, SETTLE);
    if (opts.scrollY) {
      for (const c of [truth, emulated, again]) await evaluate(bidi, c, `scrollTo(0, ${opts.scrollY}), 0`);
      // Background tabs get no scroll events; emulation's timer, throttled
      // to about a second there, places fixed elements.
      await sleep(1500);
    }
    await sleep(300);

    const snap = async (c: string) => JSON.parse((await evaluate(bidi, c, snapshotCode(opts.ignore ?? []))) as string) as Snapshot;
    const shot = async (c: string) => {
      // The emulated viewport of the emulated tab: the top left of its document.
      const clip = c === emulated && emulation.feature === "viewport"
        ? { origin: "document", clip: { type: "box", x: 0, y: opts.scrollY ?? 0, width: emulation.width, height: emulation.height } }
        : {};
      return Buffer.from((await bidi.send("browsingContext.captureScreenshot", { context: c, ...clip })).data, "base64");
    };
    const [truthSnap, emulatedSnap, againSnap] = [await snap(truth), await snap(emulated), await snap(again)];
    const [truthPng, emulatedPng, againPng] = [await shot(truth), await shot(emulated), await shot(again)];
    const files = { truth: path.join(out, "truth.png"), emulated: path.join(out, "emulated.png"), diff: path.join(out, "diff.png") };
    fs.writeFileSync(files.truth, truthPng);
    fs.writeFileSync(files.emulated, emulatedPng);
    const masked = [...truthSnap.ignored, ...emulatedSnap.ignored, ...againSnap.ignored];
    const pixels = diffPixels(png.decode(truthPng), png.decode(emulatedPng), png.decode(againPng), masked);
    fs.writeFileSync(files.diff, png.encode(pixels.diff));

    for (const c of [truth, again]) await bidi.send("browsingContext.close", { context: c }).catch(() => {});
    const compared = compareSnapshots(truthSnap, emulatedSnap, againSnap, emulation, opts.scrollY ?? 0);
    compared.noise.pixels = pixels.noise;
    compared.ignored.pixels = pixels.ignored;
    const report: Report = {
      url: base,
      emulation,
      size,
      ...compared,
      pixels: {
        differing: pixels.differing,
        total: pixels.total,
        ratio: Math.round((pixels.differing / pixels.total) * 1e5) / 1e5,
        in: locatePixels(truthSnap, pixels.mask),
      },
      files,
    };
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally {
    await bidi.send("session.end").catch(() => {});
    bidi.close();
    try {
      atelier("tab/close", { tab: agentTab });
    } catch {
      // Already gone.
    }
  }
}

/** No difference beyond noise and known equivalences. */
export function isClean(r: Report, maxPixelRatio = 0.001): boolean {
  return !r.styles.length && !r.rootCustom.length && !r.geometry.resized && !r.geometry.moved && !r.images.length &&
    !r.elements.onlyTruth.length && !r.elements.onlyEmulated.length && r.pixels.ratio < maxPixelRatio;
}

/** One line per finding, for people. */
export function summarize(r: Report): string {
  const lines = [`${r.url} (${describeEmulation(r.emulation)}${r.emulation.feature === "viewport" ? "" : `, ${r.size.width}×${r.size.height}`})`];
  const clean = isClean(r);
  lines.push(`  ${r.elements.compared} elements compared${r.elements.truncated ? " (truncated)" : ""}; ${clean ? "no differences" : "differences:"}`);
  for (const s of r.styles.slice(0, 15)) {
    const ex = s.examples[0];
    lines.push(`  style  ${s.property}: ${s.elements} element(s), e.g. ${ex.element}: ${ex.truth} (real) vs ${ex.emulated} (emulated)`);
  }
  for (const c of r.rootCustom.slice(0, 10)) lines.push(`  token  ${c.property}: ${c.truth} (real) vs ${c.emulated} (emulated)`);
  if (r.geometry.resized || r.geometry.moved) {
    lines.push(`  layout ${r.geometry.resized} element(s) resized, ${r.geometry.moved} only moved; e.g. ${r.geometry.examples[0].element}`);
  }
  for (const i of r.images) lines.push(`  image  ${i.element}: ${i.truth} (real) vs ${i.emulated} (emulated)`);
  if (r.elements.onlyTruth.length || r.elements.onlyEmulated.length) {
    lines.push(`  dom    only real: ${r.elements.onlyTruth.length}, only emulated: ${r.elements.onlyEmulated.length}`);
  }
  const byWhy = new Map<string, string[]>();
  for (const q of r.equivalent) byWhy.set(q.why, [...(byWhy.get(q.why) ?? []), `${q.property} (${q.elements})`]);
  for (const [why, props] of byWhy) lines.push(`  same   ${props.join(", ")} differ but render the same: ${why}`);
  const n = r.noise;
  if (n.styles || n.geometry || n.images || n.elements || n.pixels) {
    lines.push(`  noise  left out, as it varied between two real loads: ${n.styles} style values, ${n.geometry} boxes, ${n.images} images, ${n.elements} elements, ${n.pixels} pixels`);
  }
  if (r.ignored.elements) lines.push(`  ignore left out as asked: ${r.ignored.elements} element(s) with their subtrees, ${r.ignored.pixels} pixels`);
  if (r.elements.frames) lines.push(`  frames ${r.elements.frames} frame(s) not compared: atelier doesn't emulate inside frames; only the pixels show them`);
  lines.push(`  pixels ${(r.pixels.ratio * 100).toFixed(3)}% differ (${r.files.diff})`);
  for (const p of r.pixels.in) lines.push(`         ${p.pixels} in ${p.element} (${Math.round(p.ofBox * 100)}% of its box)`);
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let instance: string | undefined;
  let scheme: "light" | "dark" = "dark";
  let viewport: { width: number; height: number } | null = null;
  let width = 1280;
  let height = 800;
  let out: string | undefined;
  let emulate = true;
  const ignore: string[] = [];
  let scrollY = 0;
  const urls: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--instance") instance = args[++i];
    else if (a === "--scheme") scheme = args[++i] as "light" | "dark";
    else if (a === "--viewport") {
      const [w, h] = args[++i].split("x").map(Number);
      viewport = { width: w, height: h };
    }
    else if (a === "--size") [width, height] = args[++i].split("x").map(Number);
    else if (a === "--out") out = path.resolve(args[++i]);
    else if (a === "--no-emulation") emulate = false;
    else if (a === "--ignore") ignore.push(args[++i]);
    else if (a === "--scroll") scrollY = Number(args[++i]);
    else urls.push(a);
  }
  if (!urls.length) {
    console.error("usage: node dev/fidelity.ts [--instance NAME] [--scheme dark|light | --viewport WxH] [--size WxH] [--out DIR] [--no-emulation] [--ignore SELECTOR]... [--scroll Y] URL...");
    process.exit(2);
  }
  const own = !instance;
  if (own) {
    instance = "fidelity";
    const owned = path.join(RUNTIME, "fidelity-owned");
    fs.mkdirSync(owned, { recursive: true });
    if (!fs.existsSync(path.join(owned, "atelier.toml"))) fs.writeFileSync(path.join(owned, "atelier.toml"), 'theme = "none"\n');
    // The real setting is the other scheme, so emulation has something to change.
    dev("up", "--name", instance, "--atelier-dir", owned, "--grant-user-scripts", "--system-access", "--color-scheme", scheme === "dark" ? "light" : "dark");
  }
  try {
    const state = JSON.parse(fs.readFileSync(path.join(RUNTIME, instance!, "state.json"), "utf8"));
    const reports: Report[] = [];
    for (const u of urls) {
      // Fixture paths (/color-scheme/) are served by the instance's fixture server.
      const url = u.startsWith("/") ? `http://127.0.0.1:${state.fixturesPort}${u}` : u;
      const emulation: Emulation = viewport ? { feature: "viewport", ...viewport } : { feature: "prefers-color-scheme", value: scheme };
      const r = await compare(instance!, url, emulation, { width, height, out, emulate, ignore, scrollY });
      console.error(summarize(r));
      reports.push(r);
    }
    console.log(JSON.stringify(reports, null, 2));
  } finally {
    if (own) dev("down", instance!);
  }
}
