// permissions.request needs a user gesture. The button is autofocused, and the
// spike harness presses Enter through the compositor (wtype), which is real input.
document.getElementById("grant").addEventListener("click", async () => {
  const granted = await browser.permissions.request({ permissions: ["userScripts"] });
  document.body.dataset.granted = String(granted);
});
