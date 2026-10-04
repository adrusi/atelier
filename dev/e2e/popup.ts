// End-to-end test for requests from the popup (SPEC §6.4): asking for a
// change queues a task with a screenshot, the popup follows the task, and
// its undo button undoes the landing.
//
// The popup is opened as a page of its own (popup.html?tab=ID, about the
// fixture's tab), and driven with keystrokes through the compositor, since
// BiDi can't script extension pages.
//
// Build first (`cargo build`, `(cd extension && npm run build)`), then from a
// `nix develop` shell:  node dev/e2e/popup.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { withSession } from "../bidi.ts";

const NAME = "e2e-popup";
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const owned = `${instance}-owned`;
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8" });
const atelier = (...args: string[]) => dev("atelier", NAME, ...args);
const browser = (method: string, params: object = {}) => JSON.parse(atelier("browser", method, JSON.stringify(params)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Keystrokes into the focused window, through the compositor. wtype takes
 * keys (-k) and text in order; sway runs it asynchronously, so wait after. */
async function keys(...args: string[]) {
  dev("exec", NAME, "--", "wtype", "-s", "300", ...args);
  await sleep(1500 + 100 * args.length);
}

const style = (value: string) =>
  `/* ==UserStyle==\n@name e2e\n==/UserStyle== */\n@-moz-document url-prefix("http://127.0.0.1:") {\n  html { --e2e: ${value}; }\n}\n`;
const STYLE = "services/fixtures/e2e/e2e.user.css";

fs.rmSync(owned, { recursive: true, force: true });
fs.mkdirSync(path.dirname(path.join(owned, STYLE)), { recursive: true });
fs.writeFileSync(path.join(owned, "atelier.toml"), 'theme = "e2e"\n');
fs.writeFileSync(path.join(owned, STYLE), style("default"));

dev("up", "--name", NAME, "--atelier-dir", owned, "--grant-user-scripts", "--system-access");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const fixture = `http://127.0.0.1:${state.fixturesPort}/plain/`;

async function until<T>(what: string, f: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** Shows popup.html?tab=ID in a new tab, in front. BiDi won't touch a tab
 * that's already showing an extension page, but it can send a new one there. */
async function openPopup(tab: number) {
  await withSession(state.bidiPort, async (bidi) => {
    const { contexts } = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
    const ext = contexts.find((c: { url: string }) => c.url.startsWith("moz-extension://"));
    assert.ok(ext, "the extension's onboarding page is open");
    const base = ext.url.replace(/\/[^/]*$/, "");
    const { context } = await bidi.send("browsingContext.create", { type: "tab" });
    await bidi.send("browsingContext.navigate", { context, url: `${base}/popup.html?tab=${tab}`, wait: "complete" });
  });
  await sleep(1000);
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

const listIds = () =>
  atelier("task", "list")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[0]);

try {
  const { tab } = browser("tab/open", { url: fixture });
  let id = "";

  await check("asking from the popup queues a revise with a screenshot of the page", async () => {
    await openPopup(tab);
    // Focus starts on the page: Tab reaches the request box first.
    // Past the screenshot box to the button.
    await keys("-k", "Tab", "the links are hard to see", "-k", "Tab", "-k", "Tab", "-k", "Return");
    id = await until("the task", () => listIds()[0]);
    const task = JSON.parse(atelier("task", "show", id));
    assert.equal(task.kind, "revise");
    assert.equal(task.service, "fixtures");
    assert.equal(task.brief.description, "the links are hard to see");
    assert.equal(task.brief.origin, fixture);
    assert.equal(task.brief.attachments.length, 1);
    const shot = fs.readFileSync(task.brief.attachments[0]);
    assert.deepEqual([...shot.subarray(0, 2)], [0xff, 0xd8], "a JPEG");
  });

  await check("once it lands, the popup's undo button undoes it", async () => {
    const claimed = JSON.parse(atelier("task", "claim", id));
    fs.writeFileSync(path.join(claimed.tree, STYLE), style("revised"));
    assert.equal(JSON.parse(atelier("task", "submit", id, "Brighter links")).result, "landed");
    await openPopup(tab); // fresh, so focus order is known
    // Request box, screenshot box, ask button, then undo.
    await keys("-k", "Tab", "-k", "Tab", "-k", "Tab", "-k", "Tab", "-k", "Return");
    await until("the undo", () => atelier("journal").includes("(undone)") || undefined);
    assert.match(fs.readFileSync(path.join(owned, STYLE), "utf8"), /default/);
  });

  dev("screenshot", NAME, `${instance}-popup.png`);
  console.log(`(popup screenshot: ${instance}-popup.png)`);
} finally {
  dev("down", ...(failures ? ["--keep"] : []), NAME);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
