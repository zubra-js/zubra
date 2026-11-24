// The board as a public demo (`HOSTED_DEMO=1`, as in deploy/standup): strangers can write to it, so
// its log takes only the team's three cards (two fields each, the latest value of each kept), small
// requests, a bounded number of writes a minute from each visitor, and starts empty again every
// `resetMinutes` (a day by default, at midnight UTC) and whenever the server starts.
import { rmSync } from 'node:fs';

export const NOTICE = 'Demo: data resets daily.';
export const MAX_TEXT = 2000;

/** Settings from the environment, or null when the board isn't a hosted demo. */
export function fromEnv(env = process.env) {
  if (env.HOSTED_DEMO !== '1') return null;
  return { resetMinutes: Number(env.DEMO_RESET_MINUTES ?? 1440), trustProxies: Number(env.TRUST_PROXIES ?? 0) };
}

/** A card's fields, and only the team's cards: the log can't hold more than 3 × 2 values. */
export const cardsOnly = (team) => {
  const docs = new Set(team.map((person) => person.doc));
  return ({ collection, key, field, value, kind }) => {
    if (collection !== 'cards' || !docs.has(key)) return false;
    if (kind !== 'change') return true;
    if (field === 'today') return typeof value === 'string' && value.length <= MAX_TEXT;
    if (field === 'blocked') return typeof value === 'boolean';
    return false;
  };
};

/**
 * The visitor's address: the entry `trustProxies` from the end of X-Forwarded-For (each proxy in
 * front appends the address it was reached from), else the socket's. Never an entry the visitor
 * could have written themselves, so the limit can't be dodged by sending the header.
 */
export function clientAddress(req, trustProxies = 0) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (trustProxies > 0 && forwarded.length >= trustProxies) return forwarded[forwarded.length - trustProxies];
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Typing pushes about every 30 ms, so the write limit is per second, with room for a burst: it
 * slows a script, not a person. A refused push stays in the page's outbox and goes with the next.
 */
export function writeLimit({ perSecond = 10, burst = 100, now = Date.now } = {}) {
  const buckets = new Map();
  return (who) => {
    const at = now();
    const bucket = buckets.get(who) ?? { tokens: burst, at };
    bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.at) / 1000) * perSecond);
    bucket.at = at;
    buckets.set(who, bucket);
    // Full buckets say nothing a new one wouldn't: dropping them keeps the map to recent writers.
    if (buckets.size > 10_000) for (const [key, old] of buckets) if (old.tokens >= burst) buckets.delete(key);
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
}

/** Removes a SQLite file and its journal, so the log starts empty. */
export function wipe(path) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
}
