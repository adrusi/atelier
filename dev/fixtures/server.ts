// Static server for fixture sites (see DEVELOPING.md).
//
// Each subdirectory of dev/fixtures is a fixture, served at /<name>/. A
// fixture may contain a _fixture.json:
//
//   { "headers": { "Content-Security-Policy": "..." },  // added to every response
//     "spa": true,                                      // unknown paths serve index.html
//     "streamDelayMs": 1500 }                           // see below
//
// With streamDelayMs, HTML files containing `<!-- flush -->` are sent in two
// parts: everything before the marker, then a pause, then the rest. That makes
// the browser paint before the document is complete.
//
// Directories starting with "_" (e.g. _shared/) are served but not listed.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = import.meta.dirname;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

type FixtureConfig = { headers?: Record<string, string>; spa?: boolean; streamDelayMs?: number };
const FLUSH = "<!-- flush -->";

function fixtures(): string[] {
  return fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function listed(): string[] {
  return fixtures().filter((f) => !f.startsWith("_"));
}

function config(fixture: string): FixtureConfig {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, fixture, "_fixture.json"), "utf8"));
  } catch {
    return {};
  }
}

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer, headers = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixtures");
  const [, fixture, ...rest] = decodeURIComponent(url.pathname).split("/");

  if (!fixture) {
    const items = listed().map((f) => `<li><a href="/${f}/">${f}</a></li>`).join("\n");
    return send(res, 200, TYPES[".html"], `<!doctype html><title>fixtures</title><ul>\n${items}\n</ul>\n`);
  }
  if (!fixtures().includes(fixture)) return send(res, 404, "text/plain", "no such fixture\n");
  if (rest.length === 0) return send(res, 301, "text/plain", "", { Location: `/${fixture}/` });

  const cfg = config(fixture);
  const dir = path.join(ROOT, fixture);
  let file = path.join(dir, ...rest);
  if (!file.startsWith(dir + path.sep) && file !== dir) return send(res, 403, "text/plain", "forbidden\n");
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) || path.basename(file) === "_fixture.json") {
    if (!cfg.spa) return send(res, 404, "text/plain", "not found\n", cfg.headers);
    file = path.join(dir, "index.html");
  }
  const type = TYPES[path.extname(file)] ?? "application/octet-stream";
  const body = fs.readFileSync(file);
  const text = body.toString("utf8");
  if (cfg.streamDelayMs && type === TYPES[".html"] && text.includes(FLUSH)) {
    const at = text.indexOf(FLUSH);
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", ...cfg.headers });
    res.write(text.slice(0, at));
    setTimeout(() => res.end(text.slice(at)), cfg.streamDelayMs);
    return;
  }
  send(res, 200, type, body, cfg.headers);
});

const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 8000;
server.listen(port, "127.0.0.1", () => console.log(`fixtures on http://127.0.0.1:${port}/`));
