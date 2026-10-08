// The sessionStorage markers through which a page knows, synchronously at
// document_start, what the background has set up for its tab. The background
// has the truth (ARCHITECTURE.md, "State and recovery"): markers are checked
// against it once the page can ask.

/** The task whose tree a bound tab shows (shim.ts). */
export const SOURCE_MARKER = "atelier:source";
/** "light" or "dark" in a tab emulating a colour scheme (emulation.ts). */
export const SCHEME_MARKER = "atelier:scheme";
