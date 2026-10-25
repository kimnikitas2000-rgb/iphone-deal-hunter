/** Accept only a direct Avito listing URL, not the homepage or a search page. */
export function normalizeDirectAvitoUrl(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const parsed = new URL(candidate.trim());
      const hostname = parsed.hostname.toLowerCase();
      if (!['avito.ru', 'www.avito.ru', 'm.avito.ru'].includes(hostname)) continue;
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      const path = decodeURIComponent(parsed.pathname);
      const hasListingId = /(?:_|\/)\d{7,}(?:\.html)?\/?$/.test(path)
        || /\/(?:view|item|ads\/view)\/\d{7,}\/?$/.test(path);
      if (!hasListingId || path === '/') continue;
      parsed.protocol = 'https:';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      // Ignore malformed source URLs and try the next possible field.
    }
  }
  return null;
}

export function isDirectAvitoUrl(value) {
  return Boolean(normalizeDirectAvitoUrl(value));
}
