// Echoes the search field into #echo on input, and adds #late after a delay,
// for type_text and waitFor in dev/e2e/tools.ts.
document.getElementById("search").addEventListener("input", (e) => {
  document.getElementById("echo").textContent = e.target.value;
});
setTimeout(() => {
  const late = document.createElement("div");
  late.id = "late";
  late.textContent = "Rendered late.";
  document.querySelector("main").append(late);
}, 1500);
