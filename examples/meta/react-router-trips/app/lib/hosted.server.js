// The trip as a public demo (`HOSTED_DEMO=1`, as in deploy/react-router-trips): strangers can write
// to it, so it takes small bodies and a few writes a minute from each visitor (server.js, in front
// of React Router), holds at most MAX_EXPENSES short expenses, and goes back to its seed expenses
// every `resetMinutes` (a day by default, at midnight UTC) and whenever the server starts
// (trip.server.js, in memory).

export const NOTICE = 'Demo: data resets daily.';
export const MAX_EXPENSES = 100;
export const MAX_TEXT = 100;
export const MAX_CENTS = 100_000_00;

/** Settings from the environment, or null when the trip isn't a hosted demo. */
export function fromEnv(env = process.env) {
  if (env.HOSTED_DEMO !== '1') return null;
  return { resetMinutes: Number(env.DEMO_RESET_MINUTES ?? 1440), trustProxies: Number(env.TRUST_PROXIES ?? 0) };
}

/**
 * The visitor's address: the entry `trustProxies` from the end of X-Forwarded-For (each proxy in
 * front appends the address it was reached from), else the socket's. Never an entry the visitor
 * could have written themselves, so the limit can't be dodged by sending the header.
 */
export function clientAddress(req, trustProxies = 0) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (trustProxies > 0 && forwarded.length >= trustProxies) return forwarded[forwarded.length - trustProxies];
  return req.socket?.remoteAddress ?? 'unknown';
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Connect-style middleware for server.js: a body over `maxBytes` is a 413 before React Router reads
 * it (a body without a length, a 411: browsers always send one), and more than `writesPerMinute`
 * writes from one visitor in a minute are a 429.
 */
export function guard({ trustProxies = 0, writesPerMinute = 30, maxBytes = 16 * 1024, now = Date.now } = {}) {
  let minute = -1;
  const writes = new Map();
  return (req, res, next) => {
    if (READS.has(req.method)) return next();
    const length = req.headers['content-length'];
    if (length === undefined && req.headers['transfer-encoding']) return refuse(res, 411, 'A request body needs a Content-Length.');
    if (Number(length) > maxBytes) return refuse(res, 413, `A request body is at most ${maxBytes} bytes.`);
    const at = now();
    if (Math.floor(at / 60_000) !== minute) {
      minute = Math.floor(at / 60_000);
      writes.clear();
    }
    const who = clientAddress(req, trustProxies);
    const count = (writes.get(who) ?? 0) + 1;
    writes.set(who, count);
    if (count > writesPerMinute) return refuse(res, 429, 'Too many changes from here: try again in a minute.', { 'retry-after': '60' });
    next();
  };
}

function refuse(res, status, message, headers = {}) {
  // The connection closes: what's left of a refused body isn't read.
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close', ...headers }).end(message);
}
