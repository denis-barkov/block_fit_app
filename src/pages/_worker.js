const forwarded = [
  'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-original-host', 'x-original-url', 'x-rewrite-url',
];
const publicHeaders = [
  'accept-ranges', 'allow', 'cache-control', 'content-disposition', 'content-encoding',
  'content-language', 'content-range', 'content-type', 'etag', 'last-modified',
  'vary',
];
export const browserHeaders = {
  'Content-Security-Policy':"frame-ancestors 'none'",
  'X-Frame-Options':'DENY',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Referrer-Policy':'strict-origin-when-cross-origin',
  'X-Content-Type-Options':'nosniff',
};

function wantsPage(request,url) {
  return (request.method==='GET'||request.method==='HEAD')&&url.pathname!=='/api'&&!url.pathname.startsWith('/api/')&&
    request.headers.get('Accept')?.includes('text/html');
}

async function unavailable(request,env,url,status=502) {
  const headers={...browserHeaders,'Cache-Control':'no-store'};
  if(wantsPage(request,url)&&env.ASSETS) {
    try {
      const fallback=await env.ASSETS.fetch(new Request(new URL('/',url),{method:request.method}));
      if(fallback.ok)return new Response(request.method==='HEAD'?null:fallback.body,{
        status,headers:{...headers,'Content-Type':'text/html; charset=utf-8'},
      });
    } catch {
      // The plain response is still available if the Pages assets binding fails.
    }
  }
  return new Response(request.method==='HEAD'?null:'The application is temporarily unavailable.', {
    status, headers,
  });
}

export default {
  /** @param {Request} request @param {{ APP_ORIGIN: string, BACKEND: Fetcher, ASSETS: Fetcher }} env */
  async fetch(request, env) {
    // Pages deployment URLs and preview aliases are deliberately outside the canonical origin.
    const url=new URL(request.url);
    if (url.origin !== env.APP_ORIGIN) {
      return new Response('Not found.', { status: 404, headers:{...browserHeaders,'Cache-Control':'no-store'} });
    }
    const requestHeaders = new Headers(request.headers);
    for (const name of forwarded) requestHeaders.delete(name);
    let upstream;
    try {
      upstream = await env.BACKEND.fetch(new Request(request, { headers: requestHeaders, redirect: 'manual' }));
    } catch {
      return unavailable(request,env,url);
    }
    if([502,503,504].includes(upstream.status)&&wantsPage(request,url)) {
      return unavailable(request,env,url,upstream.status);
    }

    const headers = new Headers(browserHeaders);
    for (const name of publicHeaders) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const location = upstream.headers.get('Location');
    if (location) {
      let target;
      try { target = new URL(location, request.url); } catch { return unavailable(request,env,url); }
      if (target.origin !== env.APP_ORIGIN || target.username || target.password) return unavailable(request,env,url);
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
