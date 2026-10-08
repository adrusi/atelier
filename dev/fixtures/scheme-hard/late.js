// Mechanisms that only exist once scripts run: a class from matchMedia at
// startup, an adopted sheet, a web component, and styles added after load.
if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.classList.add("js-dark");
const adopted = new CSSStyleSheet();
adopted.replaceSync("@media (prefers-color-scheme: dark) { #adopted { color: rgb(255, 0, 255); } } .js-dark #script { color: rgb(255, 150, 0); }");
document.adoptedStyleSheets = [...document.adoptedStyleSheets, adopted];

customElements.define("x-scheme", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML =
      "<style>:host { display: block; color-scheme: light dark; } p { color: light-dark(rgb(5, 5, 5), rgb(100, 255, 100)); background: Canvas; } @media (prefers-color-scheme: dark) { p { border: 2px solid rgb(255, 255, 0); } }</style><p id='shadowed'>in a shadow root</p>";
  }
});

addEventListener("load", () => {
  setTimeout(() => {
    const style = document.createElement("style");
    style.textContent = "@media (prefers-color-scheme: dark) { #late-style { color: rgb(0, 255, 0); } }";
    document.head.append(style);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "late.css";
    link.media = "(prefers-color-scheme: dark)";
    document.head.append(link);
  }, 200);
});
