// Scripts that read the viewport: a class from matchMedia and one from
// innerWidth, at startup; and a web component with its own media query.
const root = document.documentElement;
if (matchMedia("(max-width: 599px)").matches) root.classList.add("js-narrow");
if (innerWidth >= 1000) root.classList.add("js-wide");
const sheet = new CSSStyleSheet();
sheet.replaceSync(".js-narrow #script { color: rgb(0, 120, 120); } .js-wide #script { font-size: 20px; }");
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

customElements.define("x-sized", class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML =
      "<style>p { padding: 8px; background: rgb(230, 230, 230); } @media (max-width: 599px) { p { background: rgb(255, 220, 120); } } .vw { width: 30vw; }</style><p class='vw'>in a shadow root</p>";
  }
});
