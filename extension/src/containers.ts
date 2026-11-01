// Throwaway containers (SPEC §17): an agent tab in a temporary Firefox
// container holding a copy of the user's cookies for one site. It's logged in
// as the user, but what the agent changes there (a site's theme switch, a
// dismissed notice) stays in the container, which is removed when its last
// tab closes. Site storage (localStorage, IndexedDB) isn't copied: settings
// kept there start at the site's defaults.
//
// The containers made in this browser session are listed in session storage.
// One that isn't listed is left from an earlier session (Firefox keeps
// containers, and may restore their tabs), and sweep removes it with any tabs
// still in it; a listed one is removed once no tab uses it.

const NAME = "atelier (throwaway)";

const made: Promise<Set<string>> = browser.storage.session
  .get("throwaways")
  .then((v) => new Set((v.throwaways as string[] | undefined) ?? []));

/** Containers just made, whose tab may not be open yet. */
const opening = new Set<string>();

/** The part of a hostname cookies for the site can be set on: the last two
 * labels, or three where the second-to-last is short (example.co.uk).
 * Approximate, without the public suffix list; IP addresses as they are. */
function siteOf(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  const n = labels.length >= 3 && labels[labels.length - 2].length <= 3 ? 3 : 2;
  return labels.slice(-n).join(".");
}

/** Creates a throwaway container with a copy of the cookies `url`'s site has
 * in `from` (a cookieStoreId; the default container if omitted), or with no
 * cookies at all when `copy` is false (the site as a new visitor sees it). */
export async function fork(url: string, from = "firefox-default", copy = true): Promise<{ cookieStoreId: string; copied: number }> {
  const identity = await browser.contextualIdentities.create({ name: NAME, color: "purple", icon: "fence" });
  const store = identity.cookieStoreId;
  const list = await made;
  list.add(store);
  await browser.storage.session.set({ throwaways: [...list] });
  opening.add(store);
  setTimeout(() => opening.delete(store), 30_000);
  let copied = 0;
  if (!copy) return { cookieStoreId: store, copied };
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { cookieStoreId: store, copied };
  }
  for (const c of await browser.cookies.getAll({ domain: siteOf(host), storeId: from })) {
    try {
      await browser.cookies.set({
        url: `${c.secure ? "https" : "http"}://${c.domain.replace(/^\./, "")}${c.path}`,
        name: c.name,
        value: c.value,
        ...(c.hostOnly ? {} : { domain: c.domain }),
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        ...(c.session ? {} : { expirationDate: c.expirationDate }),
        storeId: store,
      });
      copied++;
    } catch {
      // A cookie Firefox won't set this way (an odd domain, say) is left out.
    }
  }
  return { cookieStoreId: store, copied };
}

/** Removes throwaway containers nothing needs: those no tab uses, and those
 * left from an earlier session, with their tabs. */
export async function sweep() {
  let found: browser.contextualIdentities.ContextualIdentity[];
  try {
    found = await browser.contextualIdentities.query({ name: NAME });
  } catch {
    return; // containers turned off: nothing to sweep
  }
  const list = await made;
  for (const c of found) {
    const tabs = await browser.tabs.query({ cookieStoreId: c.cookieStoreId });
    if (list.has(c.cookieStoreId) && (tabs.length || opening.has(c.cookieStoreId))) continue;
    if (tabs.length) {
      console.info(`atelier: closing ${tabs.length} tab(s) in a throwaway container from an earlier session`);
      await browser.tabs.remove(tabs.map((t) => t.id!)).catch(() => {});
    }
    await browser.contextualIdentities.remove(c.cookieStoreId).catch(() => {});
    if (list.delete(c.cookieStoreId)) await browser.storage.session.set({ throwaways: [...list] });
  }
}
