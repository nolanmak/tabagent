/** Search and ordering for the side panel's Settings -> Sites list (#117). */

/** Bare lowercase hostname of an origin key; the lowercased key itself if it does not parse. */
export function siteHost(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return origin.toLowerCase();
  }
}

/**
 * Rows of `sites` whose origin or bare host contains `query` (case-insensitive,
 * surrounding whitespace ignored), sorted by host then origin so related sites
 * sit together. `total` is the unfiltered count for an "N of M" label.
 */
export function filterSites<T>(sites: Record<string, T>, query: string): { rows: [string, T][]; total: number } {
  const q = query.trim().toLowerCase();
  const all = Object.entries(sites).map(([origin, entry]) => ({ origin, entry, host: siteHost(origin) }));
  const rows = all
    .filter(({ origin, host }) => !q || origin.toLowerCase().includes(q) || host.includes(q))
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0))
    .map(({ origin, entry }) => [origin, entry] as [string, T]);
  return { rows, total: all.length };
}
