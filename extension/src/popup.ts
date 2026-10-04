import type { SiteInfo, State, Unmet } from "./background";
import { cssFor } from "./matching";
import type { Task } from "./proto/Task";
import { USER_SCRIPTS_PERMISSION } from "./userscripts";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function item(text: string, title?: string) {
  const li = document.createElement("li");
  li.textContent = text;
  if (title) li.title = title;
  return li;
}

// The page the popup is about: the active tab, or ?tab=ID when popup.html is
// opened as a page of its own (for tests, and for looking at it full size).
const forcedTab = new URLSearchParams(location.search).get("tab");
const tabPromise = forcedTab
  ? browser.tabs.get(Number(forcedTab))
  : browser.tabs.query({ active: true, currentWindow: true }).then(([t]) => t);

async function render() {
  const tab = await tabPromise;
  const state = (await browser.runtime.sendMessage({ type: "state", tabId: tab?.id })) as State & { unmet: Unmet[] };
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
  if (state.connection !== "connected") el<HTMLDetailsElement>("details").open = true;

  const page = el("page");
  page.replaceChildren();
  const applying = (state.bundle?.styles ?? []).filter((s) => tab?.url && cssFor(s, tab.url) !== null);
  if (applying.length === 0) page.append(item("No styles apply here."));
  for (const s of applying) page.append(item(s.name, s.id));

  el("unmet-heading").hidden = state.unmet.length === 0;
  el("unmet").replaceChildren(...state.unmet.map((u) => item(u.description, u.style)));

  const problems = state.bundle?.diagnostics ?? [];
  el("problems-heading").hidden = problems.length === 0;
  el("problems").replaceChildren(
    ...problems.map((d) => item(`${d.severity}: ${d.path ? `${d.path}${d.line ? `:${d.line}` : ""}: ` : ""}${d.message}`)),
  );

  // Requests only make sense for web pages, with the daemon there to take them.
  const web = Boolean(tab?.url && /^https?:/.test(tab.url));
  el("ask").hidden = !web || state.connection !== "connected";
  if (!el("ask").hidden) {
    const styled = applying.some((s) => s.service);
    el("ask-heading").textContent = styled ? "Something's off?" : "Style this site";
    el<HTMLTextAreaElement>("request").placeholder = styled
      ? "What would you like changed? e.g. “the sidebar is too busy”"
      : "Anything in particular? (optional)";
    el("send").textContent = styled ? "Ask for a change" : "Style this site";
    await renderSite(tab!.id!);
  }
}

function describe(t: Task, undone: boolean): string {
  if (t.state === "landed" && undone) return "done, then undone";
  switch (t.state) {
    case "queued":
      return t.tree ? "waiting to be picked up again" : "waiting for a session";
    case "claimed":
      return "being worked on";
    case "landed":
      return t.outcome?.kind === "landed" ? `done: ${t.outcome.summary.split("\n")[0]}` : "done";
    case "declined":
      return t.outcome?.kind === "declined" ? `declined: ${t.outcome.reason}` : "declined";
    case "abandoned":
      return "abandoned";
  }
}

async function renderSite(tabId: number) {
  let site: SiteInfo;
  try {
    site = (await browser.runtime.sendMessage({ type: "site", tabId })) as SiteInfo;
  } catch {
    return; // the daemon went away; the status section says so
  }
  el("tasks-heading").hidden = site.tasks.length === 0;
  el("tasks").replaceChildren(
    ...site.tasks.map((t) => {
      const li = document.createElement("li");
      const what = document.createElement("span");
      what.className = "what";
      what.textContent = t.brief.description;
      const state = document.createElement("span");
      state.className = `state ${t.state}`;
      state.textContent = describe(t, site.undone.includes(t.id));
      li.append(what, state);
      return li;
    }),
  );
  el("landing").hidden = site.landing === null;
  if (site.landing) {
    el("landing-summary").textContent = site.landing.summary.split("\n")[0];
    el("landing-summary").title = site.landing.summary;
    el("undo").dataset.seq = String(site.landing.seq);
  }
}

el("grant").addEventListener("click", async () => {
  await browser.permissions.request(USER_SCRIPTS_PERMISSION);
  await render();
});

el("ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const tab = await tabPromise;
  const send = el<HTMLButtonElement>("send");
  send.disabled = true;
  el("sent").textContent = "";
  try {
    await browser.runtime.sendMessage({
      type: "request",
      tabId: tab!.id,
      text: el<HTMLTextAreaElement>("request").value,
      screenshot: el<HTMLInputElement>("attach").checked,
    });
    el<HTMLTextAreaElement>("request").value = "";
    el("sent").textContent = "Queued.";
    await renderSite(tab!.id!);
  } catch (err) {
    el("sent").textContent = err instanceof Error ? err.message : String(err);
  } finally {
    send.disabled = false;
  }
});

el("undo").addEventListener("click", async () => {
  const tab = await tabPromise;
  const undo = el<HTMLButtonElement>("undo");
  undo.disabled = true;
  try {
    await browser.runtime.sendMessage({ type: "undo", seq: Number(undo.dataset.seq) });
    el("undone").textContent = "Undone.";
    await renderSite(tab!.id!);
  } catch (err) {
    el("undone").textContent = err instanceof Error ? err.message : String(err);
  } finally {
    undo.disabled = false;
  }
});

void render();
// Requests change state while the popup is open (a session picks one up).
setInterval(async () => {
  const tab = await tabPromise;
  if (tab?.id !== undefined && !el("ask").hidden) await renderSite(tab.id);
}, 2000);
