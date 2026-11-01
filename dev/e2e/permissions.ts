// End-to-end test for permissions: an installed MV3 extension may not have
// site access (one installed by policy, or into a profile by home-manager,
// never sees a prompt), and then atelier's styles aren't injected and
// tabs.captureTab doesn't exist. atelier must notice, ask for it with user
// scripts in one request, and start again to use it.
//
// The dev instance's extension is a temporary one, which gets site access
// unasked; the test takes it away and restarts the extension, which is the
// owner's situation after installing through home-manager.
//
// Build first (`cargo build`, `(cd extension && npm run build)`), then from a
// `nix develop` shell:  node dev/e2e/permissions.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Bidi, evaluate, withSession } from "../bidi.ts";

const NAME = "e2e-permissions";
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const owned = `${instance}-owned`;
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(owned, { recursive: true, force: true });
fs.mkdirSync(owned, { recursive: true });
fs.writeFileSync(path.join(owned, "atelier.toml"), 'theme = "e2e"\n');

dev("up", "--name", NAME, "--atelier-dir", owned, "--grant-user-scripts", "--system-access");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const fixture = `http://127.0.0.1:${state.fixturesPort}/plain/`;

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

async function until<T>(what: string, f: () => Promise<T | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await f();
      if (v !== undefined && v !== false) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ""}`);
    await sleep(300);
  }
}

let base = "";
/** Runs f in a fresh extension page (a page started now has the APIs the
 * extension's permissions allow now). */
async function inExtension<T>(f: (ext: (expr: string, activate?: boolean) => Promise<any>, bidi: Bidi) => Promise<T>, front = false): Promise<T> {
  return withSession(state.bidiPort, async (bidi) => {
    if (!base) {
      const { contexts } = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
      base = contexts.find((c: { url: string }) => c.url.startsWith("moz-extension://")).url.replace(/\/[^/]*$/, "");
    }
    const { context } = await bidi.send("browsingContext.create", { type: "tab", background: !front });
    await bidi.send("browsingContext.navigate", { context, url: `${base}/inbox.html`, wait: "complete" });
    try {
      return await f(async (expression, activate = false) => {
        if (!activate) return evaluate(bidi, context, expression);
        // As if the person clicked: permissions.request needs a user gesture.
        const r = await bidi.send("script.evaluate", { expression, target: { context }, awaitPromise: true, userActivation: true });
        if (r.type === "exception") throw new Error(r.exceptionDetails.text);
        return r.result.value;
      }, bidi);
    } finally {
      await bidi.send("browsingContext.close", { context }).catch(() => {});
    }
  });
}

const pages = async () => withSession(state.bidiPort, async (bidi) => (await bidi.send("browsingContext.getTree", { maxDepth: 0 })).contexts.map((c: { url: string }) => c.url) as string[]);

try {
  await withSession(state.bidiPort, async (bidi) => {
    const { context } = await bidi.send("browsingContext.create", { type: "tab" });
    await bidi.send("browsingContext.navigate", { context, url: fixture, wait: "complete" });
  });

  await check("without site access (an install without a prompt), atelier asks for it", async () => {
    await inExtension(async (ext) => {
      await ext(`browser.permissions.remove({ origins: ["<all_urls>"] })`);
      await Promise.race([ext("browser.runtime.reload(), 0").catch(() => {}), sleep(1000)]);
    });
    const state = await until("the extension to come back", () =>
      inExtension((ext) => ext(`browser.runtime.sendMessage({ type: "state" }).then((s) => s.connection === "connected" && s)`)),
    );
    assert.equal(state.needsPermission, true, "the popup asks for permission");
    assert.ok((await pages()).some((u) => u.endsWith("/onboarding.html")), "onboarding opens to ask");
  });

  await check("granting site access restarts atelier, which then has it, and onboarding comes back to finish", async () => {
    const before = (await pages()).filter((u) => u.endsWith("/onboarding.html")).length;
    await inExtension(async (ext) => {
      // Firefox asks: accept its prompt, as the person would, through the compositor.
      const asked = ext(`browser.permissions.request({ origins: ["<all_urls>"] })`, true).catch(() => "restarted");
      await sleep(1500);
      dev("exec", NAME, "--", "wtype", "-s", "300", "-k", "Return");
      const granted = await Promise.race([asked, sleep(8000).then(() => "no answer")]);
      assert.ok(granted === true || granted === "restarted", `granted (${granted})`);
    }, true);
    // The restart closes onboarding and opens it again, to finish.
    await until("onboarding to open again after the restart", async () => (await pages()).some((u) => u.endsWith("/onboarding.html?granted")));
    void before;
    const state = await until("the extension to come back connected", () =>
      inExtension((ext) => ext(`browser.runtime.sendMessage({ type: "state" }).then((s) => s.connection === "connected" && s)`)),
    );
    assert.equal(state.needsPermission, false);
    const task = await inExtension((ext) =>
      ext(`browser.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(fixture)})).then((t) => browser.runtime.sendMessage({ type: "request", tabId: t.id, text: "Calmer", screenshot: true }))`),
    );
    assert.equal(task.brief.attachments.length, 1, "the request carries a screenshot again");
  });
} finally {
  if (failures) console.log(`\nlogs: ${path.join(instance, "log")}`);
  dev("down", ...(failures ? ["--keep"] : []), NAME);
  if (!failures) fs.rmSync(owned, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
