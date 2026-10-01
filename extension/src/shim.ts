// The page shim (SPEC §6.1; spike R1). It runs in the userScripts world at
// document_start in every page some style is registered for. Each style's
// registration runs this file and then `__atelier.add(<style>)`, so a style's
// CSS is in the page before first paint.
//
// Styles live in <style> elements kept as the last children of <html>, in
// bundle order, so they win ties with the page's own stylesheets, and put back
// if the page removes them. The shim also adds the Dark Reader lock where a
// style asks for it (SPEC §6.5; spike R5), and connects to the background for
// live updates: new bundles, and history-API navigations that change which
// sections apply.

import { cssFor, locksDarkReader } from "./matching";
import type { CompiledStyle } from "./proto/CompiledStyle";

type Message = { type: "bundle"; styles: CompiledStyle[] } | { type: "url" };

class Shim {
  private order: string[] = [];
  private styles = new Map<string, CompiledStyle>();
  private elements = new Map<string, HTMLStyleElement>();
  private locked = false;
  private observing = false;
  private port: browser.runtime.Port | null = null;

  add(style: CompiledStyle) {
    if (!this.styles.has(style.id)) this.order.push(style.id);
    this.styles.set(style.id, style);
    this.render();
    this.connect();
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
    let node = root.lastElementChild;
    for (let i = els.length - 1; i >= 0; i--) {
      if (node !== els[i]) {
        for (const el of els) root.append(el);
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
      if (m.type === "bundle") this.replaceAll(m.styles);
      else if (m.type === "url") this.render();
    });
    this.port.onDisconnect.addListener(() => (this.port = null));
  }
}

const g = globalThis as unknown as { __atelier?: Shim };
g.__atelier ??= new Shim();
