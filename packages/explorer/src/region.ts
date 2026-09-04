/**
 * Tell the API which timezone this browser is in, so the activity dashboard can
 * say where calls come from.
 *
 * WHY THIS AND NOT AN IP LOOKUP. Placing a caller by their address means the
 * coordinator handling addresses, which is the one thing this product says it
 * does not do. A timezone is something the browser already knows about itself,
 * it is coarse, it identifies nobody, and it is sent only to our own origin.
 *
 * WHY IT IS A FETCH WRAPPER. The site calls the API from a dozen places: the
 * playground, the docs demos, peal.js, the dashboard. Threading a header
 * through all of them would miss one, and the one it missed would quietly be
 * the interesting traffic. One seam, applied where the request is made.
 *
 * It is added only to our own origin, and only to the API paths. A wrapper that
 * attached a header to every request a page makes would leak the timezone to
 * whatever else the page talks to, which is the opposite of the point.
 */

const HEADER = 'x-peal-tz';

/** The IANA zone, or null if the browser will not say. */
function timezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Area/Location is the shape the server accepts. UTC and bare offsets say
    // nothing about where anybody is, so they are not worth sending.
    return tz && tz.includes('/') ? tz : null;
  } catch {
    return null;
  }
}

/** Same origin, and an API path. Anything else is left exactly as it was. */
function isOurApi(url: string): boolean {
  try {
    const target = new URL(url, window.location.href);
    if (target.origin !== window.location.origin) return false;
    return target.pathname.startsWith('/v0/') || target.pathname.startsWith('/v1/');
  } catch {
    return false;
  }
}

export function installRegionHeader(): void {
  const tz = timezone();
  if (!tz || typeof window.fetch !== 'function') return;

  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (!isOurApi(url)) return original(input as RequestInfo, init);

    // A Request carries its own headers, so it is rebuilt rather than having
    // init merged over it, which would drop the body and the method.
    if (input instanceof Request && !init) {
      const headers = new Headers(input.headers);
      if (!headers.has(HEADER)) headers.set(HEADER, tz);
      return original(new Request(input, { headers }));
    }
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has(HEADER)) headers.set(HEADER, tz);
    return original(input as RequestInfo, { ...init, headers });
  };
}
