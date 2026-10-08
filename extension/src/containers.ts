// Throwaway containers (SPEC §17): an agent tab in a temporary Firefox
// container holding a copy of the user's cookies for one site. It's logged in
// as the user, but what the agent changes there (a site's theme switch, a
// dismissed notice) stays in the container, which is removed when its last
// tab closes. Site storage (localStorage, IndexedDB) isn't copied: settings
// kept there start at the site's defaults.

const NAME = "atelier (throwaway)";

/** Throwaway containers by tab, for cleanup and for describing tabs. */
const throwaways = new Map<number, string>();

export const isThrowaway = (tabId: number) => throwaways.has(tabId);

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
 * in `from` (a cookieStoreId; the default container if omitted). */
export async function fork(url: string, from = "firefox-default"): Promise<{ cookieStoreId: string; copied: number }> {
  const identity = await browser.contextualIdentities.create({ name: NAME, color: "purple", icon: "fence" });
  const store = identity.cookieStoreId;
  let copied = 0;
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

export function remember(tabId: number, cookieStoreId: string) {
  throwaways.set(tabId, cookieStoreId);
}

/** Removes a throwaway container once no tab uses it. */
async function release(cookieStoreId: string) {
  if ((await browser.tabs.query({ cookieStoreId })).length) return;
  await browser.contextualIdentities.remove(cookieStoreId).catch(() => {});
}

browser.tabs.onRemoved.addListener((tabId) => {
  const store = throwaways.get(tabId);
  if (!store) return;
  throwaways.delete(tabId);
  void release(store);
});

/** Leftovers from before a restart: throwaway containers with no tabs. */
export async function sweep() {
  try {
    for (const c of await browser.contextualIdentities.query({ name: NAME })) await release(c.cookieStoreId);
  } catch {
    // Containers turned off: nothing to sweep.
  }
}
