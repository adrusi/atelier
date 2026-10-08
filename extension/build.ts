// Builds the extension into dist/. `node build.ts --watch` rebuilds on change.
//
// The page runtime (src/page/, ARCHITECTURE.md) is built first, as two
// self-contained scripts whose text is inlined into the background: the
// runtime proper (page/index.ts), which the background registers and injects
// into pages' userScripts world, and its small page-world half (page/main.ts).
//
// Only the dev flavor exists so far. Dev builds use their own extension ID and
// native host name so they can never be mistaken for a real install
// (DEVELOPING.md); release IDs get decided when we first sign a build.

import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const FLAVORS = {
  dev: { geckoId: "atelier-dev@atelier.invalid", nativeHost: "atelier_dev" },
};

const flavorName = process.env.ATELIER_BUILD ?? "dev";
const flavor = FLAVORS[flavorName as keyof typeof FLAVORS];
if (!flavor) throw new Error(`unknown build flavor ${flavorName}`);

const root = import.meta.dirname;
const src = path.join(root, "src");
const dist = path.join(root, "dist");
const STATIC = ["onboarding.html", "popup.html", "inbox.html", "ui.css"];

async function buildPage(entry: string): Promise<string> {
  const r = await esbuild.build({
    entryPoints: [path.join(src, "page", entry)],
    bundle: true,
    format: "iife",
    target: "firefox140",
    // Parsed on every page it's registered for, so kept small.
    minify: true,
    write: false,
  });
  return r.outputFiles[0].text;
}

function copyStatic() {
  const manifest = fs.readFileSync(path.join(src, "manifest.json"), "utf8").replace("__GECKO_ID__", flavor.geckoId);
  fs.writeFileSync(path.join(dist, "manifest.json"), manifest);
  for (const f of STATIC) fs.copyFileSync(path.join(src, f), path.join(dist, f));
}

async function options(): Promise<esbuild.BuildOptions> {
  return {
    entryPoints: ["background.ts", "popup.ts", "onboarding.ts", "inbox.ts"].map((f) => path.join(src, f)),
    outdir: dist,
    bundle: true,
    format: "esm",
    target: "firefox140",
    sourcemap: "inline",
    define: {
      ATELIER_NATIVE_HOST: JSON.stringify(flavor.nativeHost),
      ATELIER_PAGE: JSON.stringify(await buildPage("index.ts")),
      ATELIER_PAGE_MAIN: JSON.stringify(await buildPage("main.ts")),
    },
    logLevel: "info",
  };
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
copyStatic();

if (process.argv.includes("--watch")) {
  // Rebuild everything (shim included) whenever anything in src/ changes.
  let ctx = await esbuild.context(await options());
  await ctx.watch();
  fs.watch(src, { recursive: true }, async () => {
    copyStatic();
    await ctx.dispose();
    ctx = await esbuild.context(await options());
    await ctx.watch();
  });
} else {
  await esbuild.build(await options());
}
