// The log as a public demo (`HOSTED_DEMO=1`, as in deploy/sveltekit-workouts): strangers can write
// to it, so it takes small bodies, a few writes a minute from each visitor, keeps a bounded number
// of workouts, and goes back to its seed every `resetMinutes` (a day by default, at midnight UTC)
// and whenever the server starts (the log is in memory).

export const NOTICE = 'Demo: data resets daily.';
export const MAX_WORKOUTS = 300;

/** Settings from the environment, or null when the log isn't a hosted demo. */
export function fromEnv(env = process.env) {
  if (env.HOSTED_DEMO !== '1') return null;
  return { resetMinutes: Number(env.DEMO_RESET_MINUTES ?? 1440), trustProxies: Number(env.TRUST_PROXIES ?? 0) };
}

/**
 * The visitor's address: the entry `trustProxies` from the end of X-Forwarded-For (each proxy in
 * front appends the address it was reached from), else the socket's. Never an entry the visitor
 * could have written themselves, so the limit can't be dodged by sending the header.
 */
export function clientAddress(event, trustProxies = 0) {
  const forwarded = (event.request.headers.get('x-forwarded-for') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (trustProxies > 0 && forwarded.length >= trustProxies) return forwarded[forwarded.length - trustProxies];
  try {
    return event.getClientAddress();
  } catch {
    return 'unknown';
  }
}

/** The page with the notice at the top of its body. */
export const withNotice = (html) => html.replace(/<body[^>]*>/, (body) => `${body}\n    <p class="demo-notice">${NOTICE}</p>`);

/**
 * A refusal. To use:enhance's request (`x-sveltekit-action`) it is an action's failure, which the
 * form shows as its error (the data in devalue's form: `{ errors: { limit } }`); to a plain post,
 * text.
 */
function refuse(request, status, message, headers = {}) {
  if (request.headers.get('x-sveltekit-action') !== 'true') return new Response(message, { status, headers });
  const data = JSON.stringify([{ errors: 1 }, { limit: 2 }, message]);
  return Response.json({ type: 'failure', status, data }, { status, headers });
}

/**
 * The checks before a request reaches SvelteKit's routes: the reset, then for writes the body
 * limit and the write limit. Returns the refusal, or undefined to go on. (adapter-node's
 * BODY_SIZE_LIMIT, set in the image, also bounds bodies sent without a Content-Length.)
 */
export function guard({ reset, resetMinutes = 1440, trustProxies = 0, writesPerMinute = 30, maxBytes = 16 * 1024, now = Date.now }) {
  const period = resetMinutes * 60_000;
  let epoch = Math.floor(now() / period);
  let minute = -1;
  const writes = new Map();
  return (event) => {
    const at = now();
    if (Math.floor(at / period) !== epoch) {
      epoch = Math.floor(at / period);
      reset();
    }
    const { method, headers } = event.request;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (Number(headers.get('content-length') ?? 0) > maxBytes) return refuse(event.request, 413, `A request body is at most ${maxBytes} bytes.`);
    if (Math.floor(at / 60_000) !== minute) {
      minute = Math.floor(at / 60_000);
      writes.clear();
    }
    const who = clientAddress(event, trustProxies);
    const count = (writes.get(who) ?? 0) + 1;
    writes.set(who, count);
    if (count > writesPerMinute) return refuse(event.request, 429, 'Too many changes from here: try again in a minute.', { 'retry-after': '60' });
  };
}
