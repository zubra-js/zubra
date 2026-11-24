// The schedule as a public demo (`HOSTED_DEMO=1`, as in deploy/next-conference): strangers can
// rate talks, so the feedback takes small requests (next.config.mjs and proxy.js), a few writes a
// minute from each visitor (proxy.js), a bounded number of ratings (lib/feedback.js), and starts
// empty again every `resetMinutes` (a day by default, at midnight UTC) and whenever the server
// starts. Stars are kept in the visitor's own browser, so there's nothing of theirs to cap.

export const NOTICE = 'Demo: data resets daily.';
export const MAX_BYTES = 16 * 1024;
export const WRITES_PER_MINUTE = 30;
// Ratings kept per talk: the oldest go first. Twelve talks, comments of at most 1000 characters.
export const MAX_RATINGS = 200;
// The request header the proxy sets on a Server Action call over the write limit (proxy.js).
export const LIMITED = 'x-demo-write-limited';
export const TOO_MANY = 'Too many changes from here: try again in a minute.';

/** Settings from the environment, or null when the app isn't a hosted demo. */
export function fromEnv(env = process.env) {
  if (env.HOSTED_DEMO !== '1') return null;
  return { resetMinutes: Number(env.DEMO_RESET_MINUTES ?? 1440), trustProxies: Number(env.TRUST_PROXIES ?? 0) };
}

/**
 * The visitor's address: the entry `trustProxies` from the end of X-Forwarded-For (each proxy in
 * front appends the address it was reached from), never one the visitor could have written
 * themselves. With no proxy in front, Next fills X-Forwarded-For with the socket's address when a
 * request comes without one, and the proxy sees nothing else, so the last entry is all there is.
 */
export function clientAddress(headers, trustProxies = 0) {
  const forwarded = String(headers.get('x-forwarded-for') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (trustProxies > 0 && forwarded.length >= trustProxies) return forwarded[forwarded.length - trustProxies];
  return forwarded.at(-1) ?? 'unknown';
}

/** Counts each visitor's writes in the current minute: false once one is over `perMinute`. */
export function writeLimit({ perMinute = WRITES_PER_MINUTE, now = Date.now } = {}) {
  let minute = -1;
  const writes = new Map();
  return (who) => {
    const current = Math.floor(now() / 60_000);
    if (current !== minute) {
      minute = current;
      writes.clear();
    }
    const count = (writes.get(who) ?? 0) + 1;
    writes.set(who, count);
    return count <= perMinute;
  };
}

/** The reset period's number: it changes at midnight UTC (for a day), and the data starts over. */
export const epoch = (at, resetMinutes = 1440) => Math.floor(at / (resetMinutes * 60_000));

/**
 * Whether the proxy refuses a request (`{ status, message, headers }`), or null to let it through.
 * A write is any request but GET, HEAD and OPTIONS: here, the feedback form's Server Action.
 */
export function guard(request, { trustProxies = 0, allow, maxBytes = MAX_BYTES }) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null;
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) return { status: 413, message: `A request body is at most ${maxBytes} bytes.`, headers: {} };
  if (!allow(clientAddress(request.headers, trustProxies))) return { status: 429, message: TOO_MANY, headers: { 'retry-after': '60' } };
  return null;
}
