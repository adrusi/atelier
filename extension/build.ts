// Builds the extension into dist/ (or dist-release/ for the release flavor).
// `node build.ts --watch` rebuilds on change.
//
// The page runtime (src/page/, ARCHITECTURE.md) is built first, as two
// self-contained scripts whose text is inlined into the background: the
// runtime proper (page/index.ts), which the background registers and injects
// into pages' userScripts world, and its small page-world half (page/main.ts).
//
// Two flavors, each with its own extension ID and native host name, so a dev
// build can never be mistaken for the real install (DEVELOPING.md): dev
// (the default, loaded as a temporary add-on), and release (signed through
// AMO by sign.ts, and installed for good). ATELIER_VERSION sets the
// manifest's version; AMO needs a new one for each signing.

import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";

const FLAVORS = {
  dev: { geckoId: "atelier-dev@atelier.invalid", nativeHost: "atelier_dev", dist: "dist" },
  release: { geckoId: "atelier@adrusi.com", nativeHost: "atelier", dist: "dist-release" },
};
const version = process.env.ATELIER_VERSION ?? "0.0.0";

const flavorName = process.env.ATELIER_BUILD ?? "dev";
const flavor = FLAVORS[flavorName as keyof typeof FLAVORS];
if (!flavor) throw new Error(`unknown build flavor ${flavorName}`);

const root = import.meta.dirname;
const src = path.join(root, "src");
const dist = path.join(root, flavor.dist);
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
  const manifest = fs
    .readFileSync(path.join(src, "manifest.json"), "utf8")
    .replace("__GECKO_ID__", flavor.geckoId)
    .replace('"version": "0.0.0"', `"version": ${JSON.stringify(version)}`);
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
    sourcemap: flavorName === "release" ? false : "inline",
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
