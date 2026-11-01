// Fetches the signed file of a version already submitted to AMO, for when
// `npm run sign` uploaded it but stopped waiting before AMO's review was
// done (AMO doesn't take the same version twice, so signing again won't
// do). Saves it as release/atelier.xpi, as sign.ts would. From a
// `nix develop` shell:
//
//   WEB_EXT_API_KEY=<JWT issuer> WEB_EXT_API_SECRET=<JWT secret> npm run fetch-signed [VERSION]
//
// Without VERSION, the newest version on AMO. The key and secret are the
// same as for signing.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ID = "atelier@adrusi.com";
const API = "https://addons.mozilla.org/api/v5";
const key = process.env.WEB_EXT_API_KEY;
const secret = process.env.WEB_EXT_API_SECRET;
if (!key || !secret) {
  console.error("Set WEB_EXT_API_KEY and WEB_EXT_API_SECRET (from AMO: Developer Hub → Tools → Manage API Keys).");
  process.exit(2);
}

/** AMO's API authentication: a short-lived JWT signed with the secret. */
function token(): string {
  const b64 = (v: object | Buffer) => (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: key, jti: crypto.randomUUID(), iat: now, exp: now + 60 })}`;
  return `${body}.${b64(crypto.createHmac("sha256", secret!).update(body).digest())}`;
}

async function get(url: string): Promise<Response> {
  const r = await fetch(url, { headers: { Authorization: `JWT ${token()}` } });
  if (!r.ok) throw new Error(`${url}: ${r.status} ${await r.text()}`);
  return r;
}

const wanted = process.argv[2];
const list = (await (await get(`${API}/addons/addon/${encodeURIComponent(ID)}/versions/?filter=all_with_unlisted&page_size=50`)).json()) as {
  results: { version: string; file: { url: string; status: string } | null }[];
};
const version = wanted ? list.results.find((v) => v.version === wanted) : list.results[0];
if (!version) {
  console.error(`No version ${wanted ?? ""} on AMO. Versions there: ${list.results.map((v) => v.version).join(", ") || "none"}`);
  process.exit(1);
}
if (!version.file || version.file.status !== "public") {
  console.error(`Version ${version.version} isn't signed yet (status: ${version.file?.status ?? "no file"}). AMO's review is still going; try again in a few minutes.`);
  process.exit(1);
}
const xpi = Buffer.from(await (await get(version.file.url)).arrayBuffer());
const out = path.join(import.meta.dirname, "..", "release", "atelier.xpi");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, xpi);
fs.writeFileSync(path.join(path.dirname(out), "VERSION"), `${version.version}\n`);
console.log(`saved release/atelier.xpi (${version.version}, ${xpi.length} bytes). Commit it, then update the flake input and switch.`);
