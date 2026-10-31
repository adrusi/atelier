import type { State } from "./background";
import { USER_SCRIPTS_PERMISSION } from "./userscripts";

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

document.getElementById("grant")!.addEventListener("click", async () => {
  const granted = await browser.permissions.request(USER_SCRIPTS_PERMISSION);
  document.body.dataset.granted = String(granted);
  result.textContent = granted
    ? "Allowed. Your styles apply from now on; reload pages that are already open."
    : "Not allowed. You can allow it later from atelier's toolbar button.";
  if (granted) await check();
});
