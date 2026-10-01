// Builds the extension into dist/. `node build.ts --watch` rebuilds on change.
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
const dist = path.join(root, "dist");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);

const manifest = fs.readFileSync(path.join(root, "src/manifest.json"), "utf8").replace("__GECKO_ID__", flavor.geckoId);
fs.writeFileSync(path.join(dist, "manifest.json"), manifest);

const options: esbuild.BuildOptions = {
  entryPoints: [path.join(root, "src/background.ts")],
  outdir: dist,
  bundle: true,
  format: "esm",
  target: "firefox140",
  sourcemap: "inline",
  define: { ATELIER_NATIVE_HOST: JSON.stringify(flavor.nativeHost) },
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  await (await esbuild.context(options)).watch();
} else {
  await esbuild.build(options);
}
