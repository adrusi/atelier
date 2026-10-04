// End-to-end test for sources (SPEC §6.2): agent tabs bound to a task's tree
// show its work in progress, and no other tab does.
//
// Build first (`cargo build`, `(cd extension && npm run build)`), then from a
// `nix develop` shell:  node dev/e2e/sources.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const NAME = "e2e-sources";
const instance = path.join(process.env.XDG_RUNTIME_DIR!, "atelier-dev", NAME);
const owned = `${instance}-owned`;
const dev = (...args: string[]) => execFileSync("atelier-dev", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const atelier = (...args: string[]) => dev("atelier", NAME, ...args);
const browser = (method: string, params: object = {}) => JSON.parse(atelier("browser", method, JSON.stringify(params)));

/** A style that sets `--e2e` on <html> for pages under `prefix`. */
const style = (value: string, prefix: string) =>
  `/* ==UserStyle==\n@name e2e\n==/UserStyle== */\n@-moz-document url-prefix("${prefix}") {\n  html { --e2e: ${value}; }\n}\n`;
const STYLE = "services/fixtures/e2e/e2e.user.css";
const NEW_SITE = "services/other/e2e/e2e.user.css";

fs.rmSync(owned, { recursive: true, force: true });
fs.mkdirSync(path.dirname(path.join(owned, STYLE)), { recursive: true });
fs.writeFileSync(path.join(owned, "atelier.toml"), 'theme = "e2e"\n');
fs.writeFileSync(path.join(owned, STYLE), style("default", "http://127.0.0.1:"));

dev("up", "--name", NAME, "--atelier-dir", owned, "--grant-user-scripts");
const state = JSON.parse(fs.readFileSync(path.join(instance, "state.json"), "utf8"));
const fixture = `http://127.0.0.1:${state.fixturesPort}/plain/`;
// Another origin: no style in the owned directory matches it, so no
// registered script runs there, and a tab's sessionStorage marker doesn't
// carry over to it.
const otherSite = `http://localhost:${state.fixturesPort}/plain/`;

const e2e = (tab: number) =>
  browser("page/eval", { tab, expression: "getComputedStyle(document.documentElement).getPropertyValue('--e2e').trim()" }).result;
/** Waits for a tab's value, since saves reach pages asynchronously. */
async function expectValue(tab: number, want: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let got = e2e(tab);
  while (got !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    got = e2e(tab);
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
  const { tab: plain } = browser("tab/open", { url: fixture });
  const task = JSON.parse(atelier("task", "create", "e2e: try a new value")).id as string;

  await check("a task that hasn't been claimed has no tree to show", async () => {
    assert.throws(() => browser("tab/open", { url: fixture, task }), /hasn't been claimed/);
  });

  const claimed = JSON.parse(atelier("task", "claim", task));
  const tree = claimed.tree as string;
  fs.writeFileSync(path.join(tree, STYLE), style("tree-1", "http://127.0.0.1:"));
  fs.mkdirSync(path.dirname(path.join(tree, NEW_SITE)), { recursive: true });
  fs.writeFileSync(path.join(tree, NEW_SITE), style("new-site", "http://localhost:"));
  const { tab: bound } = browser("tab/open", { url: fixture, task });

  await check("a tab opened for a task shows its tree; other tabs don't", async () => {
    await expectValue(bound, "tree-1");
    await expectValue(plain, "default");
    const { tabs } = browser("tab/list");
    assert.deepEqual(tabs.map((t: any) => [t.tab, t.task ?? null]), [[plain, null], [bound, task]]);
  });

  await check("a save in the tree reaches the bound tab only", async () => {
    fs.writeFileSync(path.join(tree, STYLE), style("tree-2", "http://127.0.0.1:"));
    await expectValue(bound, "tree-2");
    assert.equal(e2e(plain), "default");
  });

  await check("a reload of the bound tab keeps the tree's styles", async () => {
    browser("tab/reload", { tab: bound });
    await expectValue(bound, "tree-2");
  });

  await check("styles_status for a bound tab describes the tree", async () => {
    const s = browser("styles/status", { tab: bound });
    assert.equal(s.tab.task, task);
    assert.deepEqual(s.tab.applying, [STYLE]);
    assert.ok(s.byService.other, "the tree's new service is counted");
  });

  await check("a site only the tree has a style for, on another origin, gets it", async () => {
    browser("tab/navigate", { tab: bound, url: otherSite });
    await expectValue(bound, "new-site");
    browser("tab/navigate", { tab: plain, url: otherSite });
    await expectValue(plain, "");
  });

  await check("tab/bind moves an open tab onto the tree and back", async () => {
    browser("tab/navigate", { tab: plain, url: fixture });
    browser("tab/bind", { tab: plain, task });
    await expectValue(plain, "tree-2");
    browser("tab/bind", { tab: plain, task: null });
    await expectValue(plain, "default");
  });

  await check("once the task lands, its tabs show the owned directory, which has the change", async () => {
    browser("tab/navigate", { tab: bound, url: fixture });
    await expectValue(bound, "tree-2");
    // A task changes one service; the other site was only a try.
    fs.rmSync(path.join(tree, "services/other"), { recursive: true });
    const r = JSON.parse(atelier("task", "submit", task, "e2e: tree-2"));
    assert.equal(r.result, "landed", JSON.stringify(r.problems));
    await expectValue(plain, "tree-2");
    await expectValue(bound, "tree-2");
    const { tabs } = browser("tab/list");
    assert.ok(tabs.every((t: any) => t.task === undefined), "no tab is bound any more");
    browser("tab/reload", { tab: bound });
    await expectValue(bound, "tree-2");
  });

  await check("a finished task's tree can't be shown", async () => {
    assert.throws(() => browser("tab/open", { url: fixture, task }), /has finished/);
  });
} finally {
  dev("down", ...(failures ? ["--keep"] : []), NAME);
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
