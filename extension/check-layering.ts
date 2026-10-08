// Checks the page runtime's layering (ARCHITECTURE.md, "The page model"):
// only page/core.ts reaches into the page's structure (stylesheets, shadow
// roots, rule lists, document-wide queries), so that everything else gets
// shadow roots and cross-origin sheets right by asking core. Run by
// `npm run check`.

import fs from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "src/page");
const FORBIDDEN: [RegExp, string][] = [
  [/\.styleSheets\b/, "styleSheets (use core.sheets / core.allSheets)"],
  [/\badoptedStyleSheets\b/, "adoptedStyleSheets (use core.sheets)"],
  [/\.shadowRoot\b|\battachShadow\b|openOrClosedShadowRoot/, "shadow roots (use core.scopes / core.shadowRootOf)"],
  [/\.cssRules\b/, "cssRules (use core.rules / core.mediaRules)"],
  [/\bdocument\.querySelector(All)?\b|\bdocument\.getElementsBy/, "document-wide queries (use core.query / core.queryAll / core.find)"],
];

let problems = 0;
for (const file of fs.readdirSync(dir)) {
  if (!file.endsWith(".ts") || file === "core.ts") continue;
  const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments may name things
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(line)) {
        console.error(`src/page/${file}:${i + 1}: reaches for ${what}\n    ${line.trim()}`);
        problems++;
      }
    }
  });
}
if (problems) {
  console.error(`\n${problems} place(s) outside page/core.ts reach into the page's structure; go through core instead.`);
  process.exit(1);
}
