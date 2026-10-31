// A tour of atelier's UI: brings up a dev instance, puts it into each state
// a person meets (first run, an unstyled site, a request, a styled site with
// a change to undo, the daemon gone, the inbox with agents' calls and
// proposals), and captures each, for looking over the UX and for checking a
// change to it. Screenshots go to $XDG_RUNTIME_DIR/atelier-dev/tour-shots/ (or
// --out DIR), named in order, with an index.txt saying what each shows.
//
// Build first (`cargo build`, `(cd extension && npm run build)`), then from a
// `nix develop` shell:  node dev/tour.ts [--out DIR]

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { type Bidi, Bidi as BidiClient, evaluate } from "./bidi.ts";

const RUNTIME = path.join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "atelier-dev");
const args = process.argv.slice(2);
const out = args.includes("--out") ? path.resolve(args[args.indexOf("--out") + 1]) : path.join(RUNTIME, "tour-shots");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dev = (...a: string[]) => execFileSync("atelier-dev", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const index: string[] = [];
let shot = 0;

/** The owned directory a person might have after a little use. */
function makeOwned(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write("atelier.toml", 'theme = "dusk"\n');
  write("themes/dusk/THEME.md", "# dusk\n\nCalm and dark: deep blue-grey surfaces, soft text, one lavender accent.\n");
  write(
    "services/fixtures/service.toml",
    'description = "The dev fixtures"\nsummary = "Dark surfaces and soft text"\n',
  );
  write(
    "services/fixtures/dusk/base.user.css",
    `/* ==UserStyle==\n@name Fixtures: dark\n==/UserStyle== */\n@-moz-document url-prefix("http://127.0.0.1:") {\n  html { background: #1e1e2e; color: #cdd6f4; }\n  a { color: #b4befe; }\n}\n`,
  );
}

/** The instance being toured. */
let current = "";

/** Captures what the person sees with this context's tab in front: the
 * whole window, through the compositor (BiDi won't capture extension pages,
 * and the browser around the page is part of the picture anyway). */
async function capture(bidi: Bidi, context: string, name: string, what: string) {
  await evaluate(bidi, context, "browser.tabs.getCurrent().then((t) => browser.tabs.update(t.id, { active: true })).then(() => 0)").catch(() =>
    bidi.send("browsingContext.activate", { context }),
  );
  await sleep(700);
  shot++;
  const file = `${String(shot).padStart(2, "0")}-${name}.png`;
  dev("screenshot", current, path.join(out, file));
  index.push(`${file}: ${what}`);
  console.log(`${file}: ${what}`);
}

async function withBidi<T>(instance: string, f: (bidi: Bidi) => Promise<T>): Promise<T> {
  const state = JSON.parse(fs.readFileSync(path.join(RUNTIME, instance, "state.json"), "utf8"));
  const bidi = await BidiClient.connect(state.bidiPort);
  await bidi.send("session.new", { capabilities: {} });
  try {
    return await f(bidi);
  } finally {
    await bidi.send("session.end").catch(() => {});
    bidi.close();
  }
}

async function contexts(bidi: Bidi): Promise<{ context: string; url: string }[]> {
  return (await bidi.send("browsingContext.getTree", { maxDepth: 0 })).contexts;
}

async function openTab(bidi: Bidi, url: string): Promise<string> {
  const { context } = await bidi.send("browsingContext.create", { type: "tab" });
  await bidi.send("browsingContext.navigate", { context, url, wait: "complete" }).catch(() => {});
  await sleep(800);
  return context;
}

// 1. First run: the extension installed, the permission not yet granted.
{
  const name = "tour-fresh";
  const owned = path.join(RUNTIME, `${name}-owned`);
  makeOwned(owned);
  dev("up", "--name", name, "--atelier-dir", owned, "--system-access");
  current = name;
  try {
    await sleep(3000);
    await withBidi(name, async (bidi) => {
      const onboarding = (await contexts(bidi)).find((c) => c.url.endsWith("/onboarding.html"));
      if (onboarding) await capture(bidi, onboarding.context, "onboarding", "First run: the page the extension opens on install, asking for the user-scripts permission");
      else index.push("(no onboarding page opened on install)");
    });
  } finally {
    dev("down", name);
  }
}

// 2. Everything else, in an instance with the permission granted.
const name = "tour";
const owned = path.join(RUNTIME, `${name}-owned`);
makeOwned(owned);
dev("up", "--name", name, "--atelier-dir", owned, "--grant-user-scripts", "--system-access");
current = name;
const state = JSON.parse(fs.readFileSync(path.join(RUNTIME, name, "state.json"), "utf8"));
const plainUrl = `http://localhost:${state.fixturesPort}/plain/`;
const styledUrl = `http://127.0.0.1:${state.fixturesPort}/basic/`;
const atelier = (...a: string[]) => dev("atelier", name, ...a);

// An agent session, for posting calls and design notes as an agent would.
const mcp = spawn("atelier-dev", ["atelier", name, "mcp"], { stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map<number, (m: any) => void>();
readline.createInterface({ input: mcp.stdout! }).on("line", (line) => {
  const m = JSON.parse(line);
  pending.get(m.id)?.(m);
});
let nextId = 1;
const rpc = (method: string, params: object = {}): Promise<any> =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    mcp.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const tool = async (n: string, a: object = {}) => (await rpc("tools/call", { name: n, arguments: a })).result;

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tour", version: "0" } });
  mcp.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  await withBidi(name, async (bidi) => {
    const onboarding = (await contexts(bidi)).find((c) => c.url.endsWith("/onboarding.html"))!;
    await sleep(2000);
    await capture(bidi, onboarding.context, "onboarding-granted", "First run, after allowing user scripts: whether the atelier program answers, and what's next");
    const base = onboarding.url.replace(/\/[^/]*$/, "");
    const plain = await openTab(bidi, plainUrl);
    const styled = await openTab(bidi, styledUrl);
    // The extension's own id for a tab, for popup.html?tab=ID.
    const tabId = async (url: string) => {
      const page = await openTab(bidi, `${base}/inbox.html`);
      const id = (await evaluate(bidi, page, `browser.tabs.query({}).then((ts) => ts.find((t) => t.url === ${JSON.stringify(url)}).id)`)) as number;
      await bidi.send("browsingContext.close", { context: page });
      return id;
    };
    const popup = async (url: string) => openTab(bidi, `${base}/popup.html?tab=${await tabId(url)}`);
    void plain;
    void styled;

    let p = await popup(plainUrl);
    await capture(bidi, p, "popup-unstyled", "The popup on a site with no style yet");

    // The person clicks "Style this site".
    await evaluate(bidi, p, `document.getElementById("send").click(), 0`);
    await sleep(2500);
    await capture(bidi, p, "popup-requested", "The same popup just after clicking \"Style this site\" (no agent session is running)");
    await bidi.send("browsingContext.close", { context: p });

    // A change that landed on the styled site, to undo.
    const task = JSON.parse(atelier("task", "create", "--kind", "revise", "--service", "fixtures", "--origin", styledUrl, "Links are too faint")).id;
    const tree = JSON.parse(atelier("task", "claim", task)).tree;
    fs.appendFileSync(path.join(tree, "services/fixtures/dusk/base.user.css"), "/* brighter links */\n");
    atelier("task", "submit", task, "Brighter links");
    p = await popup(styledUrl);
    await capture(bidi, p, "popup-styled", "The popup on a styled site, after a requested change landed");
    await bidi.send("browsingContext.close", { context: p });

    // The inbox, empty.
    let inbox = await openTab(bidi, `${base}/inbox.html`);
    await capture(bidi, inbox, "inbox-empty", "The inbox with nothing waiting");
    await bidi.send("browsingContext.close", { context: inbox });

    // An agent asks, proposes, and adds a design note.
    await tool("task_create", { description: "Style the plain fixture", kind: "create", service: "fixtures", origin: plainUrl });
    await tool("task_claim");
    await tool("task_ask", {
      wait: "record",
      summary: "First pass done; two calls I made",
      calls: [
        { question: "Should visited links dim?", options: ["dim", "keep"], choice: "dim", context: "The theme doesn't say; most sites dim them." },
        { question: "Headings in the accent colour, or the text colour?", options: ["accent", "text"], choice: "text" },
      ],
    });
    await tool("theme_propose", { summary: "Visited links dim to the secondary text colour", why: "Came up on the fixtures", edits: [{ replace: "\nVisited links dim to the secondary text colour.\n" }] });
    await tool("theme_propose", { file: "notes.md", summary: "Code blocks are square panes", edits: [{ replace: "- Code blocks are square panes in the surface colour. (fixtures)\n" }] });
    inbox = await openTab(bidi, `${base}/inbox.html`);
    await sleep(1500);
    await capture(bidi, inbox, "inbox-waiting", "The inbox with an agent's calls, a THEME.md proposal and a design note");
    await bidi.send("browsingContext.close", { context: inbox });

    // The popup on that site now: a request in progress, and the inbox link.
    p = await popup(plainUrl);
    await capture(bidi, p, "popup-in-progress", "The popup while an agent works on the site, with things waiting in the inbox");
    await bidi.send("browsingContext.close", { context: p });
  });

  // The daemon gone (it crashed, or atelier isn't installed right).
  execFileSync("pkill", ["-f", `atelier daemon --dir ${owned}`]);
  await sleep(1500);
  await withBidi(name, async (bidi) => {
    const base = (await contexts(bidi)).find((c) => c.url.startsWith("moz-extension://"))!.url.replace(/\/[^/]*$/, "");
    const p = await openTab(bidi, `${base}/popup.html`);
    await capture(bidi, p, "popup-disconnected", "The popup right after the daemon stopped");
  });
} finally {
  mcp.kill();
  fs.writeFileSync(path.join(out, "index.txt"), index.join("\n") + "\n");
  dev("down", name);
  console.log(`\n${shot} screenshots in ${out}`);
}
