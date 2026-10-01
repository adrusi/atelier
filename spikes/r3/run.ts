// Spike R3 (SPEC §16): screenshots of tabs that aren't visible.
//
// Loads dev/fixtures/capture in tabs in different visibility situations and
// asks the spike extension (ext/) to capture each one. Run from a
// `nix develop` shell after `cargo build`:  node spikes/r3/run.ts [BACKGROUNDED_S]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Bidi, evaluate, withSession } from "../../dev/bidi.ts";

const NAME = "r3";
const BACKGROUNDED_S = Number(process.argv[2] ?? 40);
const EXPECTED: Record<string, string> = {
  background: "10,20,30",
  static: "200,0,0",
  timer: "0,200,0",
  raf: "0,0,200",
  injected: "200,200,0",
  lazy: "200,0,200",
  late: "0,200,200",
  raf30: "200,100,0",
  anim: "0,100,200",
};

const here = import.meta.dirname;
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8" });
const sway = (...args: string[]) => {
  const sock = fs.readdirSync(path.join(instance, "run")).find((f) => f.startsWith("sway-ipc."))!;
  return execFileSync("swaymsg", ["-s", path.join(instance, "run", sock), ...args], { encoding: "utf8" });
};

function captured(label: string): any {
  const log = path.join(instance, "home/.local/state/atelier/native-host.log");
  if (!fs.existsSync(log)) return undefined;
  for (const line of fs.readFileSync(log, "utf8").trim().split("\n")) {
    const e = JSON.parse(line);
    if (e.data?.method === "spike/captured" && e.data.params.label === label) return e.data.params;
  }
}

async function capture(bidi: Bidi, context: string, label: string) {
  const page = await evaluate(bidi, context, `({ ...window.__capture, visibility: document.visibilityState })`);
  await evaluate(bidi, context, `location.hash = "capture-${label}"`);
  for (let i = 0; i < 100; i++) {
    const r = captured(label);
    if (r) return { page, ...r };
    await sleep(100);
  }
  throw new Error(`no capture result for ${label}`);
}

dev("up", "--name", NAME, "--extension", path.join(here, "ext"));
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const url = `http://127.0.0.1:${state.fixturesPort}/capture/`;
const results: any[] = [];

try {
  await withSession(state.bidiPort, async (bidi) => {
    const open = async (opts: object, start = 0) => {
      const { context } = await bidi.send("browsingContext.create", opts);
      await bidi.send("browsingContext.navigate", { context, url: `${url}?start=${start}`, wait: "complete" });
      return context;
    };

    // A: the active tab of the focused window.
    const a = await open({ type: "tab" });
    await bidi.send("browsingContext.activate", { context: a });
    await sleep(1500);
    results.push(await capture(bidi, a, "A-active"));

    // B: a tab opened in the background and never shown.
    const b = await open({ type: "tab", background: true });
    await sleep(1500);
    results.push(await capture(bidi, b, "B-never-shown"));

    // B with animations fast-forwarded before capture.
    const bs = await open({ type: "tab", background: true });
    await sleep(1500);
    results.push(await capture(bidi, bs, "B-never-shown-settle"));

    // B': shown, then backgrounded for a while (timer throttling grows over
    // time). The animated boxes start 3 s after load, i.e. once it's hidden.
    const b2 = await open({ type: "tab" }, 3000);
    await bidi.send("browsingContext.activate", { context: b2 });
    await sleep(500);
    await bidi.send("browsingContext.activate", { context: a });
    await sleep(BACKGROUNDED_S * 1000);
    results.push(await capture(bidi, b2, `B-backgrounded-${BACKGROUNDED_S}s`));

    // C: the active tab of a window on another (invisible) sway workspace.
    // The animated boxes start 3 s after load, once it's been moved.
    const c = await open({ type: "window" }, 3000);
    sway("move", "container", "to", "workspace", "number", "2");
    sway("workspace", "number", "1");
    await sleep(6000);
    results.push(await capture(bidi, c, "C-other-workspace"));
  });

  for (const r of results) {
    console.log(`\n== ${r.label}  (tab active=${r.tab.active}, page visibility=${r.page.visibility}; page saw: timer=${r.page.timer} rafFrames=${r.page.raf} raf30=${r.page.raf30} anim=${r.page.anim} lazyLoaded=${r.page.lazy} late=${r.page.late})`);
    for (const method of ["captureTab", "captureVisibleTab"]) {
      const c = r[method];
      if (!c) continue;
      if (!c.ok) {
        console.log(`  ${method}: FAILED ${c.error}`);
        continue;
      }
      const boxes = Object.entries(EXPECTED).map(([k, v]) => `${k}=${c.colours[k] === v ? "ok" : c.colours[k]}`);
      console.log(`  ${method} (${c.width}x${c.height}, ${c.ms}ms): ${boxes.join(" ")}`);
    }
  }
  fs.writeFileSync(path.join(here, "last-run.json"), JSON.stringify(results, null, 2) + "\n");
} finally {
  dev("down", NAME);
}
