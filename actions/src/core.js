// What @zubra/actions does with a request, given its routes: no file system, no Node.js. The Node
// entry (index.js) compiles a components folder into routes when it starts; the edge entry
// (edge.js) is given routes built ahead of time (`zubra-actions build`). Both answer through this.
export const MOUNT = '/_zb/action/';
export const SCRIPT_PATH = '/_zb/actions.js';
/** Where `@zubra/actions/enhance-forms` is served (plain form posts without the reload). */
export const FORMS_PATH = '/_zb/enhance-forms.js';
export const COOKIE = '__zb_result';
/**
 * On HTTPS the result cookie is `__Host-zb_result` and `Secure`: browsers then refuse it from a
 * sibling subdomain or plain HTTP, so nobody else can plant a "result" for the next page.
 */
export const SECURE_COOKIE = '__Host-zb_result';
export const CLEAR = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
const SECURE_CLEAR = `${SECURE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
/** The largest post read by default: 10 MB, files and fields together. */
export const MAX_BYTES = 10 * 1024 * 1024;
/** What a function's caller gets for a post over the limit; the function doesn't run. */
export const TOO_LARGE = Object.freeze({ error: 'Too large' });

/** Brotli if an `accept-encoding` takes it, else gzip if it takes that, else null (as @zubra/server's `compress`). */
export function encodingFor(accepts) {
  if (typeof accepts !== 'string') return null;
  const taken = new Set();
  for (const part of accepts.toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((piece) => piece.trim());
    const q = params.find((param) => param.startsWith('q='));
    if (!q || Number(q.slice(2)) > 0) taken.add(name);
  }
  return taken.has('br') ? 'br' : taken.has('gzip') ? 'gzip' : null;
}

/**
 * `routes`: a Map of URL → function. `client`: the enhancing script's source, served at
 * SCRIPT_PATH, or null when the host serves it as a static file. `forms`: the same for
 * `@zubra/actions/enhance-forms`, at FORMS_PATH. `scriptCaching`: their `cache-control`.
 * `encodings`: `{ [SCRIPT_PATH or FORMS_PATH]: { br, gzip } }`, each script compressed ahead
 * (the Node entry's `compress`), sent to a request whose `accept-encoding` takes one.
 */
export function createActionsCore({ routes, client = null, forms = null, origins = [], onError = (error) => console.error(error), context = () => ({}), maxBytes = MAX_BYTES, secure, scriptCaching = 'no-cache', encodings = null }) {
  // Whether a request is over HTTPS, for the result cookie: what the app says (`secure`, for one
  // behind a proxy that ends TLS, whose requests reach it as http), else the request's own URL.
  const overHttps = (request) => secure ?? (/^https:/i.test(request.url ?? '') || request.socket?.encrypted === true);
  if (!(maxBytes > 0)) throw new TypeError('@zubra/actions: `maxBytes` is the largest post to read, in bytes (Infinity for no limit)');
  const over = Symbol('too large');
  /** The post's fields and files, or `over` when it's bigger than maxBytes (counted as it's read). */
  async function readForm(request) {
    if (Number(request.headers.get('content-length')) > maxBytes) return over;
    if (maxBytes === Infinity || !request.body) return request.formData();
    let seen = 0;
    let tooLarge = false;
    const counted = request.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen <= maxBytes) return controller.enqueue(chunk);
          tooLarge = true;
          controller.error(new RangeError('too large'));
        },
      }),
    );
    try {
      return await new Response(counted, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
    } catch (error) {
      if (tooLarge) return over;
      throw error;
    }
  }
  // A browser says where a post was sent from in Sec-Fetch-Site and Origin both: another site
  // is let in only by an Origin in `origins`.
  const allowed = (request) => {
    const site = request.headers.get('sec-fetch-site');
    const origin = request.headers.get('origin');
    if (site === 'same-origin' || site === 'none' || (origin && origins.includes(origin))) return true;
    if (site) return false;
    if (!origin) return true; // not a browser (curl, a test): CSRF needs a browser
    return origin === new URL(request.url).origin;
  };

  /**
   * The page to go back to: the referring page on this origin, else the site root. A path that
   * starts with `//` (from `https://site//evil.example/`, or `/\evil.example/`) is protocol-relative
   * in a Location header, so it's written with a single leading slash: it stays on this site.
   */
  const back = (request) => {
    const referer = request.headers.get('referer');
    // No Referer (a privacy setting, or a client that sends none) goes to the root, not to
    // `new URL(null)`'s `<action path>/null`.
    if (!referer) return '/';
    try {
      const url = new URL(referer, request.url);
      if (url.origin === new URL(request.url).origin) return '/' + (url.pathname + url.search).replace(/^\/+/, '');
    } catch {}
    return '/';
  };

  async function fetch(request, extra = {}) {
    const url = new URL(request.url);
    if (request.method === 'GET' && (url.pathname === SCRIPT_PATH || url.pathname === FORMS_PATH)) {
      const source = url.pathname === SCRIPT_PATH ? client : forms;
      if (source === null) return null;
      const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': scriptCaching };
      const encoded = encodings?.[url.pathname];
      if (!encoded) return new Response(source, { headers });
      // `vary` on the plain answer too: a shared cache must not hand it to a browser that asked for Brotli.
      headers.vary = 'accept-encoding';
      const encoding = encodingFor(request.headers.get('accept-encoding'));
      if (!encoding) return new Response(source, { headers });
      return new Response(encoded[encoding], { headers: { ...headers, 'content-encoding': encoding, 'content-length': String(encoded[encoding].byteLength) } });
    }
    if (!url.pathname.startsWith(MOUNT)) return null;
    if (request.method !== 'POST') return text(405, 'Method Not Allowed', { allow: 'POST' });
    if (!allowed(request)) return text(403, 'Cross-site form posts are refused');
    const fn = routes.get(url.pathname);
    if (!fn) return text(404, 'Not Found');
    const wantsJson = (request.headers.get('accept') ?? '').includes('application/json');
    let value;
    let status = 200;
    try {
      const form = await readForm(request);
      if (form === over) {
        status = 413;
        value = TOO_LARGE;
      } else {
        const more = await context({ request, ...extra });
        value = await fn(form, { ...more, request });
      }
    } catch (error) {
      onError(error, request);
      status = 500;
      value = { error: 'Something went wrong' };
    }
    if (value instanceof Response) {
      // A redirect after success: the enhanced path is told where to go rather than following it,
      // so the page navigates once, with the location's #fragment kept (fetch drops it).
      // Only an http(s) location is passed on: a `javascript:` one (a redirect to a visitor's
      // `next`) would run on the page. Anything else goes out as the plain redirect it was, which
      // neither fetch nor a browser follows.
      const location = value.headers.get('location');
      if (wantsJson && location && value.status >= 300 && value.status < 400 && httpUrl(location, url)) {
        const headers = new Headers({ 'zb-location': location });
        for (const cookie of value.headers.getSetCookie()) headers.append('set-cookie', cookie);
        return new Response(null, { status: 204, headers });
      }
      return value;
    }
    if (wantsJson) {
      return new Response(JSON.stringify(value ?? null), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    const location = back(request);
    const headers = new Headers({ location });
    // `page` is where the result goes back to: only that page reads it (docs/actions.md).
    const cookie = encodeURIComponent(JSON.stringify({ action: url.pathname, page: location.split('?')[0], value: value ?? null }));
    // A cookie holds about 4 KB; a bigger result reaches only the enhanced path.
    if (cookie.length < 3800) {
      headers.append('set-cookie', overHttps(request) ? `${SECURE_COOKIE}=${cookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60` : `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`);
    }
    return new Response(null, { status: 303, headers });
  }

  /**
   * After a no-JavaScript post: `{ action, value }` once, else null. `request` is a fetch Request
   * or a Node request; `setHeader(name, value)` is given the header that clears the cookie.
   */
  function result(request, setHeader) {
    const header = (typeof request.headers.get === 'function' ? request.headers.get('cookie') : request.headers.cookie) ?? '';
    const parts = header.split(/;\s*/);
    // Over https only the __Host- cookie is ours: the plain one can be planted by a sibling
    // subdomain or over plain http, and would show its text as this site's answer.
    const name = overHttps(request) || parts.some((part) => part.startsWith(`${SECURE_COOKIE}=`)) ? SECURE_COOKIE : COOKIE;
    const match = parts.find((part) => part.startsWith(`${name}=`));
    if (!match) return null;
    let found;
    try {
      found = JSON.parse(decodeURIComponent(match.slice(name.length + 1)));
    } catch {
      return null;
    }
    // Another page leaves it for the one the form came from. A cookie with no `page` is not
    // ours to show: without that field it would match every path.
    const path = (request.url ? new URL(request.url, 'http://localhost').pathname : null) ?? null;
    if (typeof found?.page !== 'string' || (path && found.page !== path)) {
      if (typeof found?.page !== 'string') setHeader?.('set-cookie', name === SECURE_COOKIE ? SECURE_CLEAR : CLEAR);
      return null;
    }
    setHeader?.('set-cookie', name === SECURE_COOKIE ? SECURE_CLEAR : CLEAR);
    const { page, ...rest } = found ?? {};
    return found && typeof found === 'object' ? rest : found;
  }

  return {
    fetch,
    result,
    routes: () => [...routes.keys()],
    script: () => `<script type="module" src="${SCRIPT_PATH}"></script>`,
    formsScript: () => `<script type="module" src="${FORMS_PATH}"></script>`,
    clearCookie: CLEAR,
  };
}

/** `{ url: fn }` (one component's `actions`, or several merged) as routes, refusing a URL twice. */
export function routesFrom(...maps) {
  const routes = new Map();
  for (const map of maps) {
    for (const [url, fn] of Object.entries(map ?? {})) {
      if (!url.startsWith(MOUNT) || typeof fn !== 'function') throw new TypeError(`@zubra/actions: ${url} is not an action route`);
      if (routes.has(url)) throw new Error(`@zubra/actions: two components define ${url}`);
      routes.set(url, fn);
    }
  }
  return routes;
}

/** Whether `location`, read against the request's URL, is an http(s) URL. */
function httpUrl(location, base) {
  try {
    return ['http:', 'https:'].includes(new URL(location, base).protocol);
  } catch {
    return false;
  }
}

function text(status, body, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
}
