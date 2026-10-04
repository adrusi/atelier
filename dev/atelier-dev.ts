// atelier-dev: isolated Firefox instances for developing atelier.
//
// Each instance is a bubblewrap jail running its own sway (headless by default)
// with a fresh Firefox profile, driven over WebDriver BiDi. Nothing inside an
// instance can see the developer's home directory, browser profile, session
// bus or desktop. See DEVELOPING.md.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { Bidi, fromRemoteValue, reachable as bidiReachable, withSession } from "./bidi.ts";

const REPO = path.resolve(import.meta.dirname, "..");
// Must match the dev flavor in extension/build.ts.
const DEV_EXTENSION_ID = "atelier-dev@atelier.invalid";
const DEV_NATIVE_HOST = "atelier_dev";
const ROOT = process.env.ATELIER_DEV_ROOT ?? path.join(requireEnv("XDG_RUNTIME_DIR"), "atelier-dev");

const USAGE = `\
usage: atelier-dev <command> [args]

  up [--name NAME] [--visible] [--extension PATH]... [--native-host BIN]
     [--pref NAME=VALUE]... [--system-access] [--atelier-dir DIR] [--grant-user-scripts]
     [--color-scheme dark|light] [--no-fixtures]
                              start an instance (default name: dev1, dev2, ...)
  down NAME... | --all [--keep]
                              stop instances and delete their directories
  ls                          list instances
  env NAME                    print shell exports for talking to an instance
  exec NAME -- CMD [ARG]...   run a command inside the instance's compositor
  screenshot NAME [OUT]       compositor screenshot (grim); prints the path
  capture NAME [OUT] [--full | --selector CSS]
                              screenshot of the first tab's page (no browser UI): the
                              viewport, the whole document, or one element
  atelier NAME ARGS...        run this repo's atelier CLI against the instance's daemon
                              (e.g. "atelier-dev atelier dev1 status")
  vnc NAME [--port PORT]      serve a headless instance over VNC (foreground)

  navigate NAME URL           load URL in the first tab, bring it to the front, and wait
  eval NAME EXPR              evaluate EXPR in the first tab; prints the result
  install-ext NAME PATH       install an extension (directory or .xpi) as a temporary add-on
  bidi NAME METHOD [PARAMS]   send one raw WebDriver BiDi command (PARAMS is JSON)

The BiDi commands each open and end their own session. Firefox allows only one
BiDi session at a time, so they fail while another client holds one.

Instances live in ${ROOT} (override with ATELIER_DEV_ROOT).`;

type State = {
  name: string;
  /** PID-1 of the jail's PID namespace; SIGKILL on it tears down the whole jail. */
  initPid: number;
  bidiPort: number;
  fixturesPort: number | null;
  visible: boolean;
  created: string;
};

type Paths = ReturnType<typeof instancePaths>;

function instancePaths(name: string) {
  const dir = path.join(ROOT, name);
  const home = path.join(dir, "home");
  return {
    dir,
    home,
    run: path.join(dir, "run"),
    log: path.join(dir, "log"),
    shots: path.join(dir, "shots"),
    profile: path.join(home, "firefox-profile"),
    state: path.join(dir, "state.json"),
  };
}

// ---------------------------------------------------------------------------
// Commands

async function cmdUp(args: string[]) {
  let name: string | undefined;
  let visible = false;
  let fixtures = true;
  let systemAccess = false;
  let atelierDir: string | undefined;
  let grant = false;
  const extensions: string[] = [];
  let nativeHost: string | undefined;
  const prefs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--name") name = args[++i];
    else if (a === "--visible") visible = true;
    else if (a === "--no-fixtures") fixtures = false;
    else if (a === "--system-access") systemAccess = true;
    else if (a === "--atelier-dir") atelierDir = path.resolve(args[++i]);
    else if (a === "--color-scheme") {
      // What pages see as prefers-color-scheme; most atelier users run dark desktops.
      const scheme = args[++i];
      if (scheme !== "dark" && scheme !== "light") die("--color-scheme takes dark or light");
      prefs.push(userPref(`layout.css.prefers-color-scheme.content-override=${scheme === "dark" ? 0 : 1}`));
    }
    else if (a === "--grant-user-scripts") {
      grant = true;
      // Otherwise permissions.request shows a prompt that also needs answering.
      prefs.push(userPref("extensions.webextOptionalPermissionPrompts=false"));
    }
    else if (a === "--extension") extensions.push(path.resolve(args[++i]));
    else if (a === "--native-host") nativeHost = path.resolve(args[++i]);
    else if (a === "--pref") prefs.push(userPref(args[++i]));
    else die(`up: unexpected argument ${a}`);
  }
  if (extensions.length === 0 && fs.existsSync(path.join(REPO, "extension/dist/manifest.json"))) {
    extensions.push(path.join(REPO, "extension/dist"));
  }
  for (const ext of extensions) {
    if (!isInside(ext, REPO)) die(`extension ${ext} is outside the repo, so the jail can't see it`);
    if (!isArchive(ext) && !fs.existsSync(path.join(ext, "manifest.json"))) die(`no manifest.json in ${ext}`);
  }
  if (!nativeHost && fs.existsSync(path.join(REPO, "target/debug/atelier"))) {
    nativeHost = path.join(REPO, "target/debug/atelier");
  }
  if (nativeHost && !isInside(nativeHost, REPO)) die(`native host ${nativeHost} is outside the repo, so the jail can't see it`);

  name ??= nextFreeName();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) die(`invalid instance name ${name}`);
  const p = instancePaths(name);
  const existing = readState(name);
  if (existing && isAlive(existing)) die(`instance ${name} is already running`);
  fs.rmSync(p.dir, { recursive: true, force: true });
  for (const d of [p.home, p.log, p.shots, p.profile]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(p.run, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(p.profile, "user.js"), FIREFOX_PREFS + prefs.join(""));
  if (nativeHost) registerNativeHost(p, nativeHost);

  let hostWayland: string | undefined;
  if (visible) {
    const display = requireEnv("WAYLAND_DISPLAY");
    hostWayland = path.isAbsolute(display) ? display : path.join(requireEnv("XDG_RUNTIME_DIR"), display);
    if (!fs.existsSync(hostWayland)) die(`host Wayland socket ${hostWayland} not found`);
  }

  const bidiPort = await freePort();
  const fixturesPort = fixtures ? await freePort() : null;

  const jailLog = fs.openSync(path.join(p.log, "jail.log"), "a");
  if (atelierDir && !fs.statSync(atelierDir, { throwIfNoEntry: false })?.isDirectory()) die(`--atelier-dir ${atelierDir} isn't a directory`);
  const child = spawn("bwrap", bwrapArgs(p, hostWayland, atelierDir), {
    detached: true,
    stdio: ["ignore", jailLog, jailLog, "pipe"],
  });
  fs.closeSync(jailLog);
  const info = await readBwrapInfo(child);
  child.unref();

  const state: State = {
    name,
    initPid: info["child-pid"],
    bidiPort,
    fixturesPort,
    visible,
    created: new Date().toISOString(),
  };
  fs.writeFileSync(p.state, JSON.stringify(state, null, 2) + "\n");

  try {
    await waitFor("sway", 15_000, () => swaySocket(p) && waylandSocket(p));
    swayExec(p, "firefox", [
      "firefox", "--profile", p.profile, "--no-remote", "--remote-debugging-port", String(bidiPort),
      // Lets BiDi reach privileged contexts such as moz-extension:// pages.
      ...(systemAccess ? ["--remote-allow-system-access"] : []),
    ]);
    if (fixturesPort !== null) {
      swayExec(p, "fixtures", [
        "node", path.join(REPO, "dev/fixtures/server.ts"), "--port", String(fixturesPort),
      ]);
    }
    await waitFor("Firefox's BiDi endpoint", 60_000, () => bidiReachable(bidiPort));
    for (const ext of extensions) {
      const id = await installExtension(state, ext);
      console.error(`installed ${path.relative(REPO, ext)} as ${id}`);
    }
    if (grant) {
      await grantUserScripts(state);
      console.error("granted the userScripts permission");
    }
  } catch (e) {
    console.error(`atelier-dev: ${(e as Error).message}; logs are in ${p.log}`);
    kill(state);
    process.exit(1);
  }

  console.log(describe(state));
}

function cmdDown(args: string[]) {
  const keep = args.includes("--keep");
  const names = args.includes("--all") ? listNames() : args.filter((a) => !a.startsWith("--"));
  if (names.length === 0) die("down: name an instance, or pass --all");
  for (const name of names) {
    const state = readState(name) ?? die(`no instance named ${name}`);
    kill(state);
    if (!keep) fs.rmSync(instancePaths(name).dir, { recursive: true, force: true });
    console.error(`stopped ${name}`);
  }
}

function cmdLs() {
  for (const name of listNames()) {
    const state = readState(name);
    if (!state) continue;
    const status = isAlive(state) ? "running" : "dead";
    const mode = state.visible ? "visible" : "headless";
    console.log(`${name}\t${status}\t${mode}\tbidi=${state.bidiPort}\t${instancePaths(name).dir}`);
  }
}

function cmdEnv(args: string[]) {
  const [name] = args;
  const state = running(name);
  const p = instancePaths(state.name);
  const vars: Record<string, string> = {
    ATELIER_DEV_INSTANCE: state.name,
    ATELIER_DEV_BIDI: `ws://127.0.0.1:${state.bidiPort}/session`,
    ATELIER_DEV_WAYLAND_DISPLAY: path.join(p.run, waylandSocket(p) ?? "wayland-0"),
    ATELIER_DEV_SWAYSOCK: path.join(p.run, swaySocket(p) ?? ""),
  };
  if (state.fixturesPort !== null) vars.ATELIER_DEV_FIXTURES = `http://127.0.0.1:${state.fixturesPort}`;
  for (const [k, v] of Object.entries(vars)) console.log(`export ${k}=${shq(v)}`);
}

function cmdExec(args: string[]) {
  const sep = args.indexOf("--");
  if (sep !== 1 || args.length < 3) die("usage: atelier-dev exec NAME -- CMD [ARG]...");
  const state = running(args[0]);
  swayExec(instancePaths(state.name), `exec-${Date.now()}`, args.slice(2));
}

function cmdScreenshot(args: string[]) {
  const [name, out] = args;
  const state = running(name);
  const p = instancePaths(state.name);
  const file = out ? path.resolve(out) : path.join(p.shots, `${timestamp()}.png`);
  const r = spawnSync("grim", [file], {
    env: { ...process.env, WAYLAND_DISPLAY: path.join(p.run, waylandSocket(p)!) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) die("grim failed");
  console.log(file);
}

function cmdVnc(args: string[]) {
  const [name, ...rest] = args;
  const state = running(name);
  const p = instancePaths(state.name);
  const port = rest[0] === "--port" ? rest[1] : "5900";
  console.error(`serving ${name} on vnc://127.0.0.1:${port} (ctrl-c to stop)`);
  const r = spawnSync("wayvnc", ["127.0.0.1", port], {
    env: { ...process.env, WAYLAND_DISPLAY: path.join(p.run, waylandSocket(p)!) },
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

async function cmdNavigate(args: string[]) {
  const [name, url] = args;
  if (!url) die("usage: atelier-dev navigate NAME URL");
  const state = running(name);
  await withBidiSession(state, async (bidi) => {
    const context = await firstContext(bidi);
    await bidi.send("browsingContext.activate", { context });
    const r = await bidi.send("browsingContext.navigate", { context, url, wait: "complete" });
    console.log(r.url);
  });
}

async function cmdCapture(args: string[]) {
  const full = args.includes("--full");
  const si = args.indexOf("--selector");
  const selector = si >= 0 ? args[si + 1] : undefined;
  const [name, out] = args.filter((a, i) => a !== "--full" && (si < 0 || (i !== si && i !== si + 1)));
  const state = running(name);
  const file = out ? path.resolve(out) : path.join(instancePaths(state.name).shots, `${timestamp()}.png`);
  await withBidiSession(state, async (bidi) => {
    const context = await firstContext(bidi);
    let clip: object | undefined;
    if (selector) {
      const found = await bidi.send("script.evaluate", {
        expression: `document.querySelector(${JSON.stringify(selector)})`,
        target: { context },
        awaitPromise: false,
        resultOwnership: "root",
      });
      if (found.result?.type !== "node") die(`no element matches ${selector}`);
      clip = { type: "element", element: { sharedId: found.result.sharedId } };
    }
    const r = await bidi.send("browsingContext.captureScreenshot", {
      context,
      origin: full || selector ? "document" : "viewport",
      ...(clip ? { clip } : {}),
      // A .jpg/.jpeg output name gets JPEG, which keeps previews small enough to commit.
      ...(/\.jpe?g$/i.test(file) ? { format: { type: "image/jpeg", quality: 0.85 } } : {}),
    });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  });
  console.log(file);
}

/**
 * Runs the repo's atelier CLI with the instance's XDG directories, so it finds
 * the instance's daemon. The daemon's socket is named after the owned
 * directory's path as the jail sees it, which this reproduces. With
 * --atelier-dir, files are under the bound host directory, not the jail path,
 * so for lint and match use `atelier --dir <that directory>` directly.
 */
function cmdAtelier(args: string[]) {
  const [name, ...rest] = args;
  const state = running(name);
  const p = instancePaths(state.name);
  const r = spawnSync(path.join(REPO, "target/debug/atelier"), rest, {
    stdio: "inherit",
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: p.run,
      XDG_STATE_HOME: path.join(p.home, ".local/state"),
      XDG_CONFIG_HOME: path.join(p.home, ".config"),
      XDG_DATA_HOME: path.join(p.home, ".local/share"),
      ATELIER_DIR: path.join(p.home, ".local/share/atelier"),
    },
  });
  process.exit(r.status ?? 1);
}

async function cmdEval(args: string[]) {
  const [name, expression] = args;
  if (!expression) die("usage: atelier-dev eval NAME EXPR");
  const state = running(name);
  await withBidiSession(state, async (bidi) => {
    const context = await firstContext(bidi);
    const r = await bidi.send("script.evaluate", {
      expression,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    if (r.type === "exception") {
      console.error(r.exceptionDetails.text);
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(fromRemoteValue(r.result), null, 2));
    }
  });
}

async function cmdInstallExt(args: string[]) {
  const [name, ext] = args;
  if (!ext) die("usage: atelier-dev install-ext NAME PATH");
  const abs = path.resolve(ext);
  if (!isInside(abs, REPO)) die(`extension ${abs} is outside the repo, so the jail can't see it`);
  console.log(await installExtension(running(name), abs));
}

async function cmdBidi(args: string[]) {
  const [name, method, params] = args;
  if (!method) die("usage: atelier-dev bidi NAME METHOD [PARAMS]");
  const state = running(name);
  await withBidiSession(state, async (bidi) => {
    console.log(JSON.stringify(await bidi.send(method, params ? JSON.parse(params) : {}), null, 2));
  });
}

// ---------------------------------------------------------------------------
// Jail

function bwrapArgs(p: Paths, hostWayland: string | undefined, atelierDir: string | undefined): string[] {
  const args = [
    "--unshare-all",
    // Shared so the host can reach BiDi and the fixture server, and the jail can
    // reach public sites. The jail's localhost is therefore the host's localhost.
    "--share-net",
    "--new-session",
    "--info-fd", "3",
    "--ro-bind", "/nix", "/nix",
    "--ro-bind", "/etc", "/etc",
  ];
  for (const dir of ["/usr", "/bin", "/lib", "/lib64", "/sys", "/run/current-system", "/run/opengl-driver"]) {
    args.push("--ro-bind-try", dir, dir);
  }
  args.push(
    "--dev", "/dev",
    "--dev-bind-try", "/dev/dri", "/dev/dri",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--bind", p.dir, p.dir,
    "--ro-bind", REPO, REPO,
  );

  // Name resolution. On NixOS (and other systemd-resolved setups),
  // /etc/resolv.conf points into /run/systemd/resolve, and glibc asks nscd
  // through its socket; the jail's /run is otherwise private.
  args.push("--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve");
  args.push("--bind-try", "/run/nscd", "/run/nscd");

  // A host directory used as the jail's default owned directory ($XDG_DATA_HOME/atelier), read-write.
  if (atelierDir) args.push("--bind", atelierDir, path.join(p.home, ".local/share/atelier"));

  // Fonts matter for judging styles, so instances should render like the real desktop.
  const realHome = os.homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(realHome, ".config");
  const xdgData = process.env.XDG_DATA_HOME ?? path.join(realHome, ".local/share");
  for (const [src, dst] of [
    [path.join(xdgConfig, "fontconfig"), path.join(p.home, ".config/fontconfig")],
    [path.join(xdgData, "fonts"), path.join(p.home, ".local/share/fonts")],
    [path.join(realHome, ".fonts"), path.join(p.home, ".fonts")],
  ]) {
    args.push("--ro-bind-try", src, dst);
  }

  const env: Record<string, string> = {
    PATH: jailPath(),
    HOME: p.home,
    XDG_RUNTIME_DIR: p.run,
    XDG_CONFIG_HOME: path.join(p.home, ".config"),
    XDG_DATA_HOME: path.join(p.home, ".local/share"),
    XDG_STATE_HOME: path.join(p.home, ".local/state"),
    XDG_CACHE_HOME: path.join(p.home, ".cache"),
    XDG_CURRENT_DESKTOP: "sway",
    MOZ_ENABLE_WAYLAND: "1",
    WLR_LIBINPUT_NO_DEVICES: "1",
    // Software rendering: GPU access inside the jail is unreliable, and
    // software output is more reproducible across machines anyway.
    WLR_RENDERER: process.env.ATELIER_DEV_WLR_RENDERER ?? "pixman",
  };
  for (const k of ["LANG", "LC_ALL", "TZ", "LOCALE_ARCHIVE", "TZDIR"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  if (hostWayland) {
    const inner = path.join(p.run, "host-wayland");
    args.push("--bind", hostWayland, inner);
    env.WLR_BACKENDS = "wayland";
    env.WAYLAND_DISPLAY = "host-wayland";
  } else {
    env.WLR_BACKENDS = "headless";
  }

  args.push("--clearenv");
  for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v);
  args.push("--chdir", p.home, "sway", "-c", path.join(REPO, "dev/sway.conf"));
  return args;
}

/** The host PATH, with symlinked entries (e.g. ~/.nix-profile/bin) resolved to store paths the jail can see. */
function jailPath(): string {
  const seen = new Set<string>();
  for (const entry of (process.env.PATH ?? "").split(":")) {
    try {
      const real = fs.realpathSync(entry);
      if (!isInside(real, os.homedir())) seen.add(real);
    } catch {
      // Nonexistent PATH entries are harmless on the host but useless in the jail.
    }
  }
  return [...seen].join(":");
}

function readBwrapInfo(child: ChildProcess): Promise<{ "child-pid": number }> {
  return new Promise((resolve, reject) => {
    const stream = child.stdio[3] as Readable;
    let buf = "";
    const fail = (why: string) => reject(new Error(`bwrap failed to start (${why})`));
    child.once("exit", (code) => fail(`exited with ${code}`));
    child.once("error", (e) => fail(e.message));
    stream.on("data", (chunk) => {
      buf += chunk;
      try {
        const info = JSON.parse(buf);
        child.removeAllListeners("exit");
        stream.destroy();
        resolve(info);
      } catch {
        // Not a complete JSON document yet.
      }
    });
  });
}

function kill(state: State) {
  // PID-1 of a namespace ignores catchable signals from outside, so SIGKILL it;
  // the kernel then kills everything else in the namespace.
  if (isAlive(state)) process.kill(state.initPid, "SIGKILL");
}

function isAlive(state: State): boolean {
  try {
    return fs.readFileSync(`/proc/${state.initPid}/comm`, "utf8").trim() === "bwrap";
  } catch {
    return false;
  }
}

/**
 * Grants the atelier extension the userScripts permission. Firefox only grants
 * it from a real user gesture, and BiDi can't drive extension pages, so this
 * waits for the onboarding page the extension opens on install (its button is
 * autofocused) and presses Enter through the compositor, until the extension
 * logs the grant.
 */
async function grantUserScripts(state: State) {
  const p = instancePaths(state.name);
  const firefoxLog = path.join(p.log, "firefox.log");
  const granted = () => fs.existsSync(firefoxLog) && fs.readFileSync(firefoxLog, "utf8").includes("atelier: userScripts permission granted");
  await waitFor("the onboarding page", 15_000, () =>
    withBidiSession(state, async (bidi) =>
      (await bidi.send("browsingContext.getTree", { maxDepth: 0 })).contexts.some((c: { url: string }) => c.url.endsWith("/onboarding.html")),
    ),
  );
  for (let attempt = 0; attempt < 3 && !granted(); attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    // wtype's first keystroke races the virtual keyboard's setup, hence -s.
    swayExec(p, `grant-${attempt}`, ["wtype", "-s", "300", "-k", "Return"]);
    await waitFor("the grant", 5000, granted).catch(() => {});
  }
  if (!granted()) throw new Error("couldn't grant the userScripts permission (is the atelier extension installed?)");
}

/**
 * Registers the dev native-messaging host in the jail's home, the only place
 * Firefox inside the jail looks. Firefox can't pass arguments to a host, so the
 * manifest points at a wrapper that adds the subcommand.
 */
function registerNativeHost(p: Paths, bin: string) {
  const wrapper = path.join(p.home, ".local/bin/atelier-native-host");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${shq(bin)} native-host "$@"\n`, { mode: 0o755 });

  const manifestDir = path.join(p.home, ".mozilla/native-messaging-hosts");
  fs.mkdirSync(manifestDir, { recursive: true });
  const manifest = {
    name: DEV_NATIVE_HOST,
    description: "atelier native host (dev build)",
    path: wrapper,
    type: "stdio",
    allowed_extensions: [DEV_EXTENSION_ID],
  };
  fs.writeFileSync(path.join(manifestDir, `${DEV_NATIVE_HOST}.json`), JSON.stringify(manifest, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Compositor

function swaySocket(p: Paths): string | undefined {
  return safeReaddir(p.run).find((f) => /^sway-ipc\..*\.sock$/.test(f));
}

function waylandSocket(p: Paths): string | undefined {
  return safeReaddir(p.run).find((f) => /^wayland-\d+$/.test(f));
}

/** Runs a command inside the jail as a child of sway, logging to log/<label>.log. */
function swayExec(p: Paths, label: string, argv: string[]) {
  // sway's `exec` goes through its own command parser before reaching sh, so
  // hand it a script path rather than an arbitrary command line.
  const script = path.join(p.run, `launch-${label}.sh`);
  const log = path.join(p.log, `${label}.log`);
  fs.writeFileSync(script, `#!/bin/sh\nexec ${argv.map(shq).join(" ")} >>${shq(log)} 2>&1\n`, { mode: 0o755 });
  const sock = swaySocket(p) ?? die("sway isn't running");
  const r = spawnSync("swaymsg", ["-s", path.join(p.run, sock), "exec", script], { encoding: "utf8" });
  if (r.status !== 0) die(`swaymsg exec failed: ${r.stderr || r.stdout}`);
}

// ---------------------------------------------------------------------------
// WebDriver BiDi

async function withBidiSession<T>(state: State, f: (bidi: Bidi) => Promise<T>): Promise<T> {
  return withSession(state.bidiPort, f);
}

async function firstContext(bidi: Bidi): Promise<string> {
  const tree = await bidi.send("browsingContext.getTree", { maxDepth: 0 });
  return tree.contexts[0]?.context ?? die("Firefox has no open tabs");
}

/** Packed extensions (.xpi or .zip) install from the archive; anything else is an unpacked directory. */
function isArchive(ext: string): boolean {
  return /\.(xpi|zip)$/.test(ext);
}

async function installExtension(state: State, ext: string): Promise<string> {
  return withBidiSession(state, async (bidi) => {
    const extensionData = isArchive(ext) ? { type: "archivePath", path: ext } : { type: "path", path: ext };
    const r = await bidi.send("webExtension.install", { extensionData });
    return r.extension;
  });
}

// ---------------------------------------------------------------------------
// Helpers

// Mostly quieting first-run UI. Firefox's remote agent applies its own
// recommended automation prefs on top (remote.prefs.recommended).
const FIREFOX_PREFS = `\
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.startup.page", 0);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("app.update.disabledForTesting", true);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.translations.automaticallyPopup", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.pocket.enabled", false);
// Console output from extensions and pages goes to log/firefox.log.
user_pref("devtools.console.stdout.chrome", true);
user_pref("devtools.console.stdout.content", true);
`;

/** Turns NAME=VALUE into a user.js line. VALUE is JSON if it parses as JSON (true, 30000, "x"), else a string. */
function userPref(arg: string | undefined): string {
  const eq = arg?.indexOf("=") ?? -1;
  if (!arg || eq < 1) die("--pref takes NAME=VALUE");
  const raw = arg.slice(eq + 1);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  return `user_pref(${JSON.stringify(arg.slice(0, eq))}, ${JSON.stringify(value)});\n`;
}

function running(name: string | undefined): State {
  if (!name) die("name an instance (see `atelier-dev ls`)");
  const state = readState(name) ?? die(`no instance named ${name}`);
  if (!isAlive(state)) die(`instance ${name} isn't running`);
  return state;
}

function readState(name: string): State | undefined {
  try {
    return JSON.parse(fs.readFileSync(instancePaths(name).state, "utf8"));
  } catch {
    return undefined;
  }
}

function listNames(): string[] {
  return safeReaddir(ROOT).filter((n) => fs.existsSync(instancePaths(n).state)).sort();
}

function nextFreeName(): string {
  const taken = new Set(listNames().filter((n) => isAlive(readState(n)!)));
  for (let i = 1; ; i++) if (!taken.has(`dev${i}`)) return `dev${i}`;
}

function describe(state: State): string {
  const p = instancePaths(state.name);
  const lines = [
    `instance   ${state.name} (${state.visible ? "visible" : "headless"})`,
    `bidi       ws://127.0.0.1:${state.bidiPort}/session`,
  ];
  if (state.fixturesPort !== null) lines.push(`fixtures   http://127.0.0.1:${state.fixturesPort}/`);
  lines.push(`directory  ${p.dir}`, `logs       ${p.log}`);
  return lines.join("\n");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(what: string, timeoutMs: number, check: () => unknown): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isInside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function shq(s: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function requireEnv(name: string): string {
  return process.env[name] || die(`${name} is not set`);
}

function die(msg: string): never {
  console.error(`atelier-dev: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

const COMMANDS: Record<string, (args: string[]) => unknown> = {
  up: cmdUp,
  down: cmdDown,
  ls: cmdLs,
  env: cmdEnv,
  exec: cmdExec,
  screenshot: cmdScreenshot,
  capture: cmdCapture,
  atelier: cmdAtelier,
  vnc: cmdVnc,
  navigate: cmdNavigate,
  eval: cmdEval,
  "install-ext": cmdInstallExt,
  bidi: cmdBidi,
};

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "-h" || command === "--help" || command === "help") {
  console.log(USAGE);
} else {
  const f = COMMANDS[command] ?? die(`unknown command ${command}\n\n${USAGE}`);
  try {
    await f(rest);
  } catch (e) {
    die((e as Error).message);
  }
}
