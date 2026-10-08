// The sessionStorage markers through which a page knows, synchronously at
// document_start, what the background has set up for its tab. The background
// has the truth (ARCHITECTURE.md, "State and recovery"): markers are checked
// against it once the page can ask.

/** The task whose tree a bound tab shows (shim.ts). */
export const SOURCE_MARKER = "atelier:source";
/** The media features a tab emulates, as JSON (emulation.ts, media.ts). */
export const EMULATION_MARKER = "atelier:emulate";
