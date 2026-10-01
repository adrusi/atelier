import type { State } from "./background";
import { cssFor } from "./matching";
import { USER_SCRIPTS_PERMISSION } from "./userscripts";

const el = (id: string) => document.getElementById(id)!;

function item(text: string, title?: string) {
  const li = document.createElement("li");
  li.textContent = text;
  if (title) li.title = title;
  return li;
}

async function render() {
  const state = (await browser.runtime.sendMessage({ type: "state" })) as State;
  const status = el("status");
  status.replaceChildren();
  const row = (k: string, v: string) => {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    status.append(dt, dd);
  };
  row("daemon", state.connection + (state.error ? ` (${state.error})` : ""));
  if (state.atelierDir) row("directory", state.atelierDir);
  row("theme", state.bundle?.theme ?? "none");
  row("styles", String(state.bundle?.styles.length ?? 0));
  el("grant").hidden = !state.needsPermission;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const page = el("page");
  page.replaceChildren();
  const applying = (state.bundle?.styles ?? []).filter((s) => tab?.url && cssFor(s, tab.url) !== null);
  if (applying.length === 0) page.append(item("No styles apply here."));
  for (const s of applying) page.append(item(s.name, s.id));

  const problems = state.bundle?.diagnostics ?? [];
  el("problems-heading").hidden = problems.length === 0;
  el("problems").replaceChildren(
    ...problems.map((d) => item(`${d.severity}: ${d.path ? `${d.path}${d.line ? `:${d.line}` : ""}: ` : ""}${d.message}`)),
  );
}

el("grant").addEventListener("click", async () => {
  await browser.permissions.request(USER_SCRIPTS_PERMISSION);
  await render();
});

void render();
