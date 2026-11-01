import type { State } from "./background";
import { missingPermission } from "./userscripts";

const result = document.getElementById("result")!;
const next = document.getElementById("next")!;

/** After the grant: whether the atelier program answers, and what's next. */
async function check() {
  // The background connects on its own; give it a moment after a fresh install.
  let state: State | null = null;
  for (let i = 0; i < 10; i++) {
    state = (await browser.runtime.sendMessage({ type: "state" }).catch(() => null)) as State | null;
    if (state?.connection === "connected") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  next.hidden = false;
  if (state?.connection === "connected") {
    document.querySelector("h1")!.textContent = "atelier is set up";
    document.getElementById("connected")!.hidden = false;
    document.getElementById("dir")!.textContent = state.atelierDir ?? "";
    document.getElementById("theme")!.textContent = state.bundle?.theme ?? "none yet";
  } else {
    document.getElementById("missing")!.hidden = false;
    document.getElementById("error")!.textContent = state?.error ?? "no answer from it";
  }
}

// Back after the restart a grant of site access causes: finish (any
// permission still missing is asked for first).
if (new URLSearchParams(location.search).has("granted")) void nextStep();

const grant = document.getElementById("grant") as HTMLButtonElement;

/** The permission the button asks for, worked out before the click:
 * permissions.request must be called straight from the click handler. */
let current: Awaited<ReturnType<typeof missingPermission>> = null;

/** Shows the next permission to ask for, or finishes when there's none. */
async function nextStep() {
  const missing = await missingPermission();
  current = missing;
  if (missing) {
    grant.textContent = missing.label;
    grant.hidden = false;
    grant.focus();
    return;
  }
  grant.hidden = true;
  document.body.dataset.granted = "true";
  result.textContent = "Allowed. Your styles apply from now on; reload pages that are already open.";
  await check();
}

// One permission per click: Firefox asks for each on its own. Granting site
// access restarts atelier (to use it), which reopens this page to finish.
grant.addEventListener("click", async () => {
  if (!current) return nextStep();
  const granted = await browser.permissions.request(current.permissions);
  if (!granted) {
    result.textContent = "Not allowed. You can allow it later from atelier's toolbar button, or in about:addons → atelier → Permissions.";
    return;
  }
  await nextStep();
});

if (!new URLSearchParams(location.search).has("granted")) void nextStep();
