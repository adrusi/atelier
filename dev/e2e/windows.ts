// End-to-end test for agent windows (SPEC §9.1): with `[session] windows`, an
// agent session's tabs open in a Firefox window of its own, the
// on_agent_window hook hears about it, and when the session ends (its
// `atelier mcp` goes away) its tabs close, and the window with them.
//
// Build first (`cargo build`, `(cd extension && npm run build)`), then from a
// `nix develop` shell:  node dev/e2e/windows.ts

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { evaluate, withSession } from "../bidi.ts";

const NAME = "e2e-windows";
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const owned = `${instance}-owned`;
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(owned, { recursive: true, force: true });
fs.mkdirSync(owned, { recursive: true });
fs.writeFileSync(path.join(owned, "atelier.toml"), 'theme = "e2e"\n');
const heard = path.join(owned, "hook.log");

dev("up", "--name", NAME, "--atelier-dir", owned, "--grant-user-scripts", "--system-access");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const fixture = `http://127.0.0.1:${state.fixturesPort}/plain/`;
// Read on each call, so it can be written now.
fs.mkdirSync(path.join(instance, "home/.config/atelier"), { recursive: true });
fs.writeFileSync(
  path.join(instance, "home/.config/atelier/config.toml"),
  `[session]\nwindows = true\n\n[hooks]\non_agent_window = 'echo "$ATELIER_FIREFOX_WINDOW_ID $ATELIER_AGENT $ATELIER_AGENT_PID" >> ${heard}'\n`,
);

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

async function until<T>(what: string, f: () => Promise<T | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}

/** Firefox's windows, with the URLs of their tabs, as the extension sees them. */
async function windows(): Promise<{ id: number; urls: string[] }[]> {
  return withSession(state.bidiPort, async (bidi) => {
    const { contexts } = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
    const ext = contexts.find((c: { url: string }) => c.url.startsWith("moz-extension://"));
    return evaluate(bidi, ext.context, `browser.windows.getAll({ populate: true }).then((ws) => ws.map((w) => ({ id: w.id, urls: w.tabs.map((t) => t.url) })))`);
  });
}

// An MCP session, as a harness started by atelier-agent runs it.
const agentPid = String(process.pid);
const server = spawn("atelier-dev", ["atelier", NAME, "mcp"], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ATELIER_AGENT_PID: agentPid } });
const pending = new Map<number, (msg: any) => void>();
readline.createInterface({ input: server.stdout! }).on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
let nextId = 1;
const rpc = (method: string, params: object = {}): Promise<any> =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
async function tool(name: string, args: object = {}): Promise<any> {
  const result = (await rpc("tools/call", { name, arguments: args })).result;
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
}

try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  const before = await windows();

  await check("an agent session's tabs open together in a window of its own, and the hook hears of it once", async () => {
    const a = await tool("tab_open", { url: fixture });
    assert.equal(a.window, undefined, "the window is the daemon's business, not the agent's");
    await tool("tab_open", { url: `${fixture}?second` });
    const after = await windows();
    assert.equal(after.length, before.length + 1, JSON.stringify(after));
    const mine = after.find((w) => !before.some((b) => b.id === w.id))!;
    assert.deepEqual(mine.urls, [fixture, `${fixture}?second`]);
    const lines = (await until("the hook to run", async () => fs.existsSync(heard) && fs.readFileSync(heard, "utf8"))).trim().split("\n");
    assert.deepEqual(lines, [`${mine.id} agent-${agentPid} ${agentPid}`]);
  });

  await check("when the session ends, its tabs close, and its window with them", async () => {
    server.stdin!.end();
    await until("the agent's window to close", async () => (await windows()).length === before.length);
    const urls = (await windows()).flatMap((w) => w.urls);
    assert.ok(!urls.some((u) => u?.startsWith(fixture)), JSON.stringify(urls));
  });
} finally {
  server.kill();
  if (failures) console.log(`\nlogs: ${path.join(instance, "log")}`);
  dev("down", ...(failures ? ["--keep"] : []), NAME);
  if (!failures) fs.rmSync(owned, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
