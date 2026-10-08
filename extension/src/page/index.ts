// The page runtime (ARCHITECTURE.md, "The page model"): atelier's code inside
// a page, built into one script and run in the page's userScripts world,
// where registered styles, injected shims and tool calls all share it. It
// installs itself once, as globalThis.__atelierPage:
//
// - `shim`: applying styles (shim.ts), made on first use;
// - `tools`: what the background's tools call by name (tools.ts);
// - `emulation`: emulated media features (emulation.ts).
//
// Everything in it reads the page through core.ts.

import * as emulation from "./emulation";
import { Shim } from "./shim";
import * as tools from "./tools";

let shim: Shim | undefined;
const runtime = {
  get shim() {
    shim ??= new Shim();
    return shim;
  },
  tools,
  emulation,
};

export type PageRuntime = typeof runtime;

const g = globalThis as unknown as { __atelierPage?: PageRuntime };
g.__atelierPage ??= runtime;
