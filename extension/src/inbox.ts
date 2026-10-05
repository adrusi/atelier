// The inbox (SPEC §9.5): batches of calls from agents, answered a batch at a
// time. Each call shows the agent's question, its screenshots and options,
// with the agent's own choice preselected, so keeping it is one click.

import type { Inbox } from "./background";
import type { Batch } from "./proto/Batch";
import type { Call } from "./proto/Call";
import type { Proposal } from "./proto/Proposal";
import type { Task } from "./proto/Task";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string | null)[]) {
  const e = document.createElement(tag);
  const { class: cls, ...rest } = props;
  Object.assign(e, rest);
  if (cls) e.className = cls;
  e.append(...children.filter((c): c is Node | string => c !== null));
  return e;
}

const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
};

const WAIT_LABEL: Record<string, string> = {
  block: "The agent can't go on without you",
  review: "Waiting for your answers before it lands",
  record: "Calls the agent made; change any you'd like done differently",
};

function shots(batch: Batch, call: Call) {
  if (call.attachments.length === 0) return null;
  const box = h("div", { class: "shots" });
  for (const name of call.attachments) {
    const img = h("img", { alt: `screenshot for: ${call.question}`, title: "Click to enlarge" });
    img.addEventListener("click", () => img.classList.toggle("zoom"));
    box.append(img);
    browser.runtime
      .sendMessage({ type: "attachment", batch: batch.id, name })
      .then((url) => (img.src = url as string))
      .catch(() => (img.alt = `(couldn't load ${name})`));
  }
  return box;
}

/** One call, as a card with inputs (open) or the answer given (answered). */
function callCard(batch: Batch, call: Call, i: number, open: boolean) {
  const li = h(
    "li",
    { class: "call" },
    h("p", { class: "q", textContent: call.question }),
    call.context ? h("p", { class: "context", textContent: call.context }) : null,
    call.scope === "theme" ? h("p", { class: "scope", textContent: "About the theme as a whole, not just this site" }) : null,
    call.wait === "record" && batch.wait !== "record" ? h("p", { class: "scope", textContent: "The agent went ahead with this; change it if you like" }) : null,
    shots(batch, call),
  );
  if (!open) {
    const a = call.answer;
    const said = !a ? "" : a.kept ? `Kept: ${call.choice ?? "fine"}` : [a.choice && a.choice !== call.choice ? `Chose: ${a.choice}` : "", a.note ? `Said: ${a.note}` : ""].filter(Boolean).join(" · ");
    li.append(h("p", { class: "answer", textContent: said }));
    return li;
  }
  const name = `${batch.id}-${i}`;
  if (call.options.length > 0) {
    const set = h("fieldset", { class: "options" });
    for (const option of call.options) {
      const input = h("input", { type: "radio", name, value: option, checked: option === call.choice });
      set.append(h("label", {}, input, ` ${option}`, option === call.choice ? h("span", { class: "mine", textContent: " (agent's choice)" }) : null));
    }
    li.append(set);
  } else if (call.choice) {
    li.append(h("p", { class: "choice" }, "Agent's call: ", h("strong", { textContent: call.choice })));
  }
  li.append(
    h("textarea", {
      rows: 2,
      name: `${name}-note`,
      placeholder: call.choice || (call.wait ?? batch.wait) === "record" ? "Anything to change or add? Leave empty to keep the agent's call." : "Your answer",
    }),
  );
  return li;
}

function batchCard(b: Batch, task: Task | undefined, open: boolean) {
  const site = hostOf(b.origin) || b.service || "";
  const card = h(
    "section",
    { class: `batch ${b.wait}` },
    h("header", {}, h("span", { class: "site", textContent: site }), task ? h("span", { class: "what", textContent: task.brief.description }) : null),
    open ? h("p", { class: "wait", textContent: WAIT_LABEL[b.wait] }) : null,
    b.summary ? h("p", { class: "summary", textContent: b.summary }) : null,
  );
  // The work in progress, in a tab of the user's own showing the task's tree.
  if (open && task?.tree && b.origin && (task.state === "waiting" || task.state === "claimed" || task.state === "queued")) {
    const look = h("button", { type: "button", class: "link", textContent: "Look at the work in progress" });
    look.addEventListener("click", () => void browser.runtime.sendMessage({ type: "preview", task: task.id, url: b.origin }));
    card.append(look);
  }
  const list = h("ol", { class: "calls" });
  b.calls.forEach((c, i) => list.append(callCard(b, c, i, open)));
  card.append(list);
  if (open) {
    const status = h("span", { class: "sent", role: "status" } as Partial<HTMLSpanElement>);
    const send = h("button", { type: "button", textContent: b.wait === "record" ? "Done" : "Send answers" });
    send.addEventListener("click", async () => {
      const answers = b.calls.map((c, i) => {
        const picked = card.querySelector<HTMLInputElement>(`input[name="${b.id}-${i}"]:checked`)?.value;
        const note = card.querySelector<HTMLTextAreaElement>(`textarea[name="${b.id}-${i}-note"]`)?.value.trim();
        return { choice: picked && picked !== c.choice ? picked : null, note: note || null };
      });
      const unanswered = b.calls.findIndex((c, i) => (c.wait ?? b.wait) !== "record" && !c.choice && !answers[i].choice && !answers[i].note);
      if (unanswered >= 0) {
        status.textContent = `Question ${unanswered + 1} needs an answer.`;
        return;
      }
      send.disabled = true;
      try {
        await browser.runtime.sendMessage({ type: "answer", batch: b.id, answers });
        status.textContent = "Sent. The task goes back to the queue with your answers.";
        if (b.wait === "record") status.textContent = "Done. Anything you changed is queued as a new request.";
        setTimeout(() => void render(true), 1500);
      } catch (e) {
        status.textContent = e instanceof Error ? e.message : String(e);
        send.disabled = false;
      }
    });
    card.append(h("footer", {}, send, status));
  }
  return card;
}

/** A line diff (longest common subsequence): small files, so simple is fine. */
function diffLines(a: string[], b: string[]): { op: " " | "-" | "+"; line: string }[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: { op: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) out.push({ op: " ", line: a[i++] }), j++;
    // Removals before additions, as diffs usually read.
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ op: "-", line: a[i++] });
    else out.push({ op: "+", line: b[j++] });
  }
  return out;
}

/** The diff with unchanged stretches folded to a couple of lines of context. */
function diffView(before: string, after: string) {
  const lines = diffLines(before.split("\n"), after.split("\n"));
  const near = (k: number) => lines.slice(Math.max(0, k - 2), k + 3).some((l) => l.op !== " ");
  const pre = h("pre", { class: "diff" });
  let skipped = false;
  lines.forEach((l, k) => {
    if (l.op === " " && !near(k)) {
      if (!skipped) pre.append(h("span", { class: "skip", textContent: "⋯" }));
      skipped = true;
      return;
    }
    skipped = false;
    pre.append(h("span", { class: l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx", textContent: `${l.op} ${l.line}` }));
  });
  return pre;
}

function proposalCard(p: Proposal) {
  const open = p.state === "open";
  const card = h(
    "section",
    { class: "batch proposal" },
    h("header", {}, h("span", { class: "site", textContent: p.path }), h("span", { class: "what", textContent: p.summary })),
    open
      ? h("p", { class: "wait", textContent: "A proposed change to your theme. Nothing changes unless you accept it." })
      : h("p", { class: "wait", textContent: { accepted: "Accepted", declined: "Declined", stale: "Out of date: the file changed after this was proposed", open: "" }[p.state] + (p.note ? `: ${p.note}` : "") }),
    p.why ? h("p", { class: "summary", textContent: p.why }) : null,
    diffView(p.before, p.after),
  );
  if (!open) return card;
  const edit = h("textarea", { rows: 12, hidden: true, value: p.after, class: "edit" } as Partial<HTMLTextAreaElement>);
  const note = h("textarea", { rows: 2, placeholder: "A note (optional; if you decline, say why, so it isn't proposed again)" });
  const status = h("span", { class: "sent", role: "status" } as Partial<HTMLSpanElement>);
  const editButton = h("button", { type: "button", class: "link", textContent: "Edit before accepting" });
  editButton.addEventListener("click", () => {
    edit.hidden = !edit.hidden;
  });
  const decide = (accept: boolean) => async () => {
    try {
      await browser.runtime.sendMessage({
        type: "decide",
        id: p.id,
        accept,
        note: note.value.trim() || undefined,
        text: accept && !edit.hidden && edit.value !== p.after ? edit.value : undefined,
      });
      status.textContent = accept ? "Accepted: your theme is updated (undo with atelier undo)." : "Declined.";
      setTimeout(() => void render(true), 1500);
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  };
  const accept = h("button", { type: "button", textContent: "Accept" });
  accept.addEventListener("click", decide(true));
  const decline = h("button", { type: "button", textContent: "Decline" });
  decline.addEventListener("click", decide(false));
  card.append(editButton, edit, note, h("footer", {}, accept, decline, status));
  return card;
}

let shown = "";

async function render(force = false) {
  let inbox: Inbox;
  try {
    inbox = (await browser.runtime.sendMessage({ type: "inbox" })) as Inbox;
    el("status").textContent = "";
  } catch (e) {
    el("status").textContent = e instanceof Error ? e.message : String(e);
    return;
  }
  // Re-render only when the batches change, so answers being typed survive.
  const key = JSON.stringify([inbox.batches.map((b) => [b.id, b.state]), inbox.proposals.map((p) => [p.id, p.state]), inbox.stage]);
  if (key === shown && !force) return;
  shown = key;

  const open = inbox.batches.filter((b) => b.state === "open");
  // Blocking first, then review, then calls for the record.
  const rank = { block: 0, review: 1, record: 2 } as const;
  open.sort((a, b) => rank[a.wait] - rank[b.wait]);
  const openProposals = inbox.proposals.filter((p) => p.state === "open");
  el("open").replaceChildren(...openProposals.map(proposalCard), ...open.map((b) => batchCard(b, inbox.tasks[b.task], true)));
  el("empty").hidden = open.length + openProposals.length > 0;
  const answered = inbox.batches.filter((b) => b.state === "answered");
  const decided = inbox.proposals.filter((p) => p.state !== "open");
  el("answered-heading").hidden = answered.length + decided.length === 0;
  el("answered").replaceChildren(...decided.map(proposalCard), ...answered.map((b) => batchCard(b, inbox.tasks[b.task], false)));

  el("theme").hidden = !inbox.theme;
  if (inbox.theme) {
    const settled = inbox.stage === "settled";
    el("theme-text").textContent = settled
      ? `The ${inbox.theme} theme is settled: agents make their own calls and ask only when they think you'd be unhappy with any of them.`
      : `The ${inbox.theme} theme is forming: agents ask readily, since your answers sharpen the theme.`;
    el("stage").textContent = settled ? "It's changing again: mark it forming" : "Styles meet your bar without back-and-forth? Mark it settled";
    el("stage").onclick = async () => {
      await browser.runtime.sendMessage({ type: "stage", stage: settled ? "forming" : "settled" });
      await render(true);
    };
  }
}

void render();
setInterval(() => void render(), 3000);
