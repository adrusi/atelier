// The MV3 userScripts API (Firefox 136+). @types/firefox-webext-browser only
// describes the older MV2 API of the same name, so this is typed by hand.

export type UserScript = {
  id: string;
  matches: string[];
  js: { code: string }[];
  runAt?: "document_start" | "document_end" | "document_idle";
  world?: "USER_SCRIPT" | "MAIN";
  allFrames?: boolean;
};

export type UserScriptsApi = {
  register(scripts: UserScript[]): Promise<void>;
  update(scripts: UserScript[]): Promise<void>;
  unregister(filter?: { ids?: string[] }): Promise<void>;
  getScripts(filter?: { ids?: string[] }): Promise<UserScript[]>;
  configureWorld(props: { messaging?: boolean; csp?: string }): Promise<void>;
  /** Runs code in an open tab's USER_SCRIPT world, the same world registered scripts use. */
  execute(injection: { target: { tabId: number; frameIds?: number[]; allFrames?: boolean }; js: { code: string }[]; injectImmediately?: boolean }): Promise<unknown[]>;
};

/** The API, or undefined while the userScripts permission isn't granted. */
export function userScripts(): UserScriptsApi | undefined {
  return (browser as unknown as { userScripts?: UserScriptsApi }).userScripts;
}

type PortEvent = {
  addListener(cb: (port: browser.runtime.Port) => void): void;
  hasListener(cb: (port: browser.runtime.Port) => void): boolean;
};

/** runtime.onUserScriptConnect, likewise only present once permitted. */
export function onUserScriptConnect(): PortEvent | undefined {
  return (browser.runtime as unknown as { onUserScriptConnect?: PortEvent }).onUserScriptConnect;
}

/** What atelier needs granted to work, each asked for on its own (Firefox
 * won't request userScripts with anything else), and each with a click:
 * user scripts (optional-only in Firefox), and access to every site, which
 * an installed MV3 extension may not get without asking (one installed by
 * policy or into a profile never sees a prompt). Without site access its
 * styles aren't injected, and APIs like tabs.captureTab don't exist in pages
 * started without it. (The @types don't list "userScripts".) */
export const REQUIRED_PERMISSIONS: { label: string; permissions: browser.permissions.Permissions }[] = [
  { label: "Allow user scripts", permissions: { permissions: ["userScripts"] } as unknown as browser.permissions.Permissions },
  { label: "Allow access to your sites", permissions: { origins: ["<all_urls>"] } },
];

/** The first permission atelier still needs, or null if it has them all. */
export async function missingPermission(): Promise<(typeof REQUIRED_PERMISSIONS)[number] | null> {
  for (const p of REQUIRED_PERMISSIONS) {
    if (!(await browser.permissions.contains(p.permissions).catch(() => false))) return p;
  }
  return null;
}

/** Whether everything in REQUIRED_PERMISSIONS is granted. */
export async function hasRequiredPermissions(): Promise<boolean> {
  return Boolean(userScripts()) && (await missingPermission()) === null;
}

type MessageEvent = {
  addListener(cb: (msg: unknown, sender: browser.runtime.MessageSender) => Promise<unknown> | undefined): void;
  hasListener(cb: (msg: unknown, sender: browser.runtime.MessageSender) => Promise<unknown> | undefined): boolean;
};

/** runtime.onUserScriptMessage, likewise only present once permitted. */
export function onUserScriptMessage(): MessageEvent | undefined {
  return (browser.runtime as unknown as { onUserScriptMessage?: MessageEvent }).onUserScriptMessage;
}
