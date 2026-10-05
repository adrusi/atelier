// End-to-end test for calls (SPEC §9.5): an agent puts questions to the user
// with screenshots, the task waits, the user answers, and the agent sees the
// answers when it picks the task up again. Also: recorded assumptions, a
// changed one becoming a new task, and the theme's stage in briefs.
//
// Build first (`cargo build`, `(cd extension && npm run build)`), then from a
// `nix develop` shell:  node dev/e2e/calls.ts

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { withSession } from "../bidi.ts";

const NAME = "e2e-calls";
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const owned = `${instance}-owned`;
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8" });
const atelier = (...args: string[]) => dev("atelier", NAME, ...args);

const STYLE = "services/fixtures/e2e/e2e.user.css";
fs.rmSync(owned, { recursive: true, force: true });
fs.mkdirSync(path.join(owned, "themes/e2e"), { recursive: true });
fs.mkdirSync(path.dirname(path.join(owned, STYLE)), { recursive: true });
fs.writeFileSync(path.join(owned, "atelier.toml"), 'theme = "e2e"\n');
fs.writeFileSync(path.join(owned, "themes/e2e/THEME.md"), "# e2e\n\nCalm and dark.\n");
fs.writeFileSync(
  path.join(owned, STYLE),
  `/* ==UserStyle==\n@name e2e\n==/UserStyle== */\n@-moz-document url-prefix("http://127.0.0.1:") {\n  html { background: #1e1e2e; color: #cdd6f4; }\n}\n`,
);

dev("up", "--name", NAME, "--atelier-dir", owned, "--grant-user-scripts", "--system-access");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const fixture = `http://127.0.0.1:${state.fixturesPort}/plain/`;

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
async function tool(name: string, args: object = {}): Promise<string> {
  const { result } = await rpc("tools/call", { name, arguments: args });
  const text = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  if (result.isError) throw new Error(`${name}: ${text}`);
  return text;
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
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  server.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  let task = "";
  let batch = "";
  await check("a forming theme's brief invites questions", async () => {
    await tool("task_create", { description: "make it calmer", kind: "revise", service: "fixtures", origin: fixture });
    const brief = await tool("task_claim");
    task = brief.match(/^# Task (\S+):/)![1];
    assert.match(brief, /This theme is \*\*forming\*\*/);
  });

  await check("calls go out with a screenshot, and the task waits for the user", async () => {
    const { tab } = JSON.parse(await tool("tab_open", { url: fixture }));
    const saved = await tool("screenshot", { tab, attach: true });
    const shot = saved.match(/Saved to (\S+)\./)![1];
    assert.ok(shot.includes("/scratch/"), shot);
    const posted = await tool("task_ask", {
      wait: "review",
      summary: "A first pass: darker background, softer text.",
      calls: [
        { question: "How dark should the background be?", options: ["Mocha base", "Mantle", "Crust"], choice: "Mocha base", screenshots: [shot] },
        { question: "Should headings take the accent colour?", scope: "theme", context: "THEME.md doesn't say." },
        { question: "Kept the site's rounded buttons", choice: "kept", wait: "record" },
      ],
      handoff: "Styles done; previews still to take.",
    });
    batch = posted.match(/\((\S+-q\d+)\)/)![1];
    assert.match(posted, /now waits for the user's answers/);
    assert.match(await tool("task_list"), /Waiting for the user's answers[^]*make it calmer/);
    await assert.rejects(tool("task_info"), /don't hold a task/);
    const calls = atelier("calls");
    assert.match(calls, new RegExp(`${batch}\\s+review`));
    assert.match(calls, /\[agent's call: Mocha base\]/);
  });

  await check("the inbox shows the batch (screenshot for a look)", async () => {
    await withSession(state.bidiPort, async (bidi) => {
      const { contexts } = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
      const ext = contexts.find((c: { url: string }) => c.url.startsWith("moz-extension://"));
      const base = ext.url.replace(/\/[^/]*$/, "");
      const { context } = await bidi.send("browsingContext.create", { type: "tab" });
      await bidi.send("browsingContext.navigate", { context, url: `${base}/inbox.html`, wait: "complete" });
    });
    await new Promise((r) => setTimeout(r, 2500));
    dev("screenshot", NAME, `${instance}-inbox.png`);
    console.log(`      (inbox: ${instance}-inbox.png)`);
  });

  await check("answers send the task back to the queue, and the next claim sees them", async () => {
    atelier("answer", batch, JSON.stringify([{}, { note: "No, keep them in the text colour" }]));
    const brief = await tool("task_claim");
    assert.match(brief, /How dark should the background be\? \[your call: Mocha base\] → kept/);
    assert.match(brief, /Should headings take the accent colour\? → the user said: No, keep them in the text colour/);
    assert.match(brief, /Kept the site's rounded buttons \(for the record\) \[your call: kept\] → kept/);
    assert.match(brief, /## Handoff from whoever worked on this before\n\nStyles done; previews still to take\./);
  });

  await check("a review can hold the task while the user answers, and the answer comes straight back", async () => {
    const asked = tool("task_ask", {
      calls: [{ question: "Softer or brighter text?", options: ["softer", "brighter"], choice: "softer", wait: "review" }],
      waitForAnswers: 30,
    });
    // The user answers while the agent waits.
    let id = "";
    for (let i = 0; i < 40 && !id; i++) {
      await new Promise((r) => setTimeout(r, 250));
      id = atelier("calls").match(/^(\S+-q\d+)\s+review/m)?.[1] ?? "";
    }
    assert.ok(id, "the batch was posted");
    assert.match(atelier("task", "list"), /claimed\s+revise/, "still claimed while held");
    atelier("answer", id, JSON.stringify([{ choice: "brighter" }]));
    const out = await asked;
    assert.match(out, /^The user answered\. You still hold task/);
    assert.match(out, /Softer or brighter text\? \[your call: softer\] → the user chose: brighter/);
    assert.match(await tool("task_info"), /^# Task/);
  });

  await check("a theme-level answer becomes a THEME.md proposal, which lands only when accepted", async () => {
    const out = await tool("theme_propose", {
      summary: "Headings stay in the text colour",
      why: "The user's answer on the e2e fixture",
      edits: [{ find: "Calm and dark.", replace: "Calm and dark. Headings stay in the text colour, not the accent." }],
    });
    const id = out.match(/^Proposed \((\S+)\)/)![1];
    assert.match(atelier("proposals"), new RegExp(id));
    assert.doesNotMatch(fs.readFileSync(path.join(owned, "themes/e2e/THEME.md"), "utf8"), /Headings stay/);
    await withSession(state.bidiPort, async (bidi) => {
      const { contexts } = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
      const ext = contexts.find((c: { url: string }) => c.url.startsWith("moz-extension://"));
      const base = ext.url.replace(/\/[^/]*$/, "");
      const { context } = await bidi.send("browsingContext.create", { type: "tab" });
      await bidi.send("browsingContext.navigate", { context, url: `${base}/inbox.html`, wait: "complete" });
    });
    await new Promise((r) => setTimeout(r, 2500));
    dev("screenshot", NAME, `${instance}-proposal.png`);
    console.log(`      (proposal: ${instance}-proposal.png)`);
    // Pending proposals show in briefs, so nobody proposes them twice.
    assert.match(await tool("task_info"), /Waiting for the user: Headings stay in the text colour/);
    atelier("decide", id, "accept");
    assert.match(fs.readFileSync(path.join(owned, "themes/e2e/THEME.md"), "utf8"), /Headings stay in the text colour/);
    assert.match(atelier("journal"), /themes\/e2e\/THEME\.md: Headings stay in the text colour/);
  });

  await check("a declined proposal shows in briefs with the user's reason", async () => {
    const out = await tool("theme_propose", { summary: "No rounded corners anywhere", edits: [{ replace: "\nNo rounded corners.\n" }] });
    const id = out.match(/^Proposed \((\S+)\)/)![1];
    atelier("decide", id, "decline", "Small radii are fine");
    assert.match(await tool("task_info"), /Declined by the user: No rounded corners anywhere \(they said: Small radii are fine\)/);
  });

  await check("assumptions made at landing come back as calls; changing one queues a revise", async () => {
    const tree = (await tool("task_info")).match(/The task's tree is (\S+): /)![1];
    fs.appendFileSync(path.join(tree, STYLE), "/* calmer */\n");
    assert.match(await tool("task_submit", { summary: "Calmer", assumptions: ["Left the footer alone"] }), /^Landed/);
    const recorded = atelier("calls");
    const id = recorded.match(/^(\S+-q\d+)\s+record/m)![1];
    atelier("answer", id, JSON.stringify([{ note: "The footer should match too" }]));
    const list = atelier("task", "list");
    assert.match(list, /queued\s+revise\s+fixtures\s+Revisit a call from an earlier task/);
  });

  await check("a settled theme's brief says the user expects to be satisfied with the agent's calls", async () => {
    assert.match(atelier("stage", "settled"), /"stage": "settled"/);
    assert.match(fs.readFileSync(path.join(owned, "themes/e2e/theme.toml"), "utf8"), /stage = "settled"/);
    const brief = await tool("task_claim");
    assert.match(brief, /marked this theme \*\*settled\*\*/);
    assert.match(brief, /expect to be satisfied with whatever provisional calls you make/);
  });
} finally {
  server.stdin!.end();
  dev("down", ...(failures ? ["--keep"] : []), NAME);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
