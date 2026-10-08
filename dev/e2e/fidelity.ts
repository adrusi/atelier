// End-to-end test for emulation fidelity (ARCHITECTURE.md, "Dev tooling that
// keeps it honest"): the fidelity harness (dev/fidelity.ts) compares each
// fixture under a real colour-scheme preference and under atelier's
// emulation, in both directions, and they must match. Two controls keep the
// harness honest: without emulation it must see differences, and the known
// gaps (frames, SVG images with their own scheme rules) must still show, so
// fixing one is noticed and this test updated.
//
// Build first (`cargo build`, `(cd extension && npm run build)`), then from a
// `nix develop` shell:  node dev/e2e/fidelity.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { compare, isClean, summarize } from "../fidelity.ts";

const RUNTIME = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev");
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const FIXTURES = ["/color-scheme/", "/scheme-hard/", "/tokens/", "/cards/", "/basic/"];

let failures = 0;
async function check(name: string, f: () => Promise<void>) {
  try {
    await f();
    console.log(`ok    ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message.split("\n").join("\n      ")}`);
  }
}

/** Runs f against an instance whose real preference is `real`. */
async function withInstance(real: "light" | "dark", f: (name: string, fixture: (p: string) => string) => Promise<void>) {
  const name = `e2e-fidelity-${real}`;
  const owned = path.join(RUNTIME, `${name}-owned`);
  fs.rmSync(owned, { recursive: true, force: true });
  fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(path.join(owned, "atelier.toml"), 'theme = "none"\n');
  dev("up", "--name", name, "--atelier-dir", owned, "--grant-user-scripts", "--system-access", "--color-scheme", real);
  const state = JSON.parse(fs.readFileSync(path.join(RUNTIME, name, "state.json"), "utf8"));
  const before = failures;
  try {
    await f(name, (p) => `http://127.0.0.1:${state.fixturesPort}${p}`);
  } finally {
    dev("down", ...(failures > before ? ["--keep"] : []), name);
    if (failures === before) fs.rmSync(owned, { recursive: true, force: true });
  }
}

const dark = { feature: "prefers-color-scheme", value: "dark" } as const;
const light = { feature: "prefers-color-scheme", value: "light" } as const;

await withInstance("light", async (name, fixture) => {
  await check("emulating dark matches a real dark preference, on every fixture", async () => {
    for (const f of FIXTURES) {
      const r = await compare(name, fixture(f), dark);
      assert.ok(isClean(r), summarize(r));
    }
  });

  await check("without emulation, the harness sees the difference (a control)", async () => {
    const r = await compare(name, fixture("/scheme-hard/"), dark, { emulate: false });
    assert.ok(!isClean(r), summarize(r));
    assert.ok(r.styles.some((s) => s.property === "color" && s.elements > 10), summarize(r));
    assert.ok(r.pixels.ratio > 0.5, summarize(r));
  });

  await check("the known gaps still show: frames, and SVG images with their own scheme rules", async () => {
    const r = await compare(name, fixture("/scheme-frames/"), dark);
    assert.equal(r.elements.frames, 1, summarize(r));
    assert.deepEqual(r.styles, [], "the page around them matches");
    const where = r.pixels.in.map((p) => p.element).join(" ");
    assert.match(where, /iframe/, summarize(r));
    assert.match(where, /img/, summarize(r));
  });
});

await withInstance("dark", async (name, fixture) => {
  await check("emulating light matches a real light preference, on every fixture", async () => {
    for (const f of FIXTURES) {
      const r = await compare(name, fixture(f), light);
      assert.ok(isClean(r), summarize(r));
    }
  });
});

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
