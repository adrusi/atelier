// Spike R4 (SPEC §16): does Firefox suspend an MV3 background page while a
// native-messaging port is open?
//
// Starts one dev instance per variant, in parallel, with the same timeline:
// install, sit idle for IDLE_S seconds, open a tab (which wakes a suspended
// background), wait a few seconds, then print each instance's host log as a
// timeline relative to install. Run from a `nix develop` shell after
// `cargo build`:  node spikes/r4/run.ts [IDLE_S [VARIANT...]]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IDLE_S = Number(process.argv[2] ?? 90);
const VARIANTS = process.argv.length > 3 ? process.argv.slice(3) : ["port", "oneshot"];
const here = import.meta.dirname;
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8" });

const names = VARIANTS.map((v) => `r4-${v}`);
const started: Record<string, number> = {};
try {
  await Promise.all(
    VARIANTS.map(async (v, i) => {
      started[names[i]] = Date.now();
      dev("up", "--name", names[i], "--no-fixtures", "--extension", path.join(here, v));
    }),
  );
  console.error(`instances up; idling ${IDLE_S}s`);
  await sleep(IDLE_S);
  const tabAt = Date.now();
  for (const name of names) dev("bidi", name, "browsingContext.create", JSON.stringify({ type: "tab" }));
  await sleep(5);

  for (const name of names) {
    const log = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", name, "home/.local/state/atelier/native-host.log");
    console.log(`\n== ${name} (tab opened at +${((tabAt - started[name]) / 1000).toFixed(1)}s)`);
    const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
    const t0 = started[name];
    for (const line of lines) {
      const e = JSON.parse(line);
      const what = e.event === "received" ? e.data.method : e.event;
      const bg = e.data?.params?.startedAt ? ` (background started +${((e.data.params.startedAt - t0) / 1000).toFixed(1)}s)` : "";
      console.log(`  +${((e.t - t0) / 1000).toFixed(1).padStart(6)}s  host ${e.pid}  ${what}${bg}`);
    }
  }
} finally {
  dev("down", ...names);
}
