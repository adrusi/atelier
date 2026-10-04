// The inbox (SPEC §9.5): batches of calls from agents, answered a batch at a
// time. Each call shows the agent's question, its screenshots and options,
// with the agent's own choice preselected, so keeping it is one click.

import type { Inbox } from "./background";
import type { Batch } from "./proto/Batch";
import type { Call } from "./proto/Call";
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
      placeholder: call.choice || batch.wait === "record" ? "Anything to change or add? Leave empty to keep the agent's call." : "Your answer",
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
      const unanswered = b.calls.findIndex((c, i) => b.wait !== "record" && !c.choice && !answers[i].choice && !answers[i].note);
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
  const key = JSON.stringify([inbox.batches.map((b) => [b.id, b.state]), inbox.stage]);
  if (key === shown && !force) return;
  shown = key;

  const open = inbox.batches.filter((b) => b.state === "open");
  // Blocking first, then review, then calls for the record.
  const rank = { block: 0, review: 1, record: 2 } as const;
  open.sort((a, b) => rank[a.wait] - rank[b.wait]);
  el("open").replaceChildren(...open.map((b) => batchCard(b, inbox.tasks[b.task], true)));
  el("empty").hidden = open.length > 0;
  const answered = inbox.batches.filter((b) => b.state === "answered");
  el("answered-heading").hidden = answered.length === 0;
  el("answered").replaceChildren(...answered.map((b) => batchCard(b, inbox.tasks[b.task], false)));

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
