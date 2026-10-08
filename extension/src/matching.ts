// URL matching for @-moz-document sections (SPEC §5.3). Shared by the page
// shim and the extension's UI, so they always agree.

import type { CompiledSection } from "./proto/CompiledSection";
import type { CompiledStyle } from "./proto/CompiledStyle";
import type { Matcher } from "./proto/Matcher";

const regexps = new Map<string, RegExp | null>();

export function matches(m: Matcher, href: string): boolean {
  const url = href.split("#")[0];
  switch (m.kind) {
    case "url":
      return url === m.value.split("#")[0];
    case "url-prefix":
      return url.startsWith(m.value);
    case "domain": {
      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        return false;
      }
      const d = m.value.toLowerCase();
      return host === d || host.endsWith("." + d);
    }
    case "regexp": {
      let re = regexps.get(m.value);
      if (re === undefined) {
        try {
          re = new RegExp(`^(?:${m.value})$`);
        } catch {
          re = null;
        }
        regexps.set(m.value, re);
      }
      return re?.test(url) ?? false;
    }
  }
}

export function sectionApplies(s: CompiledSection, href: string): boolean {
  return s.matchers.length === 0 || s.matchers.some((m) => matches(m, href));
}

/** The CSS a style contributes to a page, or null if no section applies. */
export function cssFor(style: CompiledStyle, href: string): string | null {
  const parts = style.sections.filter((s) => sectionApplies(s, href)).map((s) => s.css);
  if (parts.length === 0) return null;
  return [style.varsCss, ...parts].filter(Boolean).join("\n");
}

/** Whether a style should keep Dark Reader off this page (SPEC §6.5). */
export function locksDarkReader(style: CompiledStyle, href: string): boolean {
  return style.darkReaderLock && style.sections.some((s) => s.matchers.length > 0 && sectionApplies(s, href));
}

/** A style's CSS for shadow roots on this page (`@shadow` blocks). */
export function shadowFor(style: CompiledStyle, href: string): { host: string; css: string }[] {
  return style.sections.filter((s) => sectionApplies(s, href)).flatMap((s) => s.shadow ?? []);
}
