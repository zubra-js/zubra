// The public demo's caps (server/hosted.js), in front of every route when HOSTED_DEMO=1: the
// reset, same-site writes only, the body and write limits. Off, it does nothing.
import { createGuard, fromEnv, NOTICE, readCapped } from '../hosted.js';

const settings = fromEnv();
const MAX_BYTES = 16 * 1024;
const guard = settings && createGuard({ ...settings, reset: resetBooks, maxBytes: MAX_BYTES });

export default defineEventHandler(async (event) => {
  if (!guard) return;
  event.context.demoNotice = NOTICE;
  const { req } = event.node;
  const refuse = (status: number, message: string, headers: Record<string, string> = {}) => {
    setResponseStatus(event, status);
    setResponseHeaders(event, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    return message;
  };
  // The tests' reset would let one visitor wipe everyone's edits: the demo resets on its own.
  if (getRequestURL(event).pathname === '/api/reset') return refuse(404, 'Not found.');
  const refused = guard({ method: req.method ?? 'GET', headers: req.headers, remoteAddress: req.socket?.remoteAddress });
  if (refused) return refuse(refused.status, refused.message, refused.headers);
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
    const body = await readCapped(req, MAX_BYTES);
    if (!body) return refuse(413, `A request body is at most ${MAX_BYTES} bytes.`, { connection: 'close' });
    // h3's readBody takes the body from here, so the route reads what was counted.
    (req as any)[Symbol.for('h3RawBody')] = Promise.resolve(body);
  }
});
