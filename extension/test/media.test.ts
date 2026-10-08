// Media query rewriting for emulated features (src/page/media.ts). Run by
// `npm run check` (node --test).

import assert from "node:assert/strict";
import { test } from "node:test";
import { FALSE, rewriteMedia, rewriteMediaInCss, TRUE } from "../src/page/media.ts";

const phone = { width: 390, height: 844, "prefers-color-scheme": "dark" as const };

test("plain and range syntax, in px, em, rem and calc()", () => {
  const cases: [string, string][] = [
    ["(min-width: 600px)", FALSE],
    ["(max-width: 37.49em)", TRUE],
    ["(width >= 768px)", FALSE],
    ["(400px < width < 1000px)", FALSE],
    ["(300px < width <= 400px)", TRUE],
    // MDN writes its breakpoints like this.
    ["(width < calc(67rem))", TRUE],
    ["(min-width: calc(30em + 10px))", FALSE],
    ["(max-width: calc(25rem - 1px))", TRUE],
    ["(aspect-ratio > 1/1)", FALSE],
    ["(min-aspect-ratio: 16/9)", FALSE],
  ];
  for (const [query, want] of cases) assert.equal(rewriteMedia(query, phone), want, query);
});

test("structure around features is kept: types, not, and groups", () => {
  assert.equal(rewriteMedia("screen and (orientation: portrait)", phone), `screen and ${TRUE}`);
  assert.equal(rewriteMedia("not (min-width: 600px)", phone), `not ${FALSE}`);
  assert.equal(rewriteMedia("((min-width: 600px) or (prefers-color-scheme: dark))", phone), `(${FALSE} or ${TRUE})`);
});

test("features that aren't emulated are left alone", () => {
  for (const query of ["(min-resolution: 2dppx)", "(hover: hover)", "(prefers-reduced-motion: reduce)", "print"]) {
    assert.equal(rewriteMedia(query, phone), query);
  }
  // Only the colour scheme emulated: sizes are left to the real viewport.
  assert.equal(rewriteMedia("(min-width: 600px)", { "prefers-color-scheme": "dark" }), "(min-width: 600px)");
});

test("in CSS text, only @media and @import conditions are rewritten", () => {
  const css = "@media (width<calc(67rem)){a{b:c}} @container (min-width: 400px){x{}} @supports (width: 1px){y{}} @import url(a.css) (min-width: 900px);";
  assert.equal(
    rewriteMediaInCss(css, phone),
    `@media ${TRUE}{a{b:c}} @container (min-width: 400px){x{}} @supports (width: 1px){y{}} @import url(a.css) ${FALSE};`,
  );
});
