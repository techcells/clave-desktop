const SITE = /^[a-z0-9-]+(\.[a-z0-9-]+)*$/;
const HOST = /(?:^|[^a-z0-9.-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[:/\s]|$)/g;

export function parseSites(raw: unknown): {sites: string[]; problems: string[]} {
  if (!Array.isArray(raw)) return {sites: [], problems: ["excluded sites must be a list"]};
  const sites: string[] = [];
  const problems: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "string") { problems.push(`site ${index + 1} is not text`); return; }
    const site = entry.trim().toLowerCase();
    if (!site) return;
    if (!SITE.test(site)) { problems.push(`site ${index + 1} is not a hostname`); return; }
    sites.push(site);
  });
  return {sites, problems};
}

export function extractHosts(toolbarText: string): string[] {
  const hosts = new Set<string>();
  for (const match of toolbarText.toLowerCase().matchAll(HOST)) if (match[1]) hosts.add(match[1]);
  return [...hosts];
}

export function hostMatches(host: string, pattern: string): boolean {
  if (pattern.includes(".")) return host === pattern || host.endsWith("." + pattern);
  return host.split(".").includes(pattern);
}

function titleMentions(title: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(title);
}

/** Either signal is enough. Without an exact address we stay cautious. */
export function siteExcluded(sites: string[], title: string, toolbarText: string | undefined): boolean {
  const hosts = extractHosts(toolbarText ?? "");
  return sites.some((site) => hosts.some((host) => hostMatches(host, site)) || titleMentions(title, site));
}
