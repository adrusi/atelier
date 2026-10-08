// The page shim (SPEC §6.1; spike R1): applying styles. It's part of the page
// runtime (index.ts), which runs in the userScripts world at document_start
// in every page some style is registered for. Each style's registration runs
// the runtime and then `__atelierPage.shim.add(<style>)`, so a style's CSS is
// in the page before first paint.
//
// Styles live in <style> elements kept as the last children of <html>, in
// bundle order, so they win ties with the page's own stylesheets, and put back
// if the page removes them. The shim also adds the Dark Reader lock where a
// style asks for it (SPEC §6.5; spike R5), and connects to the background for
// live updates: new bundles, and history-API navigations that change which
// sections apply.
//
// A tab can be bound to a task's tree instead of the owned directory (SPEC
// §6.2), so an agent sees its work in progress and the user's tabs don't. The
// background marks a bound tab's sessionStorage, which is readable here
// synchronously, and the shim then skips the styles its registrations add and
// waits for the bound source's from the background. The marker is per origin
// and pages can clear it, so whenever the shim connects the background also
// sends the styles for the tab's actual source, and those always win.

import { cssFor, locksDarkReader, shadowFor } from "../matching";
import type { CompiledStyle } from "../proto/CompiledStyle";
import * as core from "./core";
import { SOURCE_MARKER as MARKER } from "./markers";

type Message = { type: "bundle"; styles: CompiledStyle[] } | { type: "url" } | { type: "bind"; source: string | null };

function readMarker(): string | null {
  try {
    return sessionStorage.getItem(MARKER);
  } catch {
    return null; // storage blocked; the background's styles still arrive
  }
}

type Unmet = { style: string; description: string };

export class Shim {
  private order: string[] = [];
  private styles = new Map<string, CompiledStyle>();
  private elements = new Map<string, HTMLStyleElement>();
  private locked = false;
  private observing = false;
  private port: browser.runtime.Port | null = null;
  private reported = "[]";
  /** The task this tab is bound to, as far as the page knows. */
  private source = readMarker();
  /** Set once the background has sent styles: from then on, they're the truth. */
  private fromBackground = false;

  add(style: CompiledStyle) {
    if (this.source !== null || this.fromBackground) {
      this.connect();
      return;
    }
    if (!this.styles.has(style.id)) this.order.push(style.id);
    this.styles.set(style.id, style);
    this.render();
    this.connect();
  }

  /** For a shim injected without a style: just get styles from the background. */
  attach() {
    this.connect();
  }

  private bind(source: string | null) {
    if (source === this.source) return;
    this.source = source;
    try {
      if (source === null) sessionStorage.removeItem(MARKER);
      else sessionStorage.setItem(MARKER, source);
    } catch {
      // Without the marker, the next load here briefly shows the default styles.
    }
  }

  private replaceAll(styles: CompiledStyle[]) {
    this.order = styles.map((s) => s.id);
    this.styles = new Map(styles.map((s) => [s.id, s]));
    this.render();
  }

  private render() {
    const root = document.documentElement;
    if (!root) return;
    const href = location.href;
    let lock = false;
    for (const id of this.order) {
      const style = this.styles.get(id)!;
      const css = cssFor(style, href);
      let el = this.elements.get(id);
      if (css === null) {
        el?.remove();
        this.elements.delete(id);
        continue;
      }
      if (!el) {
        el = document.createElement("style");
        el.setAttribute("data-atelier", id);
        this.elements.set(id, el);
      }
      if (el.textContent !== css) el.textContent = css;
      lock ||= locksDarkReader(style, href);
    }
    for (const [id, el] of this.elements) {
      if (!this.styles.has(id)) {
        el.remove();
        this.elements.delete(id);
      }
    }
    if (lock) this.addLock();
    this.keepLast();
    this.observe();
    this.renderShadow(href);
    // Sites often set the classes a check looks for from scripts in <head>,
    // so check once the document has been parsed.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.checkPrerequisites(), { once: true });
    } else {
      this.checkPrerequisites();
    }
  }

// -------------------------------------------------------------------------
  // Shadow roots (SPEC §6.1): page CSS can't reach inside a web component's
  // shadow root, so `@shadow host { … }` blocks go into the open shadow root
  // of each element matching `host`, wherever it is (in the page, or inside
  // another shadow root), as a <style> kept last there. Which roots exist,
  // and when they change, is core's to know.

  private shadowBlocks: { host: string; css: string; id: string }[] = [];
  private shadowStyles = new Map<ShadowRoot, HTMLStyleElement>();
  private shadowWatching = false;

  private renderShadow(href: string) {
    this.shadowBlocks = this.order.flatMap((id) => shadowFor(this.styles.get(id)!, href).map((b) => ({ ...b, id })));
    if (this.shadowBlocks.length && !this.shadowWatching) {
      this.shadowWatching = true;
      core.watch(() => this.applyShadow());
    }
    this.applyShadow();
  }

  private applyShadow() {
    if (!this.shadowBlocks.length && !this.shadowStyles.size) return;
    const wanted = new Map<ShadowRoot, string[]>();
    for (const scope of core.scopes()) {
      for (const b of this.shadowBlocks) {
        let hosts: Element[] = [];
        try {
          hosts = [...scope.querySelectorAll(b.host)];
        } catch {
          // An invalid selector matches nothing.
        }
        for (const host of hosts) {
          const root = core.shadowRootOf(host);
          if (!root) continue;
          const list = wanted.get(root) ?? [];
          if (!list.includes(b.css)) list.push(b.css);
          wanted.set(root, list);
        }
      }
    }
    for (const [root, css] of wanted) {
      let el = this.shadowStyles.get(root);
      if (!el) {
        el = document.createElement("style");
        el.setAttribute("data-atelier", "shadow");
        this.shadowStyles.set(root, el);
      }
      const text = css.join("\n");
      if (el.textContent !== text) el.textContent = text;
      if (root.lastElementChild !== el) root.append(el);
    }
    for (const [root, el] of this.shadowStyles) {
      if (!wanted.has(root)) {
        el.remove();
        this.shadowStyles.delete(root);
      }
    }
  }

  /** Tells the background which applying styles' prerequisites aren't met
   * here (SPEC §5.2), so the user hears about it rather than seeing a style
   * that seems to do nothing. */
  private checkPrerequisites() {
    const href = location.href;
    const unmet: Unmet[] = [];
    for (const id of this.order) {
      const style = this.styles.get(id)!;
      if (cssFor(style, href) === null) continue;
      for (const p of style.prerequisites) {
        if (!p.check) continue;
        let met = true;
        try {
          met = core.find(p.check) !== null;
        } catch {
          // An invalid selector can't tell us anything.
        }
        if (!met) unmet.push({ style: id, description: p.description });
      }
    }
    const json = JSON.stringify(unmet);
    if (json === this.reported || !this.port) return;
    this.reported = json;
    this.port.postMessage({ type: "prerequisites", unmet });
  }

  /** Dark Reader only looks for a lock added later inside <head>, and doesn't
   * come back if it's removed, so the lock is added once and never removed. */
  private addLock() {
    if (this.locked) return;
    this.locked = true;
    const meta = document.createElement("meta");
    meta.name = "darkreader-lock";
    (document.head ?? document.documentElement).append(meta);
  }

  private keepLast() {
    const root = document.documentElement;
    const els = this.order.map((id) => this.elements.get(id)).filter((e): e is HTMLStyleElement => Boolean(e));
    // CSS added for one screenshot (screenshot's extraCss) goes after ours, so it wins.
    const extra = [...root.querySelectorAll(":scope > style[data-atelier-extra]")];
    let node = root.lastElementChild;
    while (node && node.hasAttribute("data-atelier-extra")) node = node.previousElementSibling;
    for (let i = els.length - 1; i >= 0; i--) {
      if (node !== els[i]) {
        for (const el of els) root.append(el);
        for (const el of extra) root.append(el);
        return;
      }
      node = node.previousElementSibling;
    }
  }

  private observe() {
    if (this.observing) return;
    this.observing = true;
    // Our elements are direct children of <html>, so childList there is enough.
    new MutationObserver(() => this.keepLast()).observe(document.documentElement, { childList: true });
  }

  private connect() {
    if (this.port) return;
    try {
      this.port = browser.runtime.connect({ name: "atelier-shim" });
    } catch {
      return; // messaging unavailable; the page still has its styles
    }
    this.port.onMessage.addListener((msg: unknown) => {
      const m = msg as Message;
      if (m.type === "bundle") {
        this.fromBackground = true;
        this.replaceAll(m.styles);
      } else if (m.type === "bind") this.bind(m.source);
      else if (m.type === "url") this.render();
    });
    this.port.onDisconnect.addListener(() => (this.port = null));
    // If the page had already loaded (the shim was injected into an open tab),
    // render() checked before there was a port to report on.
    if (document.readyState !== "loading") this.checkPrerequisites();
  }
}
