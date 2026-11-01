// End-to-end test for phase 1 (SPEC §15): styles in an owned directory reach
// pages, through the daemon, native host, extension and page shim.
//
// Builds nothing itself: run `cargo build` and `(cd extension && npm run build)`
// first, then from a `nix develop` shell:  node dev/e2e/phase1.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Bidi, evaluate, withSession } from "../bidi.ts";

const NAME = "e2e-phase1";
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8" });

// Next to the instance rather than in TMPDIR, which `nix develop` deletes on
// exit: it's kept for inspection if the test fails.
const owned = `${instance}-owned`;
fs.rmSync(owned, { recursive: true, force: true });
fs.mkdirSync(owned, { recursive: true });
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

write(path.join(owned, "atelier.toml"), 'theme = "e2e"\n');
write(path.join(owned, "themes/e2e/THEME.md"), "# e2e\n");
const BASIC = path.join(owned, "services/fixtures/e2e/basic.user.css");
const basicStyle = (topbar: string) => `/* ==UserStyle==
@name Fixtures: basic
@var color accent "Accent" #ff0000
==/UserStyle== */
@-moz-document domain("127.0.0.1") {
  .topbar { background: ${topbar}; }
  main h1 { color: var(--accent); }
}
`;
write(BASIC, basicStyle("rgb(1, 2, 3)"));

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

async function eventually<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = await f();
  while (!ok(v) && Date.now() < deadline) {
    await sleep(200);
    v = await f();
  }
  return v;
}

dev("up", "--name", NAME, "--atelier-dir", owned, "--grant-user-scripts");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const basicUrl = `http://127.0.0.1:${state.fixturesPort}/basic/`;
const varsJson = path.join(instance, "home/.config/atelier/vars.json");

try {

  await withSession(state.bidiPort, async (bidi: Bidi) => {
    const tab = (await bidi.send("browsingContext.create", { type: "tab" })).context;
    await bidi.send("browsingContext.activate", { context: tab });
    const load = (url: string) => bidi.send("browsingContext.navigate", { context: tab, url, wait: "complete" });
    const js = (expr: string) => evaluate(bidi, tab, expr);
    const computed = (selector: string, prop: string) =>
      js(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).${prop}`);

    // Wait for the permission grant and first bundle to land.
    await eventually(
      async () => {
        await load(basicUrl);
        return js(`Boolean(document.querySelector("style[data-atelier]"))`);
      },
      (v) => v === true,
      20_000,
    );

    await check("a new style reaches a page that was open before any style matched it", async () => {
      // localhost: a different host from the basic style's domain("127.0.0.1"), so
      // this page starts with no shim at all.
      await load(`http://localhost:${state.fixturesPort}/plain/`);
      assert.equal(await js(`document.querySelectorAll("style[data-atelier]").length`), 0);
      write(path.join(owned, "services/fixtures/e2e/plain.user.css"), `@-moz-document domain("localhost") { body { color: rgb(9, 9, 9); } }\n`);
      const v = await eventually(() => computed("body", "color"), (v) => v === "rgb(9, 9, 9)");
      assert.equal(v, "rgb(9, 9, 9)");
      await load(basicUrl);
    });
    await check("style applies on load, winning ties with the page's own rules", async () => {
      assert.equal(await computed(".topbar", "backgroundColor"), "rgb(1, 2, 3)");
    });
    await check("style elements are the last children of <html>", async () => {
      assert.equal(await js(`document.documentElement.lastElementChild.getAttribute("data-atelier")`), "services/fixtures/e2e/basic.user.css");
    });
    await check("@var defaults apply", async () => {
      assert.equal(await computed("main h1", "color"), "rgb(255, 0, 0)");
    });
    await check("Dark Reader lock is added", async () => {
      assert.equal(await js(`Boolean(document.querySelector('meta[name="darkreader-lock"]'))`), true);
    });

    await check("editing a style updates the open page live", async () => {
      write(BASIC, basicStyle("rgb(7, 8, 9)"));
      const v = await eventually(() => computed(".topbar", "backgroundColor"), (v) => v === "rgb(7, 8, 9)");
      assert.equal(v, "rgb(7, 8, 9)");
    });
    await check("editing vars.json updates the open page live", async () => {
      write(varsJson, JSON.stringify({ accent: "#00ff00" }));
      const v = await eventually(() => computed("main h1", "color"), (v) => v === "rgb(0, 255, 0)");
      assert.equal(v, "rgb(0, 255, 0)");
    });
    await check("a regexp-scoped style applies after history-API navigation to its path, not before", async () => {
      write(
        path.join(owned, "services/fixtures/e2e/route.user.css"),
        `@-moz-document regexp("https?://127\\\\.0\\\\.0\\\\.1:\\\\d+/basic/other") {\n  main { outline: 3px solid rgb(4, 5, 6); }\n}\n`,
      );
      await sleep(1500);
      assert.equal(await computed("main", "outlineStyle"), "none");
      await js(`history.pushState({}, "", "/basic/other")`);
      const v = await eventually(() => computed("main", "outlineColor"), (v) => v === "rgb(4, 5, 6)");
      assert.equal(v, "rgb(4, 5, 6)");
    });
    await check("a fresh load gets the edited style and vars", async () => {
      await load(basicUrl);
      assert.equal(await computed(".topbar", "backgroundColor"), "rgb(7, 8, 9)");
      assert.equal(await computed("main h1", "color"), "rgb(0, 255, 0)");
    });
    await check("a style for a framed page applies inside its frames, from this origin and another, and live", async () => {
      const FRAMES = path.join(owned, "services/fixtures/e2e/frames.user.css");
      const port = state.fixturesPort;
      const framed = (color: string) => `@-moz-document url("http://127.0.0.1:${port}/frames/frame.html"), url("http://localhost:${port}/frames/frame.html") {
  #inner { color: ${color}; }
}
`;
      write(FRAMES, framed("rgb(9, 9, 9)"));
      await sleep(1500);
      await load(`http://127.0.0.1:${port}/frames/`);
      const frames = async () => {
        const { contexts } = await bidi.send("browsingContext.getTree", { root: tab });
        return contexts[0].children.map((c: { context: string }) => c.context) as string[];
      };
      const inner = async () =>
        Promise.all((await frames()).map((c) => evaluate(bidi, c, "getComputedStyle(document.getElementById('inner')).color")));
      // Three frames: from this origin, from another, and full width.
      assert.deepEqual(await eventually(inner, (v) => v.every((c) => c === "rgb(9, 9, 9)")), ["rgb(9, 9, 9)", "rgb(9, 9, 9)", "rgb(9, 9, 9)"]);
      assert.notEqual(await computed("#outer", "color"), "rgb(9, 9, 9)", "the page around them isn't matched");
      write(FRAMES, framed("rgb(8, 8, 8)"));
      assert.deepEqual(await eventually(inner, (v) => v.every((c) => c === "rgb(8, 8, 8)")), ["rgb(8, 8, 8)", "rgb(8, 8, 8)", "rgb(8, 8, 8)"]);
      fs.rmSync(FRAMES);
    });
    await check("removing a style removes it from open pages", async () => {
      fs.rmSync(BASIC);
      const v = await eventually(() => js(`document.querySelectorAll("style[data-atelier]").length`), (v) => v === 0);
      assert.equal(v, 0);
    });
  });
} finally {
  if (failures) console.log(`\nlogs: ${path.join(instance, "log")}, ${path.join(instance, "home/.local/state/atelier")}`);
  dev("down", "--keep", NAME);
  if (!failures) fs.rmSync(path.join(instance), { recursive: true, force: true });
  if (failures) console.log(`owned directory kept: ${owned}`);
  else fs.rmSync(owned, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
