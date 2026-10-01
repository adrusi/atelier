import { USER_SCRIPTS_PERMISSION } from "./userscripts";

const result = document.getElementById("result")!;

document.getElementById("grant")!.addEventListener("click", async () => {
  const granted = await browser.permissions.request(USER_SCRIPTS_PERMISSION);
  document.body.dataset.granted = String(granted);
  result.textContent = granted
    ? "Done. Your styles will apply from now on; reload pages that are already open."
    : "Not granted. You can allow it later from atelier's toolbar button.";
});
