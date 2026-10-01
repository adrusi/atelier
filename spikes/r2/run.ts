// Spike R2 (SPEC §16): making one tab light or dark without changing the rest
// of the browser.
//
// Two tabs load dev/fixtures/color-scheme: the "user" tab and the "agent" tab.
// The harness records what every light/dark mechanism on the page concluded
// in each tab: at baseline, with per-tab emulation enabled in the agent tab
// only (ext/, via a sessionStorage marker), and under the global
// browserSettings override. Run from a `nix develop` shell after
// `cargo build`:  node spikes/r2/run.ts

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Bidi, evaluate, withSession } from "../../dev/bidi.ts";

const NAME = "r2";
const here = import.meta.dirname;
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8" });

function spikeEvents(): { event: string; [k: string]: unknown }[] {
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

async function waitForEvent(names: string[], after = 0, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const e = spikeEvents().slice(after).find((e) => names.includes(e.event));
    if (e) return e;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${names.join(" or ")}`);
}

dev("up", "--name", NAME, "--extension", path.join(here, "ext"), "--pref", "extensions.webextOptionalPermissionPrompts=false");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const url = `http://127.0.0.1:${state.fixturesPort}/color-scheme/`;
const rows: [string, string, any][] = [];

try {
  const installed = await waitForEvent(["installed"]);
  if (!installed.userScripts) {
    await withSession(state.bidiPort, async (bidi) => {
      for (let i = 0; i < 50; i++) {
        const tree = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
        if (tree.contexts.some((c: any) => c.url.endsWith("/grant.html"))) return;
        await sleep(200);
      }
      throw new Error("grant page never opened");
    });
    await sleep(1000);
    // wtype's first keystroke races the virtual keyboard's setup; start with a delay.
    dev("exec", NAME, "--", "wtype", "-s", "300", "-k", "Return");
  }
  console.log("user scripts:", JSON.stringify(await waitForEvent(["userscripts-registered", "userscripts-failed"])));

  await withSession(state.bidiPort, async (bidi) => {
    const load = async (context: string, u = url) => {
      await bidi.send("browsingContext.navigate", { context, url: u, wait: "complete" });
      await sleep(500);
    };
    const probe = (context: string) => evaluate(bidi, context, `({ ...__scheme(), rewrite: document.documentElement.getAttribute("data-atelier-rewrite") })`);
    const record = async (scenario: string, user: string, agent: string) => {
      rows.push([scenario, "user", await probe(user)]);
      rows.push([scenario, "agent", await probe(agent)]);
    };

    const user = (await bidi.send("browsingContext.create", { type: "tab" })).context;
    const agent = (await bidi.send("browsingContext.create", { type: "tab" })).context;
    await load(user);
    await load(agent);
    await record("baseline", user, agent);

    // Per-tab emulation in the agent tab only: set the marker, then reload.
    await evaluate(bidi, agent, `sessionStorage.setItem("atelier-scheme", "dark")`);
    await load(agent);
    await record("per-tab dark (agent only)", user, agent);

    // Global override, with the marker cleared again.
    await evaluate(bidi, agent, `sessionStorage.removeItem("atelier-scheme")`);
    await load(agent);
    const before = spikeEvents().length;
    await evaluate(bidi, user, `location.hash = "global-dark"`);
    console.log("global:", JSON.stringify(await waitForEvent(["global", "global-failed"], before)));
    await sleep(1000);
    await record("global dark, no reload", user, agent);
    await load(user);
    await load(agent);
    await record("global dark, reloaded", user, agent);
    await evaluate(bidi, user, `location.hash = "global-reset"`);
  });

  const keys = ["mediaSame", "mediaCross", "linkMedia", "lightDark", "jsAtStartup", "jsNow", "picture"];
  const header = ["scenario", "tab", ...keys, "marker"];
  const table = rows.map(([s, t, r]) => [s, t, ...keys.map((k) => r[k]), String(r.marker)]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log("\n" + [header, widths.map((w) => "-".repeat(w)), ...table].map(fmt).join("\n"));
  for (const [s, t, r] of rows) if (r.rewrite) console.log(`\n${s} / ${t}: stylesheet rewrites ${r.rewrite}`);
  fs.writeFileSync(path.join(here, "last-run.json"), JSON.stringify(rows, null, 2) + "\n");
} finally {
  dev("down", NAME);
}
