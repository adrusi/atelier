// End-to-end test for tasks through `atelier mcp` (SPEC §8, §10.1): what a
// session started with the `work` prompt does, from the queue to a landing.
//
// Build first (`cargo build`, `(cd extension && npm run build)`), then from a
// `nix develop` shell:  node dev/e2e/tasks.ts

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const NAME = "e2e-tasks";
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const owned = `${instance}-owned`;
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8" });

const style = (value: string) =>
  `/* ==UserStyle==\n@name e2e\n==/UserStyle== */\n@-moz-document url-prefix("http://127.0.0.1:") {\n  html { --e2e: ${value}; }\n}\n`;
const STYLE = "services/fixtures/e2e/e2e.user.css";
const PREVIEW = "services/fixtures/e2e/previews/plain.jpg";

fs.rmSync(owned, { recursive: true, force: true });
fs.mkdirSync(path.join(owned, "themes/e2e"), { recursive: true });
fs.mkdirSync(path.dirname(path.join(owned, STYLE)), { recursive: true });
fs.writeFileSync(path.join(owned, "atelier.toml"), 'theme = "e2e"\n');
fs.writeFileSync(path.join(owned, "themes/e2e/THEME.md"), "# e2e\n\nEverything teal.\n");
fs.writeFileSync(path.join(owned, STYLE), style("default"));

dev("up", "--name", NAME, "--atelier-dir", owned, "--grant-user-scripts");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const fixture = `http://127.0.0.1:${state.fixturesPort}/plain/`;

// An MCP client over the server's stdio.
const server = spawn("atelier-dev", ["atelier", NAME, "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
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
/** Calls a tool; returns its text, or throws with it if it's an error. */
async function tool(name: string, args: object = {}): Promise<string> {
  const { result } = await rpc("tools/call", { name, arguments: args });
  const text = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  if (result.isError) throw new Error(`${name}: ${text}`);
  return text;
}
const json = async (name: string, args: object = {}) => JSON.parse(await tool(name, args));
const e2e = async (tab: number) =>
  (await json("eval", { tab, expression: "getComputedStyle(document.documentElement).getPropertyValue('--e2e').trim()" })).result;
async function expectValue(tab: number, want: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let got = await e2e(tab);
  while (got !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    got = await e2e(tab);
  }
  assert.equal(got, want, `tab ${tab}`);
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
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  await check("the server offers the work prompt, with the user's request worked in", async () => {
    assert.ok(init.result.capabilities.prompts);
    const { prompts } = (await rpc("prompts/list")).result;
    assert.deepEqual(prompts.map((p: any) => p.name), ["work"]);
    const { messages } = (await rpc("prompts/get", { name: "work", arguments: { request: "make it teal" } })).result;
    assert.match(messages[0].content.text, /"make it teal"/);
    assert.match(messages[0].content.text, /task_list/);
  });

  await check("an empty queue says so, and waiting for work times out politely", async () => {
    assert.equal(await tool("task_list"), "Nothing is queued.");
    const started = Date.now();
    assert.match(await tool("task_claim", { waitSeconds: 3 }), /Nothing was queued in the 3s waited/);
    assert.ok(Date.now() - started >= 2500);
  });

  let tree = "";
  let tab = 0;
  await check("a task created in conversation can be claimed, with a brief that says where to work", async () => {
    assert.match(await tool("task_create", { description: "make the plain page teal", service: "fixtures" }), /^Queued as task t/);
    assert.match(await tool("task_list"), /make the plain page teal/);
    const brief = await tool("task_claim");
    assert.match(brief, /The user asked: make the plain page teal/);
    assert.match(brief, /themes\/e2e\/THEME\.md/);
    tree = brief.match(/The task's tree is (\S+): /)![1];
    assert.ok(fs.existsSync(path.join(tree, STYLE)));
  });

  await check("tabs open on the held task's tree; task: null shows the user's styles", async () => {
    fs.writeFileSync(path.join(tree, STYLE), style("teal"));
    ({ tab } = await json("tab_open", { url: fixture }));
    await expectValue(tab, "teal");
    const { tab: users } = await json("tab_open", { url: fixture, task: null });
    await expectValue(users, "default");
    await tool("tab_close", { tab: users });
    const status = await json("styles_status", { tab });
    assert.equal(status.tab.styleFiles, tree);
    // Without a tab, it reports the held task's tree, and says so.
    const untabbed = await json("styles_status");
    assert.match(untabbed.showing, /^task t\S+'s tree$/);
  });

  await check("previews are saved into the task's tree", async () => {
    await tool("screenshot", { tab, saveAs: PREVIEW });
    assert.ok(fs.existsSync(path.join(tree, PREVIEW)));
    assert.ok(!fs.existsSync(path.join(owned, PREVIEW)));
  });

  await check("task_info lists what's changed so far", async () => {
    const info = await tool("task_info");
    assert.match(info, new RegExp(`- ${STYLE} \\(modified\\)`));
    assert.match(info, new RegExp(`- ${PREVIEW} \\(added\\)`));
  });

  await check("a file the user changed meanwhile comes back with its contents, and the merge lands", async () => {
    fs.writeFileSync(path.join(owned, STYLE), style("hand-edited"));
    const first = await tool("task_submit", { summary: "Teal", assumptions: ["teal means #008080"] });
    assert.match(first, /^Not landed yet/);
    assert.match(first, /\[conflict\]/);
    assert.match(first, /--e2e: hand-edited/);
    // The agent merges (here: keeps their own value) and submits again.
    const second = await tool("task_submit", { summary: "Teal", assumptions: ["teal means #008080"] });
    assert.match(second, /^Landed as journal entry 1/);
    assert.match(fs.readFileSync(path.join(owned, STYLE), "utf8"), /teal/);
    assert.ok(fs.existsSync(path.join(owned, PREVIEW)));
    await expectValue(tab, "teal");
  });

  await check("after landing, the session holds nothing", async () => {
    await assert.rejects(tool("task_info"), /you don't hold a task/);
    const { tabs } = await json("tab_list");
    assert.ok(tabs.every((t: any) => t.task === undefined));
  });

  await check("a released task keeps its tree and handoff for the next claim", async () => {
    await tool("task_create", { description: "now make it mauve", kind: "revise", service: "fixtures" });
    const brief = await tool("task_claim");
    const tree2 = brief.match(/The task's tree is (\S+): /)![1];
    fs.writeFileSync(path.join(tree2, STYLE), style("mauve"));
    assert.match(await tool("task_release", { handoff: "mauve set; previews still to do" }), /Released/);
    const again = await tool("task_claim");
    assert.match(again, /## Handoff from whoever worked on this before\n\nmauve set; previews still to do/);
    assert.match(again, /## Changed in the tree so far/);
  });

  await check("declining lets the task go, with the reason recorded", async () => {
    assert.match(await tool("task_decline", { reason: "the theme says teal" }), /Declined/);
    const list = execFileSync("atelier-dev", ["atelier", NAME, "task", "list"], { encoding: "utf8" });
    assert.match(list, /declined/);
  });
} finally {
  server.stdin!.end();
  dev("down", ...(failures ? ["--keep"] : []), NAME);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
