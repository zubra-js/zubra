// The shop as a public demo (`HOSTED_DEMO=1`, as in deploy/hono-bikes): strangers can write to it,
// so it takes small bodies, a few writes a minute from each visitor, and goes back to its seed
// inventory every `resetMinutes` (a day by default, at midnight UTC). The inventory is a fixed list,
// so there are no records to cap: an edit replaces an item, and the body limit bounds what it holds.
import { bodyLimit } from 'hono/body-limit';

export const NOTICE = 'Demo: data resets daily.';

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
export function clientAddress(ctx, trustProxies = 0) {
  const forwarded = (ctx.req.header('x-forwarded-for') ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (trustProxies > 0 && forwarded.length >= trustProxies) return forwarded[forwarded.length - trustProxies];
  return ctx.env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

/** Hono middleware: the body limit, then the reset and the write limit. */
export function hosted({ reset, resetMinutes = 1440, trustProxies = 0, writesPerMinute = 30, maxBytes = 16 * 1024, now = Date.now }) {
  const period = resetMinutes * 60_000;
  let epoch = Math.floor(now() / period);
  let minute = -1;
  const writes = new Map();
  const guard = async (ctx, next) => {
    const at = now();
    if (Math.floor(at / period) !== epoch) {
      epoch = Math.floor(at / period);
      reset();
    }
    if (ctx.req.method === 'POST') {
      if (Math.floor(at / 60_000) !== minute) {
        minute = Math.floor(at / 60_000);
        writes.clear();
      }
      const who = clientAddress(ctx, trustProxies);
      const count = (writes.get(who) ?? 0) + 1;
      writes.set(who, count);
      if (count > writesPerMinute) return ctx.text('Too many changes from here: try again in a minute.', 429, { 'retry-after': '60' });
    }
    await next();
  };
  const limit = bodyLimit({ maxSize: maxBytes, onError: (ctx) => ctx.text(`A request body is at most ${maxBytes} bytes.`, 413) });
  return [limit, guard];
}
