// End-to-end test for the agent tools (SPEC §10): `atelier mcp` over stdio,
// through the daemon and native host, to the extension and a fixture page.
//
// Build first (`cargo build`, `(cd extension && npm run build)`), then from a
// `nix develop` shell:  node dev/e2e/tools.ts

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const NAME = "e2e-tools";
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const owned = `${instance}-owned`;
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8" });

fs.rmSync(owned, { recursive: true, force: true });
fs.mkdirSync(path.join(owned, "services/fixtures/e2e"), { recursive: true });
fs.writeFileSync(path.join(owned, "atelier.toml"), 'theme = "e2e"\n');
// A style for the fixture, so matched_rules and styles_status have something of ours to see.
fs.writeFileSync(
  path.join(owned, "services/fixtures/e2e/tokens.user.css"),
  `/* ==UserStyle==\n@name tokens fixture\n==/UserStyle== */\n@-moz-document url-prefix("http://127.0.0.1:") {\n  .note { font-weight: 600; }\n}\n`,
);

// One prerequisite the fixture meets, one it doesn't.
fs.writeFileSync(
  path.join(owned, "services/fixtures/service.toml"),
  `prerequisites = [
  { description = "met", check = "header[data-theme]" },
  { description = "Turn on the site's dark mode", check = "html.dark" },
  "no check, so never reported",
]\n`,
);

dev("up", "--name", NAME, "--atelier-dir", owned, "--grant-user-scripts");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const fixture = `http://127.0.0.1:${state.fixturesPort}/tokens/`;

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
/** Calls a tool; returns parsed JSON for text results, the raw content otherwise. */
async function tool(name: string, args: object = {}): Promise<any> {
  const msg = await rpc("tools/call", { name, arguments: args });
  const result = msg.result;
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  if (result.content[0].type === "text") return JSON.parse(result.content[0].text);
  return result.content;
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

  await check("initialize gives instructions, and every tool has a description and schema", async () => {
    assert.match(init.result.instructions, /agent tabs/);
    const { tools } = (await rpc("tools/list")).result;
    assert.ok(tools.length >= 13);
    for (const t of tools) {
      assert.ok(t.description.length > 15, `${t.name} has a description`);
      assert.equal(t.inputSchema.type, "object");
    }
  });

  const { tab } = await tool("tab_open", { url: fixture });

  await check("tab_open returns a loaded agent tab, listed by tab_list", async () => {
    assert.equal(typeof tab, "number");
    const { tabs } = await tool("tab_list");
    assert.deepEqual(tabs.map((t: any) => [t.tab, t.status]), [[tab, "complete"]]);
  });

  await check("tools refuse tabs atelier didn't open", async () => {
    const msg = await rpc("tools/call", { name: "query", arguments: { tab: 1, selector: "body" } });
    assert.equal(msg.result.isError, true);
    assert.match(msg.result.content[0].text, /isn't one of atelier's agent tabs/);
  });

  await check("css_tokens lists tokens, their conditions, and the nested scope", async () => {
    const r = await tool("css_tokens", { tab });
    const accent = r.tokens.find((t: any) => t.name === "--color-accent");
    assert.deepEqual(
      accent.definitions.map((d: any) => [d.selector, d.value, d.context ?? null]),
      [[":root", "#0055cc", null], [":root", "#88aaff", "@media (prefers-color-scheme: dark)"]],
    );
    const scope = r.otherScopes.find((s: any) => s.selector === '[data-theme="inverted"]');
    assert.deepEqual([scope.tokens, scope.matchesRoot, scope.nested], [2, false, ["header"]]);
  });

  await check("matched_rules orders by specificity, labels layers, and includes atelier's rules", async () => {
    const r = await tool("matched_rules", { tab, selector: "h1", property: "color" });
    assert.deepEqual(
      r.rules.map((x: any) => [x.selector, x.specificity.join(","), x.context ?? null]),
      [[".title", "0,1,0", null], ["h1", "0,0,1", null], ["h1", "0,0,1", "@layer base"]],
    );
    const note = await tool("matched_rules", { tab, selector: ".note" });
    assert.ok(note.rules.some((x: any) => x.sheet.startsWith("atelier: services/fixtures/e2e/tokens.user.css")));
  });

  await check("contrast_scan finds exactly the two low-contrast lines", async () => {
    // The faint line, and the title: accent blue inside the inverted header,
    // whose nested scope re-declares background and text but not the accent.
    const r = await tool("contrast_scan", { tab });
    assert.deepEqual(r.failures.map((f: any) => f.text).sort(), ["This line is deliberately low contrast.", "Tokens"]);
    assert.ok(r.failures.every((f: any) => f.ratio < 3));
  });

  await check("computed_style and query report what's on the page", async () => {
    assert.equal((await tool("computed_style", { tab, selector: ".note", properties: ["font-weight"] }))["font-weight"], "600");
    const q = await tool("query", { tab, selector: "p" });
    assert.equal(q.count, 2);
  });

  await check("screenshot returns an image of one element, with the background-tab note", async () => {
    const content = await tool("screenshot", { tab, selector: "header" });
    assert.equal(content[0].type, "image");
    assert.equal(content[0].mimeType, "image/png");
    assert.ok(Buffer.from(content[0].data, "base64").subarray(1, 4).toString() === "PNG");
    assert.match(content[1].text, /background/);
  });

  await check("force_state shows hover and focus-visible styles, and clears them", async () => {
    await tool("force_state", { tab, selector: "a.button", states: ["hover", "focus-visible"] });
    const forced = await tool("computed_style", { tab, selector: "a.button", properties: ["color", "outline-color"] });
    assert.deepEqual([forced.color, forced["outline-color"]], ["rgb(1, 2, 3)", "rgb(4, 5, 6)"]);
    await tool("force_state", { tab, selector: "a.button", states: [] });
    assert.notEqual((await tool("computed_style", { tab, selector: "a.button", properties: ["color"] })).color, "rgb(1, 2, 3)");
  });

  await check("eval sees the DOM", async () => {
    assert.deepEqual(await tool("eval", { tab, expression: "document.title" }), { result: "tokens fixture" });
  });

  await check("styles_status says what applies to the tab", async () => {
    const r = await tool("styles_status", { tab });
    assert.deepEqual(r.tab.applying, ["services/fixtures/e2e/tokens.user.css"]);
    assert.equal(r.tab.shim, true);
    assert.deepEqual(r.tab.unmetPrerequisites, [
      { style: "services/fixtures/e2e/tokens.user.css", description: "Turn on the site's dark mode" },
    ]);
  });

  await check("tab_navigate and tab_close", async () => {
    const r = await tool("tab_navigate", { tab, url: `http://127.0.0.1:${state.fixturesPort}/basic/` });
    assert.equal(r.title, "basic fixture");
    await tool("tab_close", { tab });
    assert.deepEqual((await tool("tab_list")).tabs, []);
  });
} finally {
  server.stdin!.end();
  if (failures) console.log(`\nlogs: ${path.join(instance, "log")}`);
  dev("down", ...(failures ? ["--keep"] : []), NAME);
  if (!failures) fs.rmSync(owned, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
