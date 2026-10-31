// Signs the release flavor through AMO, as an unlisted add-on (signed so
// release Firefox installs it for good, but not listed publicly), and saves
// it as release/atelier.xpi at the top of the repo, which the home-manager
// module installs. Run from a `nix develop` shell:
//
//   WEB_EXT_API_KEY=<JWT issuer> WEB_EXT_API_SECRET=<JWT secret> npm run sign
//
// The key and secret are from addons.mozilla.org: Developer Hub → Tools →
// Manage API Keys. Each signing needs a new version; it's the date and time,
// so it always goes up.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  console.error("Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET (from AMO: Developer Hub → Tools → Manage API Keys).");
  process.exit(2);
}
const root = import.meta.dirname;
const now = new Date();
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
// 0.1.YYYYMMDD.HHMM (UTC): increasing, and within Firefox's version format.
const version = `0.1.${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}.${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
console.log(`building the release flavor, version ${version}`);
execFileSync("node", ["build.ts"], { cwd: root, stdio: "inherit", env: { ...process.env, ATELIER_BUILD: "release", ATELIER_VERSION: version } });

const artifacts = path.join(root, "signed");
fs.rmSync(artifacts, { recursive: true, force: true });
execFileSync(
  "web-ext",
  ["sign", "--channel", "unlisted", "--source-dir", path.join(root, "dist-release"), "--artifacts-dir", artifacts],
  { stdio: "inherit" },
);
const signed = fs.readdirSync(artifacts).find((f) => f.endsWith(".xpi"));
if (!signed) throw new Error(`web-ext didn't leave a signed .xpi in ${artifacts}`);
const out = path.join(root, "..", "release", "atelier.xpi");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(path.join(artifacts, signed), out);
fs.writeFileSync(path.join(path.dirname(out), "VERSION"), `${version}\n`);
console.log(`\nsigned: ${path.relative(path.join(root, ".."), out)} (${version}). Commit it, then home-manager switch (or open it in Firefox to install by hand).`);
