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

/** Whether this page can take a request (a web page, with the daemon there). */
let askable = false;

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

  // Problems loading styles: one line, details on demand; this site's first.
  const services = new Set(applying.map((s) => s.service).filter(Boolean));
  const mine = (path: string | null) => [...services].some((s) => path?.startsWith(`services/${s}/`));
  const problems = [...(state.bundle?.diagnostics ?? [])].sort((a, b) => Number(mine(b.path)) - Number(mine(a.path)));
  const here = problems.filter((d) => mine(d.path)).length;
  const errors = problems.filter((d) => d.severity === "error").length;
  el("problems-box").hidden = problems.length === 0;
  el("problems-summary").textContent =
    `${problems.length} ${errors ? "problem" : "warning"}${problems.length === 1 ? "" : "s"} loading your styles` + (here ? ` (${here} for this site)` : "");
  el("problems").replaceChildren(
    ...problems.map((d) => item(`${d.severity}: ${d.path ? `${d.path}${d.line ? `:${d.line}` : ""}: ` : ""}${d.message}`)),
  );

  // Requests only make sense for web pages, with the daemon there to take them.
  const web = Boolean(tab?.url && /^https?:/.test(tab.url));
  askable = web && state.connection === "connected";
  el("ask").hidden = !askable;
  if (askable) {
    const styled = applying.some((s) => s.service);
    el("ask-heading").textContent = styled ? "Something's off?" : "Style this site";
    el<HTMLTextAreaElement>("request").placeholder = styled
      ? "What would you like changed? e.g. “the sidebar is too busy”"
      : "Anything in particular? (optional)";
    el("send").textContent = styled ? "Ask for a change" : "Style this site";
    await renderSite(tab!.id!);
  }
  void renderInbox(state);
}

/** Agents' questions waiting on the user, from any site. Fetched after the
 * rest of the popup has rendered, so it never holds that up. */
async function renderInbox(state: State) {
  if (state.connection === "connected") {
    const inbox = (await browser.runtime.sendMessage({ type: "inbox" }).catch(() => null)) as {
      batches: { wait: string; state: string }[];
      proposals: { state: string; path: string; reviewed?: boolean }[];
    } | null;
    // Waiting on the user: questions, THEME.md proposals; to look over: calls
    // made for the record, and design notes added without waiting.
    const waiting =
      (inbox?.batches.filter((b) => b.state === "open" && b.wait !== "record").length ?? 0) +
      (inbox?.proposals.filter((p) => p.state === "open").length ?? 0);
    const look =
      (inbox?.batches.filter((b) => b.state === "open" && b.wait === "record").length ?? 0) +
      (inbox?.proposals.filter((p) => p.path.endsWith("/notes.md") && p.state === "accepted" && !p.reviewed).length ?? 0);
    el("inbox").hidden = waiting + look === 0;
    const parts = [
      waiting ? `${waiting} waiting for you` : "",
      look ? `${look} to look over` : "",
    ].filter(Boolean);
    el("inbox").textContent = `Inbox: ${parts.join(", ")}`;
  }

}

function describe(t: Task, undone: boolean): string {
  if (t.state === "landed" && undone) return "done, then undone";
  switch (t.state) {
    case "queued":
      return t.tree ? "queued, to be picked up again" : "queued";
    case "claimed":
      return "being worked on";
    case "waiting":
      return "waiting for your answers (in the inbox)";
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
  // A request to style this site that's still to be done: don't offer another.
  const pending = (t: Task) => t.state === "queued" || t.state === "claimed" || t.state === "waiting";
  const styling = site.tasks.find((t) => t.kind === "create" && pending(t));
  el("ask").hidden = !askable || styling !== undefined;
  renderNext(site);
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

/** What happens next to a queued request: an agent is on it, is starting,
 * or none is running, with how to start one. */
function renderNext(site: SiteInfo) {
  const queued = site.tasks.some((t) => t.state === "queued");
  const s = site.session;
  el("next").hidden = !queued || s === null;
  if (!queued || s === null) return;
  let text: string;
  let how = false;
  const here = site.tasks.some((t) => t.state === "claimed");
  if (here) text = "An agent is working on this site now, and will pick up the rest after.";
  else if (s.working) text = "An agent is working on another request, and will pick this up after.";
  else if (s.waiting) text = "An agent is waiting for work, and will pick this up shortly.";
  else if (s.starting) text = "An agent is starting, and will pick this up.";
  else {
    text = s.start === "pull" ? "No agent is running, so nothing happens until you start one." : "No agent is running, and atelier couldn't start one.";
    how = !s.command;
  }
  if (s.problem) text += ` (atelier's [session] settings have a problem: ${s.problem})`;
  el("next-text").textContent = text;
  el("next-how").hidden = !how;
  el("start").hidden = !(s.command && !s.working && !s.waiting && !s.starting);
}

el("start").addEventListener("click", async () => {
  const tab = await tabPromise;
  const start = el<HTMLButtonElement>("start");
  start.disabled = true;
  try {
    const r = (await browser.runtime.sendMessage({ type: "start-session" })) as { started: boolean; reason?: string };
    el("started").textContent = r.started ? "Starting…" : `Not started: ${r.reason ?? "unknown reason"}`;
    await renderSite(tab!.id!);
  } catch (err) {
    el("started").textContent = err instanceof Error ? err.message : String(err);
  } finally {
    start.disabled = false;
  }
});

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

el("inbox").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "open-inbox" });
  window.close();
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
  if (tab?.id !== undefined && askable) await renderSite(tab.id);
}, 2000);
