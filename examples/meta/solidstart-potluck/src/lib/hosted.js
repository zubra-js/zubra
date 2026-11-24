// The potluck as a public demo (`HOSTED_DEMO=1`, as in deploy/solidstart-potluck): strangers can
// sign up, so it takes small bodies, a few writes a minute from each visitor and a bounded number
// of sign-ups, and goes back to its seed sign-ups every `resetMinutes` (a day by default, at
// midnight UTC) and whenever the server starts (they live in memory). Plain web Requests, so the
// tests need neither a build nor a browser; src/middleware.js puts the guard in front of SolidStart.

export const NOTICE = 'Demo: data resets daily.';
/** The board grows by one household per sign-up: this many at most, with short names and dishes. */
export const MAX_SIGNUPS = 100;
export const MAX_NAME = 40;
export const MAX_DISH = 60;

/** Settings from the environment, or null when the potluck isn't a hosted demo. */
export function fromEnv(env = process.env) {
  if (env.HOSTED_DEMO !== '1') return null;
  return { resetMinutes: Number(env.DEMO_RESET_MINUTES ?? 1440), trustProxies: Number(env.TRUST_PROXIES ?? 0) };
}

/**
 * The visitor's address: the entry `trustProxies` from the end of X-Forwarded-For (each proxy in
 * front appends the address it was reached from), else the socket's. Never an entry the visitor
 * could have written themselves, so the limit can't be dodged by sending the header.
 */
export function clientAddress(request, socketAddress, trustProxies = 0) {
  const forwarded = (request.headers.get('x-forwarded-for') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (trustProxies > 0 && forwarded.length >= trustProxies) return forwarded[forwarded.length - trustProxies];
  return socketAddress ?? 'unknown';
}

/** What a hosted sign-up can't be, on top of the action's own checks. */
export function signupErrors(signup, count) {
  const errors = [];
  if (count >= MAX_SIGNUPS) errors.push('The sign-up sheet is full until the demo resets (daily).');
  if (signup.name.length > MAX_NAME) errors.push(`A name of at most ${MAX_NAME} characters, please.`);
  if (signup.dish.length > MAX_DISH) errors.push(`A dish of at most ${MAX_DISH} characters, please.`);
  return errors;
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const text = (body, status, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });

/** True when the body is over `maxBytes`, read from a clone so the request's own body is untouched. */
async function tooLarge(request, maxBytes) {
  const length = request.headers.get('content-length');
  if (length && Number(length) > maxBytes) return true;
  if (!request.body) return false;
  // No (or an honest small) Content-Length: count the bytes, and stop as soon as there are too many.
  const reader = request.clone().body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return false;
    total += value.byteLength;
    if (total > maxBytes) {
      // (Not awaited: a tee's branch settles its cancel only once the other branch is cancelled too.)
      reader.cancel().catch(() => {});
      return true;
    }
  }
}

/**
 * The guard in front of every request: the daily reset, then for writes (anything but GET, HEAD
 * and OPTIONS: SolidStart's actions and server functions are POSTs to /_server) the per-visitor
 * limit and the body limit. Returns a Response to refuse the request with, or undefined.
 */
export function createGuard({ reset, resetMinutes = 1440, trustProxies = 0, writesPerMinute = 30, maxBytes = 16 * 1024, now = Date.now }) {
  const period = resetMinutes * 60_000;
  let epoch = Math.floor(now() / period);
  let minute = -1;
  const writes = new Map();
  return async (request, socketAddress) => {
    const at = now();
    if (Math.floor(at / period) !== epoch) {
      epoch = Math.floor(at / period);
      reset();
    }
    if (READS.has(request.method)) return undefined;
    if (Math.floor(at / 60_000) !== minute) {
      minute = Math.floor(at / 60_000);
      writes.clear();
    }
    const who = clientAddress(request, socketAddress, trustProxies);
    const count = (writes.get(who) ?? 0) + 1;
    writes.set(who, count);
    if (count > writesPerMinute) return text('Too many changes from here: try again in a minute.', 429, { 'retry-after': '60' });
    if (await tooLarge(request, maxBytes)) return text(`A request body is at most ${maxBytes} bytes.`, 413);
    return undefined;
  };
}
