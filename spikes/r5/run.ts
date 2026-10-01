// Spike R5 (SPEC §6.5, §16): does <meta name="darkreader-lock"> keep Dark
// Reader off pages atelier styles, when added the way atelier would add it?
//
// Installs Dark Reader (downloaded from AMO into vendor/ on first run) and the
// spike extension (ext/), then loads dev/fixtures/dark-reader in several
// situations. Run from a `nix develop` shell after `cargo build`:
//   node spikes/r5/run.ts [LOADS]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Bidi, evaluate, withSession } from "../../dev/bidi.ts";

const NAME = "r5";
const LOADS = Number(process.argv[2] ?? 5);
const here = import.meta.dirname;
const xpi = path.join(here, "vendor/darkreader.xpi");
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8" });

if (!fs.existsSync(xpi)) {
  fs.mkdirSync(path.dirname(xpi), { recursive: true });
  const r = await fetch("https://addons.mozilla.org/firefox/downloads/latest/darkreader/latest.xpi");
  fs.writeFileSync(xpi, Buffer.from(await r.arrayBuffer()));
}

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

async function waitForEvent(names: string[], timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const e = spikeEvents().find((e) => names.includes(e.event));
    if (e) return e;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${names.join(" or ")}`);
}

// Dark Reader first, so the spike's grant page opens last and is the active tab.
dev("up", "--name", NAME, "--extension", xpi, "--extension", path.join(here, "ext"), "--pref", "extensions.webextOptionalPermissionPrompts=false");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const url = `http://127.0.0.1:${state.fixturesPort}/dark-reader/`;
const results: [string, any][] = [];

try {
  const installed = await waitForEvent(["installed"]);
  if (!installed.userScripts) {
    await sleep(2000);
    // wtype's first keystroke races the virtual keyboard's setup; start with a delay.
    dev("exec", NAME, "--", "wtype", "-s", "300", "-k", "Return");
  }
  console.log("user scripts:", JSON.stringify(await waitForEvent(["userscripts-registered", "userscripts-failed"])));

  await withSession(state.bidiPort, async (bidi: Bidi) => {
    const tab = (await bidi.send("browsingContext.create", { type: "tab" })).context;
    await bidi.send("browsingContext.activate", { context: tab });
    const load = async (u: string) => {
      await bidi.send("browsingContext.navigate", { context: tab, url: u, wait: "complete" });
      await sleep(1500);
    };
    const probe = () => evaluate(bidi, tab, `({ firstFrame: __dr.firstFrame, now: __dr.now() })`);

    for (let i = 1; i <= LOADS; i++) {
      await load(url);
      results.push([`no lock (load ${i})`, await probe()]);
    }
    for (let i = 1; i <= LOADS; i++) {
      await load(`${url}?lock=start`);
      results.push([`lock on <html> at document_start (load ${i})`, await probe()]);
    }

    await load(url);
    await evaluate(bidi, tab, `document.documentElement.append(Object.assign(document.createElement("meta"), { name: "darkreader-lock" }))`);
    await sleep(1500);
    results.push(["lock added later, on <html>", await probe()]);

    await load(url);
    await evaluate(bidi, tab, `document.head.append(Object.assign(document.createElement("meta"), { name: "darkreader-lock" }))`);
    await sleep(1500);
    results.push(["lock added later, in <head>", await probe()]);

    await evaluate(bidi, tab, `document.querySelector('meta[name="darkreader-lock"]').remove()`);
    await sleep(1500);
    results.push(["...then lock removed", await probe()]);
  });

  const show = (s: any) => (s ? `mode=${s.mode ?? "-"} styles=${s.styles} fallback=${s.fallback ? "yes" : "no"} bg=${s.background}` : "(none)");
  for (const [label, r] of results) {
    console.log(`\n${label}\n  first frame: ${show(r.firstFrame)}\n  after 1.5s:  ${show(r.now)}`);
  }
  fs.writeFileSync(path.join(here, "last-run.json"), JSON.stringify(results, null, 2) + "\n");
} finally {
  dev("down", NAME);
}
