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
  execute(injection: { target: { tabId: number; allFrames?: boolean }; js: { code: string }[]; injectImmediately?: boolean }): Promise<unknown[]>;
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

/** For permissions.request/contains; the @types don't list "userScripts". */
export const USER_SCRIPTS_PERMISSION = { permissions: ["userScripts"] } as unknown as browser.permissions.Permissions;

type MessageEvent = {
  addListener(cb: (msg: unknown, sender: browser.runtime.MessageSender) => Promise<unknown> | undefined): void;
  hasListener(cb: (msg: unknown, sender: browser.runtime.MessageSender) => Promise<unknown> | undefined): boolean;
};

/** runtime.onUserScriptMessage, likewise only present once permitted. */
export function onUserScriptMessage(): MessageEvent | undefined {
  return (browser.runtime as unknown as { onUserScriptMessage?: MessageEvent }).onUserScriptMessage;
}
