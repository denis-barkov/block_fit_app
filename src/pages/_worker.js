const forwarded = [
  'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-original-host', 'x-original-url', 'x-rewrite-url',
];
const publicHeaders = [
  'accept-ranges', 'allow', 'cache-control', 'content-disposition', 'content-encoding',
  'content-language', 'content-range', 'content-type', 'etag', 'last-modified',
  'referrer-policy', 'vary', 'x-content-type-options',
];

function unavailable() {
  return new Response('The application is temporarily unavailable.', {
    status: 502, headers: { 'Cache-Control': 'no-store' },
  });
}

export default {
  /** @param {Request} request @param {{ APP_ORIGIN: string, BACKEND: Fetcher }} env */
  async fetch(request, env) {
    // Pages deployment URLs and preview aliases are deliberately outside the canonical origin.
    if (new URL(request.url).origin !== env.APP_ORIGIN) {
      return new Response('Not found.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    const requestHeaders = new Headers(request.headers);
    for (const name of forwarded) requestHeaders.delete(name);
    let upstream;
    try {
      upstream = await env.BACKEND.fetch(new Request(request, { headers: requestHeaders, redirect: 'manual' }));
    } catch {
      return unavailable();
    }

    const headers = new Headers();
    for (const name of publicHeaders) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const location = upstream.headers.get('Location');
    if (location) {
      let target;
      try { target = new URL(location, request.url); } catch { return unavailable(); }
      if (target.origin !== env.APP_ORIGIN || target.username || target.password) return unavailable();
      headers.set('Location', target.href);
    }
    for (const cookie of upstream.headers.getSetCookie()) {
      headers.append('Set-Cookie', cookie.replace(/;\s*Domain\s*=[^;]*/gi, ''));
    }

    return new Response(upstream.body, {
      status: upstream.status, headers, encodeBody: 'manual',
    });
  },
};
