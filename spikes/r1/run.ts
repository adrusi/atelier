// Spike R1 (SPEC §16): how should styles get into pages?
//
// Starts a dev instance with the spike extension (ext/), grants it the
// userScripts permission by pressing Enter on its grant page through the
// compositor (BiDi can't drive privileged extension pages), then
// loads each probe fixture and reads what dev/fixtures/_shared/probe.js saw.
// Run from a `nix develop` shell after `cargo build`:  node spikes/r1/run.ts

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Bidi, evaluate, withSession } from "../../dev/bidi.ts";

const NAME = "r1";
const STRATEGIES = ["s1", "s2", "s3", "s3u", "s4", "s5"];
const FIXTURES = ["plain", "strict-csp", "slow-stream", "hostile-head"];

const here = import.meta.dirname;
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8" });

type SpikeEvent = { event: string; [k: string]: unknown };

function spikeEvents(): SpikeEvent[] {
  const log = path.join(instance, "home/.local/state/atelier/native-host.log");
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === "received" && e.data.method?.startsWith("spike/"))
    .map((e) => ({ event: e.data.method.slice("spike/".length), ...e.data.params }));
}

async function waitForEvent(names: string[], timeoutMs = 20_000): Promise<SpikeEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const e = spikeEvents().find((e) => names.includes(e.event));
    if (e) return e;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${names.join(" or ")}`);
}

async function contexts(bidi: Bidi): Promise<{ context: string; url: string }[]> {
  return (await bidi.send("browsingContext.getTree", { maxDepth: 0 })).contexts;
}


const PROBE = `({ firstFrame: __probe.firstFrame, firstFrameMs: __probe.firstFrameMs, now: __probe.now(), violations: __probe.violations })`;

dev("up", "--name", NAME, "--extension", path.join(here, "ext"), "--pref", "extensions.webextOptionalPermissionPrompts=false");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const fixtures = `http://127.0.0.1:${state.fixturesPort}`;
const results: Record<string, any> = {};

try {
  const installed = await waitForEvent(["installed"]);
  console.log("installed:", JSON.stringify(installed));

  if (!installed.userScripts) {
    await withSession(state.bidiPort, async (bidi) => {
      let grant: string | undefined;
      for (let i = 0; i < 50 && !grant; i++) {
        grant = (await contexts(bidi)).find((c) => c.url.endsWith("/grant.html"))?.context;
        if (!grant) await sleep(200);
      }
      if (!grant) throw new Error("grant page never opened");
    });
    await sleep(1000); // let the autofocused button take focus
    // The initial sleep matters: wtype's first keystroke races the virtual keyboard's setup and gets dropped.
    dev("exec", NAME, "--", "wtype", "-s", "300", "-k", "Return");
  }
  console.log("user scripts:", JSON.stringify(await waitForEvent(["userscripts-registered", "userscripts-failed", "userscripts-unavailable"])));
  for (const e of spikeEvents().filter((e) => /^s[45]-/.test(e.event))) console.log(`${e.event}:`, JSON.stringify(e));

  await withSession(state.bidiPort, async (bidi) => {
    const tab = (await bidi.send("browsingContext.create", { type: "tab" })).context;
    for (const fixture of FIXTURES) {
      await bidi.send("browsingContext.navigate", { context: tab, url: `${fixtures}/${fixture}/`, wait: "complete" });
      if (fixture === "hostile-head") {
        for (let i = 0; i < 50; i++) {
          if (await evaluate(bidi, tab, `document.documentElement.hasAttribute("data-hostile-done")`)) break;
          await sleep(100);
        }
      }
      await sleep(500);
      results[fixture] = await evaluate(bidi, tab, PROBE);
    }

    // Per-tab removal: two tabs on the same page; remove in one only.
    const other = (await bidi.send("browsingContext.create", { type: "tab" })).context;
    for (const c of [tab, other]) {
      await bidi.send("browsingContext.navigate", { context: c, url: `${fixtures}/plain/`, wait: "complete" });
    }
    await evaluate(bidi, tab, `location.hash = "remove"`);
    await waitForEvent(["removed"]);
    await sleep(500);
    results.removedTab = await evaluate(bidi, tab, PROBE);
    results.otherTab = await evaluate(bidi, other, PROBE);
  });
  const removed = spikeEvents().find((e) => e.event === "removed");
  console.log("removal calls:", JSON.stringify(removed?.results));
  for (const e of spikeEvents().filter((e) => e.event === "insertcss-failed")) console.log("insertCSS failure:", JSON.stringify(e));

  // Report
  const yn = (b: boolean | undefined) => (b === undefined ? "?" : b ? "yes" : "NO");
  const p = (r: any, s: string) => r?.probes?.[s];
  const header = ["strategy", "applied", "1st frame", "1st frame (slow)", "wins tie", "strict CSP", "survives hostile", "removable per tab"];
  const rows = STRATEGIES.map((s) => [
    s,
    yn(p(results.plain.now, s)?.applied),
    yn(p(results.plain.firstFrame, s)?.applied),
    yn(p(results["slow-stream"].firstFrame, s)?.applied),
    p(results.plain.now, s)?.cascade === "ext" ? "yes" : p(results.plain.now, s)?.applied ? "NO" : "-",
    yn(p(results["strict-csp"].now, s)?.applied),
    yn(p(results["hostile-head"].now, s)?.applied),
    !p(results.otherTab.now, s)?.applied ? "-" : yn(!p(results.removedTab.now, s)?.applied),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log("\n" + fmt(header) + "\n" + fmt(widths.map((w) => "-".repeat(w))) + "\n" + rows.map(fmt).join("\n"));

  for (const f of [...FIXTURES, "removedTab", "otherTab"]) {
    const r = results[f];
    if (r.violations?.length) console.log(`\n${f}: CSP violations`, JSON.stringify(r.violations));
    const attrs = { ...r.firstFrame?.attrs, ...r.now?.attrs };
    if (Object.keys(attrs).length) console.log(`${f}: attributes on <html>`, JSON.stringify(attrs));
  }
  console.log(`\nfirst-frame times (ms): ${FIXTURES.map((f) => `${f}=${Math.round(results[f].firstFrameMs)}`).join(" ")}`);
  fs.writeFileSync(path.join(here, "last-run.json"), JSON.stringify({ results, events: spikeEvents() }, null, 2) + "\n");
} finally {
  dev("down", NAME);
}
