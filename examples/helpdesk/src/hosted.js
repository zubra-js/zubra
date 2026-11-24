// The help desk as a public demo (`HOSTED_DEMO=1`, as in deploy/helpdesk): strangers can write to
// it, so it keeps its data in memory (never MongoDB), takes small posts, a few writes a minute from
// each visitor, a bounded number of tickets and messages, a bounded number of streamed dashboards
// at once, refuses cross-site posts, and goes back to its seed data every `resetMinutes` (a day by
// default, at midnight UTC) and whenever the server starts.
//
// Signing in stays as it is: the sign-in page lists the demo's people (two agents, three
// customers) and a visitor picks one. Nothing a visitor does changes who those people are.

export const NOTICE = 'Demo: data resets daily.';
export const FULL = 'The demo is full for today: it resets at midnight UTC.';

/**
 * Settings from the environment, or null when the help desk isn't a hosted demo. `origins`: the
 * public origin(s) a browser's Origin header names, since the app itself is reached over plain
 * HTTP behind the proxy: `DEMO_ORIGIN`, and Railway's `RAILWAY_PUBLIC_DOMAIN` (set on a service
 * that has a domain) as https.
 */
export function fromEnv(env = process.env) {
  if (env.HOSTED_DEMO !== '1') return null;
  const origins = [env.DEMO_ORIGIN, env.RAILWAY_PUBLIC_DOMAIN && `https://${env.RAILWAY_PUBLIC_DOMAIN}`].filter(Boolean);
  return { resetMinutes: Number(env.DEMO_RESET_MINUTES ?? 1440), trustProxies: Number(env.TRUST_PROXIES ?? 0), origins };
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

/**
 * Whether a post comes from this site, by the rule @zubra/actions uses for the reply box (so the
 * app's own forms and the server function agree): Sec-Fetch-Site `same-origin` or `none`, or an
 * Origin in `origins`, passes; any other Sec-Fetch-Site is refused; with neither header it isn't a
 * browser, so there's no cross-site request to forge; else the Origin must be the request's own.
 */
export function sameSite(req, origins = []) {
  const site = req.headers['sec-fetch-site'];
  const origin = req.headers.origin;
  if (site === 'same-origin' || site === 'none' || (origin && origins.includes(origin))) return true;
  if (site) return false;
  if (!origin) return true;
  return origin === `http://${req.headers.host}`;
}

/**
 * The store, with at most `maxTickets` tickets and `maxMessages` messages across them: a new
 * ticket or reply past that is refused (`createTicket` gives null, `addMessage` false).
 */
export function capped(store, { maxTickets, maxMessages }) {
  const counts = async () => {
    const tickets = await store.listTickets({});
    return { tickets: tickets.length, messages: tickets.reduce((sum, ticket) => sum + ticket.messages.length, 0) };
  };
  return {
    ...store,
    async createTicket(ticket) {
      const now = await counts();
      if (now.tickets >= maxTickets || now.messages + ticket.messages.length > maxMessages) return null;
      return store.createTicket(ticket);
    },
    async addMessage(id, message, changes) {
      if ((await counts()).messages >= maxMessages) return false;
      return store.addMessage(id, message, changes);
    },
  };
}

/**
 * The demo's limits, for createApp: `store` (capped), `guard` (Express middleware: the reset, the
 * body size, the same-site check and the write limit, before anything else), `streams` (how many
 * dashboards stream at once), and the numbers.
 */
export function demo({
  store,
  resetMinutes = 1440,
  trustProxies = 0,
  origins = [],
  writesPerMinute = 30,
  maxBytes = 16 * 1024,
  maxTickets = 100,
  maxMessages = 500,
  maxStreams = 20,
  streamTimeout = 10_000,
  now = Date.now,
}) {
  const period = resetMinutes * 60_000;
  let epoch = Math.floor(now() / period);
  let minute = -1;
  const writes = new Map();

  const guard = async (req, res, next) => {
    try {
      const at = now();
      if (Math.floor(at / period) !== epoch) {
        epoch = Math.floor(at / period);
        await store.reset();
      }
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      // A declared length over the limit is refused unread; a body without one is cut off at the
      // limit by its reader (express.urlencoded's `limit`, @zubra/actions' `maxBytes`).
      if (Number(req.headers['content-length'] ?? 0) > maxBytes) {
        res.set('connection', 'close');
        return res.status(413).type('text').send(`A request body is at most ${maxBytes} bytes.`);
      }
      if (!sameSite(req, origins)) return res.status(403).type('text').send('Cross-site form posts are refused');
      if (Math.floor(at / 60_000) !== minute) {
        minute = Math.floor(at / 60_000);
        writes.clear();
      }
      const who = clientAddress(req, trustProxies);
      const count = (writes.get(who) ?? 0) + 1;
      writes.set(who, count);
      if (count > writesPerMinute) return res.status(429).set('retry-after', '60').type('text').send('Too many changes from here: try again in a minute.');
      next();
    } catch (error) {
      next(error);
    }
  };

  // The dashboard streams its activity list: its response stays open until the list arrives (at
  // most `streamTimeout`). Past `maxStreams` at once, a dashboard waits for its list instead and
  // goes in one piece, so the open streams stay bounded.
  let open = 0;
  const streams = {
    get open() { return open; },
    /** Takes a slot for `res` (given back when it closes), or false when they're all taken. */
    take(res) {
      if (open >= maxStreams) return false;
      open++;
      res.once('close', () => open--);
      return true;
    },
  };

  return { store: capped(store, { maxTickets, maxMessages }), guard, streams, maxBytes, streamTimeout, origins };
}
