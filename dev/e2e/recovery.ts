// End-to-end test for the browser side of recovery (ARCHITECTURE.md, "State
// and recovery"): agent tabs and throwaway containers are reconciled against
// what the background records, so leftovers from an earlier session are
// cleaned up, and a copy of an agent tab becomes the user's.
//
// A browser restart can't be done here (the dev instance's extension is a
// temporary one, gone after a restart), but reloading the extension is the
// same thing as far as atelier can tell: session storage, and with it the
// session's epoch and the records, starts empty, while the tabs, their tab
// values and the containers stay. Extension pages are scripted over BiDi,
// which --system-access allows.
//
// Build first (`cargo build`, `(cd extension && npm run build)`), then from a
// `nix develop` shell:  node dev/e2e/recovery.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Bidi, evaluate, withSession } from "../bidi.ts";

const NAME = "e2e-recovery";
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const owned = `${instance}-owned`;
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const atelier = (...args: string[]) => dev("atelier", NAME, ...args);
const browser = (method: string, params: object = {}) => JSON.parse(atelier("browser", method, JSON.stringify(params)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(owned, { recursive: true, force: true });
fs.mkdirSync(owned, { recursive: true });
fs.writeFileSync(path.join(owned, "atelier.toml"), 'theme = "e2e"\n');

dev("up", "--name", NAME, "--atelier-dir", owned, "--grant-user-scripts", "--system-access", "--color-scheme", "light");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const fixture = `http://127.0.0.1:${state.fixturesPort}/plain/`;

async function until<T>(what: string, f: () => Promise<T | undefined> | T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await f();
      if (v !== undefined && v !== false) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ""}`);
    await sleep(250);
  }
}

/** The extension's base URL, from the onboarding page it opened on install
 * (which closes when the extension reloads, hence kept). */
let base: string | undefined;

/** Runs f with an extension page open, and evaluates there with ext(). */
async function inExtension<T>(f: (ext: (expr: string) => Promise<any>, bidi: Bidi) => Promise<T>): Promise<T> {
  return withSession(state.bidiPort, async (bidi) => {
    if (!base) {
      const { contexts } = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
      const page = contexts.find((c: { url: string }) => c.url.startsWith("moz-extension://"));
      assert.ok(page, "an extension page is open");
      base = page.url.replace(/\/[^/]*$/, "");
    }
    const { context } = await bidi.send("browsingContext.create", { type: "tab", background: true });
    await bidi.send("browsingContext.navigate", { context, url: `${base}/inbox.html`, wait: "complete" });
    try {
      return await f((expr) => evaluate(bidi, context, expr), bidi);
    } finally {
      await bidi.send("browsingContext.close", { context }).catch(() => {});
    }
  });
}

/** Top-level contexts showing `url`, and whether each sees a dark scheme. */
async function showing(url: string): Promise<boolean[]> {
  return withSession(state.bidiPort, async (bidi) => {
    const { contexts } = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
    const out: boolean[] = [];
    for (const c of contexts.filter((c: { url: string }) => c.url === url)) {
      out.push((await evaluate(bidi, c.context, "matchMedia('(prefers-color-scheme: dark)').matches")) as boolean);
    }
    return out;
  });
}

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

try {
  const plain = browser("tab/open", { url: `${fixture}?plain` }).tab as number;
  const away = browser("tab/open", { url: `${fixture}?away`, throwaway: true }).tab as number;
  const dark = browser("tab/open", { url: `${fixture}?dark` }).tab as number;
  browser("tab/color_scheme", { tab: dark, scheme: "dark" });
  let copy = -1;

  await check("agent tabs carry the browser session's epoch in a tab value", async () => {
    await inExtension(async (ext) => {
      const epoch = await ext("browser.storage.session.get('epoch').then((v) => v.epoch)");
      assert.ok(epoch);
      for (const tab of [plain, away, dark]) {
        assert.deepEqual(await ext(`browser.sessions.getTabValue(${tab}, 'atelier')`), { epoch }, `tab ${tab}`);
      }
    });
  });

  await check("a copy of an agent tab is the user's: not emulating, no tab value, not listed", async () => {
    copy = await inExtension((ext) => ext(`browser.tabs.duplicate(${dark}).then((t) => t.id)`));
    // The copy loads with the page's marker, asks, drops it and reloads.
    const schemes = await until("the copy to drop the emulation", async () => {
      const s = await showing(`${fixture}?dark`);
      return s.length === 2 && s.filter(Boolean).length === 1 ? s : undefined;
    });
    assert.equal(schemes.filter(Boolean).length, 1, "the agent tab still emulates dark");
    await sleep(3500); // reconcile runs a few seconds after a tab appears
    await inExtension(async (ext) => {
      assert.equal(await ext(`browser.sessions.getTabValue(${copy}, 'atelier')`), undefined);
    });
    const listed = browser("tab/list").tabs.map((t: { tab: number }) => t.tab);
    assert.deepEqual(listed.sort(), [plain, away, dark].sort());
  });

  await check("after a restart, agent tabs and throwaway containers from before are removed; the user's copy stays", async () => {
    await inExtension(async (ext) => {
      // The page goes away with the extension, so this may not answer.
      await Promise.race([ext("browser.runtime.reload(), 0").catch(() => {}), sleep(1000)]);
    });
    await until("the old agent tabs to close", async () => {
      const left = [...(await showing(`${fixture}?plain`)), ...(await showing(`${fixture}?away`))];
      return left.length === 0;
    });
    assert.deepEqual(await showing(`${fixture}?dark`), [false], "only the copy is left, and it's light");
    await until("the extension to come back", () => inExtension((ext) => ext("browser.runtime.id")));
    await inExtension(async (ext) => {
      assert.deepEqual(await ext("browser.contextualIdentities.query({ name: 'atelier (throwaway)' }).then((c) => c.length)"), 0);
    });
    const tabs = await until("the daemon to reconnect", () => browser("tab/list").tabs);
    assert.deepEqual(tabs, []);
  });
} finally {
  if (failures) console.log(`\nlogs: ${path.join(instance, "log")}`);
  dev("down", ...(failures ? ["--keep"] : []), NAME);
  if (!failures) fs.rmSync(owned, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
