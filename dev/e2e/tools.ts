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
  `/* ==UserStyle==\n@name tokens fixture\n==/UserStyle== */\n@-moz-document url-prefix("http://127.0.0.1:") {\n  .note { font-weight: 600; & a.button { letter-spacing: 1px; } }\n  @shadow x-widget { .inner { outline: 2px solid rgb(1, 2, 3); } }\n}\n`,
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
    const r = await tool("css_tokens", { tab, verbose: true });
    const accent = r.tokens.find((t: any) => t.name === "--color-accent");
    assert.deepEqual(
      accent.definitions.map((d: any) => [d.selector, d.value, d.context ?? null]),
      [[":root", "#0055cc", null], [":root", "#88aaff", "@media (prefers-color-scheme: dark)"]],
    );
    const scope = r.otherScopes.find((s: any) => s.selector === '[data-theme="inverted"]');
    assert.deepEqual([scope.tokens, scope.matchesRoot, scope.nested], [2, false, ["header"]]);
  });

  await check("css_tokens stays within its output budget, and says how to narrow it", async () => {
    const r = await tool("css_tokens", { tab, maxChars: 400 });
    assert.ok(JSON.stringify(r).length <= 400 || r.shown === 1, "within budget");
    assert.ok(r.shown < r.total);
    assert.match(r.note, /Output capped/);
    assert.ok(r.families.some((f: string) => f.startsWith("--color-* ")), JSON.stringify(r.families));
  });

  await check("css_tokens is compact by default, and scope narrows to a selector", async () => {
    const r = await tool("css_tokens", { tab, filter: "--color-bg" });
    assert.deepEqual(r.tokens[0].defs.map((d: string) => d.replace(/ \(sheet \d+\)$/, "")), [":root = #ffffff", '[data-theme="inverted"] = #222222']);
    assert.match(r.tokens[0].used, /^2× e\.g\. /);
    assert.ok(r.sheets[0].endsWith("/tokens/site.css"));
    const scoped = await tool("css_tokens", { tab, scope: "inverted" });
    assert.deepEqual(scoped.tokens.map((t: any) => t.name), ["--color-bg", "--color-fg"]);
  });

  await check("css_tokens follows @import, and says where tokens are used", async () => {
    const r = await tool("css_tokens", { tab, verbose: true });
    const link = r.tokens.find((t: any) => t.name === "--color-link");
    assert.equal(link.definitions[0].context, "@import");
    assert.match(link.definitions[0].sheet, /theme\.css$/);
    assert.deepEqual(link.used, { count: 1, examples: ["a"] });
    // body, header, h1, a.button and .dim-button, the last through a border shorthand.
    const fg = r.tokens.find((t: any) => t.name === "--color-fg");
    assert.equal(fg.used.count, 5, JSON.stringify(fg.used));
  });

  await check("matched_rules orders by specificity, labels layers, and includes atelier's rules", async () => {
    const r = await tool("matched_rules", { tab, selector: "h1", property: "color" });
    assert.deepEqual(
      r.rules.map((x: any) => [x.selector, x.specificity.join(","), x.context ?? null]),
      [[".title", "0,1,0", null], ["h1", "0,0,1", null], ["h1", "0,0,1", "@layer base"]],
    );
    // A font shorthand resets font-stretch.
    const stretch = await tool("matched_rules", { tab, selector: ".note", property: "font-stretch" });
    assert.match(stretch.rules[0].declarations, /^font-stretch: normal \(via font: /);
    // Nothing on #echo sets its colour; it comes from body.
    const echo = await tool("matched_rules", { tab, selector: "#echo", property: "color" });
    assert.equal(echo.inheritedFrom, "body");
    const note = await tool("matched_rules", { tab, selector: ".note" });
    assert.ok(note.rules.some((x: any) => x.sheet.startsWith("atelier: services/fixtures/e2e/tokens.user.css")));
    // Nested rules are found too, with their selector made absolute.
    const nested = await tool("matched_rules", { tab, selector: ".note a.button", property: "letter-spacing" });
    assert.equal(nested.rules[0]?.selector, ":is(.note) a.button", JSON.stringify(nested.rules));
  });

  await check("css_tokens and matched_rules read cross-origin stylesheets, and @supports is evaluated", async () => {
    const t = await tool("css_tokens", { tab, filter: "--color-remote" });
    assert.equal(t.tokens[0]?.name, "--color-remote", JSON.stringify(t));
    assert.ok(t.sheets.some((s: string) => s.endsWith("(fetched: cross-origin)")), JSON.stringify(t.sheets));
    const r = await tool("matched_rules", { tab, selector: ".remote", property: "letter-spacing" });
    const rules = r.rules.map((x: any) => [x.declarations, x.active, x.context ?? null]);
    assert.deepEqual(rules, [["letter-spacing: 3px", false, "@supports not (display: grid)"], ["letter-spacing: 2px", true, null]]);
    assert.equal(r.computed, "2px");
  });

  await check("contrast_scan finds exactly the two low-contrast lines, skipping the disabled button", async () => {
    // The faint line, and the title: accent blue inside the inverted header,
    // whose nested scope re-declares background and text but not the accent.
    const r = await tool("contrast_scan", { tab });
    assert.deepEqual(r.failures.map((f: any) => f.text).sort(), ["This line is deliberately low contrast.", "Tokens"]);
    assert.ok(r.failures.every((f: any) => f.ratio < 3));
    assert.equal(r.skippedDisabled, 1);
  });

  await check("computed_style and query report what's on the page", async () => {
    assert.equal((await tool("computed_style", { tab, selector: ".note", properties: ["font-weight"] }))["font-weight"], "600");
    const q = await tool("query", { tab, selector: "p" });
    assert.equal(q.count, 3);
  });

  await check("screenshot returns an image of one element, with the background-tab note", async () => {
    const content = await tool("screenshot", { tab, selector: "header" });
    assert.equal(content[0].type, "image");
    assert.equal(content[0].mimeType, "image/png");
    assert.ok(Buffer.from(content[0].data, "base64").subarray(1, 4).toString() === "PNG");
    assert.match(content[1].text, /background/);
  });

  await check("screenshot saveAs writes into the owned directory without echoing the image, and refuses paths outside it", async () => {
    const r = (await rpc("tools/call", { name: "screenshot", arguments: { tab, saveAs: "services/fixtures/e2e/previews/tokens.jpg" } })).result;
    assert.deepEqual(r.content.map((c: any) => c.type), ["text"]);
    assert.match(r.content[0].text, /Saved to/);
    const echoed = await tool("screenshot", { tab, saveAs: "services/fixtures/e2e/previews/tokens.jpg", returnImage: true });
    assert.equal(echoed[0].mimeType, "image/jpeg");
    const saved = fs.readFileSync(path.join(owned, "services/fixtures/e2e/previews/tokens.jpg"));
    assert.equal(saved[0], 0xff); // JPEG magic
    const outside = await rpc("tools/call", { name: "screenshot", arguments: { tab, saveAs: "../escape.png" } });
    assert.equal(outside.result.isError, true);
  });

  await check("force_state shows hover and focus-visible styles, and clears them", async () => {
    await tool("force_state", { tab, selector: "a.button", states: ["hover", "focus-visible"] });
    const forced = await tool("computed_style", { tab, selector: "a.button", properties: ["color", "outline-color"] });
    assert.deepEqual([forced.color, forced["outline-color"]], ["rgb(1, 2, 3)", "rgb(4, 5, 6)"]);
    // A rule saved after forcing shows up in the forced state.
    fs.writeFileSync(path.join(owned, "services/fixtures/e2e/hover.user.css"), `@-moz-document url-prefix("http://127.0.0.1:") { a.button:hover { background-color: rgb(7, 8, 9); } }\n`);
    await tool("styles_status", {});
    await new Promise((r) => setTimeout(r, 800));
    assert.equal((await tool("computed_style", { tab, selector: "a.button", properties: ["background-color"] }))["background-color"], "rgb(7, 8, 9)");
    fs.rmSync(path.join(owned, "services/fixtures/e2e/hover.user.css"));
    await tool("styles_status", {});
    await tool("force_state", { tab, selector: "a.button", states: [] });
    assert.notEqual((await tool("computed_style", { tab, selector: "a.button", properties: ["color"] })).color, "rgb(1, 2, 3)");
  });

  await check("eval sees the DOM, awaits promises, and doesn't leak declarations between calls", async () => {
    assert.deepEqual(await tool("eval", { tab, expression: "document.title" }), { result: "tokens fixture" });
    assert.deepEqual(await tool("eval", { tab, expression: "const out = 1; out" }), { result: 1 });
    assert.deepEqual(await tool("eval", { tab, expression: "const out = 2; Promise.resolve(out + 1)" }), { result: 3 });
  });

  await check("screenshot scale enlarges small captures", async () => {
    const size = async (scale: number) => {
      const [img] = await tool("screenshot", { tab, selector: "h1", scale });
      return Buffer.from(img.data, "base64").readUInt32BE(16); // PNG IHDR width
    };
    const [one, three] = [await size(1), await size(3)];
    assert.ok(Math.abs(three - 3 * one) <= 3, `${one} → ${three}`);
  });

  await check("type_text fires input events the page reacts to", async () => {
    await tool("type_text", { tab, selector: "#search", text: "firefox" });
    assert.deepEqual(await tool("eval", { tab, expression: "document.getElementById('echo').textContent" }), { result: "firefox" });
  });

  await check("tab_navigate's waitFor waits for late content, and warns when it doesn't come", async () => {
    const ok = await tool("tab_navigate", { tab, url: fixture, waitFor: "#late" });
    assert.equal(ok.warning, undefined);
    const missing = await tool("tab_navigate", { tab, url: fixture, waitFor: "#never", waitForMs: 500 });
    assert.match(missing.warning, /matched nothing within/);
  });

  await check("styles_status waits for a file just written, and counts per service", async () => {
    fs.writeFileSync(path.join(owned, "services/fixtures/e2e/extra.user.css"), `@-moz-document url-prefix("http://127.0.0.1:") { main { margin-top: 1px; } }\n`);
    const r = await tool("styles_status", { tab });
    assert.ok(r.tab.applying.includes("services/fixtures/e2e/extra.user.css"), JSON.stringify(r.tab.applying));
    assert.equal(r.byService.fixtures, 2);
    fs.rmSync(path.join(owned, "services/fixtures/e2e/extra.user.css"));
  });

  await check("styles_status says what applies to the tab", async () => {
    await tool("styles_status", {}); // let the removal above settle
    const r = await tool("styles_status", { tab });
    assert.deepEqual(r.tab.applying, ["services/fixtures/e2e/tokens.user.css"]);
    assert.equal(r.tab.shim, true);
    assert.deepEqual(r.tab.unmetPrerequisites, [
      { style: "services/fixtures/e2e/tokens.user.css", description: "Turn on the site's dark mode" },
    ]);
  });

  await check("screenshot's extraCss shows a variant just for the capture", async () => {
    const content = await tool("screenshot", { tab, extraCss: "html { background: rgb(255, 0, 0) !important; }", scale: 0.25 });
    assert.equal(content[0].type, "image");
    const { result } = await tool("eval", { tab, expression: "document.querySelector('style[data-atelier-extra]') === null" });
    assert.equal(result, true, "the extra style is removed afterwards");
  });

  await check("shape_scan lists what's still drawn as a box, controls and round things apart", async () => {
    const { tab: cards } = await tool("tab_open", { url: fixture.replace("/tokens/", "/cards/") });
    const r = await tool("shape_scan", { tab: cards });
    const card = r.boxes.find((g: any) => g.selector === "div.card");
    assert.equal(card?.count, 2, JSON.stringify(r));
    assert.deepEqual([...card.features].sort(), ["filled", "rounded 8px", "shadow"]);
    assert.ok(r.boxes.some((g: any) => g.selector === "div.panel" && g.features.includes("framed")));
    assert.ok(!r.boxes.some((g: any) => g.selector === "div.row"), "a flat row isn't a box");
    assert.ok(r.controls.some((g: any) => g.selector === "button"));
    assert.ok(r.probablyRoundByNature.some((g: any) => g.selector === "span.avatar"));
    assert.ok(!r.controls.some((g: any) => g.selector === "button.ghost"), "a transparent border isn't a frame");
    assert.ok(r.boxes.some((g: any) => g.selector === "x-widget › div.inner" && g.features.includes("rounded 6px")), JSON.stringify(r.boxes));
    // @shadow styles reach inside the component, and the tools follow with >>>.
    const inner = await tool("computed_style", { tab: cards, selector: "x-widget >>> .inner", properties: ["outline-color"] });
    assert.equal(inner["outline-color"], "rgb(1, 2, 3)", JSON.stringify(inner));
    const why = await tool("matched_rules", { tab: cards, selector: "x-widget >>> .inner", property: "outline-color" });
    assert.ok(why.rules.some((x: any) => x.sheet === "x-widget >>> atelier: shadow"), JSON.stringify(why));
    // contrast_scan reads text inside shadow roots, against the backgrounds outside.
    const contrast = await tool("contrast_scan", { tab: cards });
    assert.ok(contrast.failures.some((x: any) => x.element.startsWith("x-widget >>> ") && x.text === "faint text"), JSON.stringify(contrast.failures));
    // type_text reaches a text field inside a web component's shadow root.
    const typed = await tool("type_text", { tab: cards, selector: "x-widget", text: "grid" });
    assert.deepEqual([typed.value, typed.inShadowRootOf], ["grid", "x-widget"]);
    await tool("tab_close", { tab: cards });
  });

  await check("tokens, forced states and colour-scheme emulation reach into shadow roots", async () => {
    const { tab: cards } = await tool("tab_open", { url: fixture.replace("/tokens/", "/cards/") });
    const tokens = await tool("css_tokens", { tab: cards, filter: "widget-accent", verbose: true });
    assert.equal(tokens.tokens[0]?.definitions[0]?.sheet, "x-widget >>> <style>", JSON.stringify(tokens));
    const color = async () => (await tool("computed_style", { tab: cards, selector: "x-widget >>> .tag", properties: ["color"] })).color;
    assert.equal(await color(), "rgb(0, 0, 0)");
    await tool("force_state", { tab: cards, selector: "x-widget >>> .tag", states: ["hover"] });
    assert.equal(await color(), "rgb(0, 128, 0)", "the shadow root's :hover rule is forced");
    await tool("force_state", { tab: cards, selector: "x-widget >>> .tag", states: [] });
    await tool("color_scheme", { tab: cards, scheme: "dark" });
    assert.equal(await color(), "rgb(255, 255, 255)", "the shadow root's dark-scheme rule applies");
    await tool("tab_close", { tab: cards });
  });

  await check("eval explains top-level await, and tall elements are captured from the top", async () => {
    await assert.rejects(tool("eval", { tab, expression: "await Promise.resolve(1)" }), /no top-level await here/);
    assert.equal((await tool("eval", { tab, expression: "(async () => { return await Promise.resolve(2); })()" })).result, 2);
    await tool("eval", { tab, expression: "const d = document.createElement('div'); d.id = 'tall'; d.style.height = '9000px'; document.body.append(d); 0" });
    const shot = await rpc("tools/call", { name: "screenshot", arguments: { tab, selector: "#tall", scale: 0.1 } });
    const text = shot.result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
    assert.match(text, /is 9000px tall; captured its top 4000px/);
    await tool("eval", { tab, expression: "document.getElementById('tall').remove(); 0" });
  });

  await check("color_scheme says what it can't emulate, and only when the page has it", async () => {
    const { tab: gaps } = await tool("tab_open", { url: fixture.replace("/tokens/", "/scheme-frames/") });
    const r = await tool("color_scheme", { tab: gaps, scheme: "dark" });
    assert.equal(r.notEmulated?.frames, 1, JSON.stringify(r));
    assert.match(r.notEmulated?.svgImages?.[0] ?? "", /adaptive\.svg$/, JSON.stringify(r));
    const shot = await rpc("tools/call", { name: "screenshot", arguments: { tab: gaps } });
    const text = shot.result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    assert.match(text, /Not emulated on this page: 1 frame/, text);
    await tool("tab_close", { tab: gaps });
    // The color-scheme fixture's SVG images don't carry scheme rules: nothing to say.
    const { tab: clean } = await tool("tab_open", { url: fixture.replace("/tokens/", "/color-scheme/") });
    assert.equal((await tool("color_scheme", { tab: clean, scheme: "dark" })).notEmulated, undefined);
    await tool("tab_close", { tab: clean });
  });

  await check("color_scheme makes one tab dark: stylesheets, cross-origin ones, media attributes, matchMedia", async () => {
    const url = fixture.replace("/tokens/", "/color-scheme/");
    const { tab: cs } = await tool("tab_open", { url });
    const report = async () => (await tool("eval", { tab: cs, expression: "JSON.parse(JSON.stringify(window.wrappedJSObject.__scheme()))" })).result;
    const before = await report();
    assert.equal(before.mediaSame, "light", JSON.stringify(before));
    await tool("color_scheme", { tab: cs, scheme: "dark" });
    await new Promise((r) => setTimeout(r, 1000)); // the cross-origin copy is fetched after load
    const dark = await report();
    for (const k of ["mediaSame", "mediaCross", "linkMedia", "lightDark", "jsAtStartup", "jsNow", "picture"]) {
      assert.equal(dark[k], "dark", `${k}: ${JSON.stringify(dark)}`);
    }
    const shot = await rpc("tools/call", { name: "screenshot", arguments: { tab: cs, scale: 0.1 } });
    assert.ok(shot.result.content.some((c: any) => c.type === "text" && /emulates the dark colour scheme/.test(c.text)));
    await tool("color_scheme", { tab: cs, scheme: null });
    assert.equal((await report()).mediaSame, "light");
    await tool("tab_close", { tab: cs });
  });

  await check("a throwaway tab has the user's cookies, and what changes there stays there", async () => {
    await tool("eval", { tab, expression: "document.cookie = 'seen=1; path=/'; 0" });
    const opened = await tool("tab_open", { url: fixture, throwaway: true });
    assert.equal(opened.throwaway, true);
    assert.ok(opened.cookiesCopied >= 1, JSON.stringify(opened));
    const away = opened.tab;
    assert.match((await tool("eval", { tab: away, expression: "document.cookie" })).result, /seen=1/);
    await tool("eval", { tab: away, expression: "document.cookie = 'theme=dark; path=/'; 0" });
    assert.doesNotMatch((await tool("eval", { tab, expression: "document.cookie" })).result, /theme=dark/, "the user's cookies are untouched");
    await tool("tab_close", { tab: away });
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
