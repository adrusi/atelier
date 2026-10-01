// Simulates hydration that clobbers styles it didn't create. See index.html.
addEventListener("load", () => {
  setTimeout(() => {
    for (const el of document.querySelectorAll("style")) el.remove();
    const head = document.createElement("head");
    for (const el of document.head.querySelectorAll("meta, title, link, script")) head.append(el);
    document.head.replaceWith(head);
    document.adoptedStyleSheets = [];
    document.documentElement.setAttribute("data-hostile-done", "");
  }, 300);
});
