// The bookshop as a public demo (`HOSTED_DEMO=1`, as in deploy/nuxt-bookshop): strangers can edit
// it, so it takes small bodies, a few writes a minute from each visitor, only same-site writes, and
// goes back to its seed inventory every `resetMinutes` (a day by default, at midnight UTC) and
// whenever the server starts (the books are in memory). The inventory is a fixed list of seven, so
// there are no records to cap: an edit replaces a book's fields, and the API's validation and the
// body limit bound what each holds. Plain JavaScript with no Nitro imports, so the tests load it
// directly; server/middleware/hosted.ts puts it in front of every request.

export const NOTICE = 'Demo: data resets daily.';
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Settings from the environment, or null when the shop isn't a hosted demo. */
export function fromEnv(env = process.env) {
  if (env.HOSTED_DEMO !== '1') return null;
  return { resetMinutes: Number(env.DEMO_RESET_MINUTES ?? 1440), trustProxies: Number(env.TRUST_PROXIES ?? 0) };
}

/**
 * The visitor's address: the entry `trustProxies` from the end of X-Forwarded-For (each proxy in
 * front appends the address it was reached from), else the socket's. Never an entry the visitor
 * could have written themselves, so the limit can't be dodged by sending the header.
 */
export function clientAddress(headers, remoteAddress, trustProxies = 0) {
  const forwarded = String(headers['x-forwarded-for'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (trustProxies > 0 && forwarded.length >= trustProxies) return forwarded[forwarded.length - trustProxies];
  return remoteAddress ?? 'unknown';
}

/**
 * Whether a write comes from the shop's own pages. Nuxt has no CSRF check of its own. A browser
 * says where a request comes from in Sec-Fetch-Site, and older ones only in Origin: its host must be
 * the one the request was sent to. Only hosts are compared, since behind Railway's proxy the page is
 * https and the server speaks http. With neither header it isn't a browser's request (curl, a
 * script), which a CSRF check has nothing to say about.
 */
export function sameSite(headers) {
  const site = headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    return false; // "null", from a sandboxed frame or a redirect
  }
}

/**
 * The checks before a route, given the request's method, headers and socket address: null to go on,
 * or the response to send ({ status, message, headers }). `reset` runs when a new period starts.
 */
export function createGuard({ reset, resetMinutes = 1440, trustProxies = 0, writesPerMinute = 30, maxBytes = 16 * 1024, now = Date.now }) {
  const period = resetMinutes * 60_000;
  let epoch = Math.floor(now() / period);
  let minute = -1;
  const writes = new Map();
  return ({ method, headers, remoteAddress }) => {
    const at = now();
    if (Math.floor(at / period) !== epoch) {
      epoch = Math.floor(at / period);
      reset();
    }
    if (!MUTATIONS.has(method)) return null;
    if (!sameSite(headers)) return { status: 403, message: 'Changes come from the shop’s own pages.' };
    if (Number(headers['content-length'] ?? 0) > maxBytes) return { status: 413, message: `A request body is at most ${maxBytes} bytes.` };
    if (Math.floor(at / 60_000) !== minute) {
      minute = Math.floor(at / 60_000);
      writes.clear();
    }
    const who = clientAddress(headers, remoteAddress, trustProxies);
    const count = (writes.get(who) ?? 0) + 1;
    writes.set(who, count);
    if (count > writesPerMinute) return { status: 429, message: 'Too many changes from here: try again in a minute.', headers: { 'retry-after': '60' } };
    return null;
  };
}

/**
 * A request body read up to `maxBytes`: the bytes, or null as soon as there are more (a chunked body
 * has no Content-Length to refuse it by up front). The stream is left unread past that point.
 */
export function readCapped(stream, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        stream.off('data', onData);
        stream.pause();
        resolve(null);
      } else chunks.push(chunk);
    };
    stream.on('data', onData);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
