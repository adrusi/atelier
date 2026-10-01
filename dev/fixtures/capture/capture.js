// Drives the boxes described in index.html and records what happened in
// window.__capture, for comparison with what screenshots show.
//
// ?start=MS delays the start of the multi-frame and CSS-animation boxes, so a
// test can hide the tab first and see whether they progress while hidden.
const state = (window.__capture = { timer: false, raf: 0, raf30: false, anim: false, lazy: false, late: false });
const paint = (id, rgb) => (document.getElementById(id).style.background = `rgb(${rgb})`);
const start = Number(new URLSearchParams(location.search).get("start") ?? 0);

setTimeout(() => {
  paint("timer", "0,200,0");
  state.timer = true;
}, 300);

requestAnimationFrame(function frame() {
  if (state.raf++ === 0) paint("raf", "0,0,200");
  if (state.raf < 1000) requestAnimationFrame(frame);
});

setTimeout(() => {
  let frames = 0;
  requestAnimationFrame(function frame() {
    if (++frames === 30) {
      paint("raf30", "200,100,0");
      state.raf30 = true;
    } else requestAnimationFrame(frame);
  });
  const anim = document.getElementById("anim");
  anim.addEventListener("animationend", () => (state.anim = true));
  anim.classList.add("animate");
}, start);

document.getElementById("lazy").addEventListener("load", () => (state.lazy = true));

fetch("capture.css").then(() => {
  paint("late", "0,200,200");
  state.late = true;
});
