// Next's proxy (its middleware) runs before every route. It does nothing unless the app is a hosted
// demo: then it refuses a request body over 16 KiB that says its length (the Server Action reads at
// most that much of any other: next.config.mjs), and a visitor's writes past 30 a minute
// (lib/hosted.js, `guard`).
import { NextResponse } from 'next/server';
import { fromEnv, guard, LIMITED, writeLimit } from './lib/hosted.js';

const hosted = fromEnv();
const allow = (globalThis.__writeLimit ??= writeLimit());

export function proxy(request) {
  if (!hosted) return NextResponse.next();
  const headers = new Headers(request.headers);
  headers.delete(LIMITED);
  const refused = guard(request, { trustProxies: hosted.trustProxies, allow });
  if (refused?.status === 429 && request.headers.has('next-action')) {
    // A page's script calling the action would show Next's error page for a 429: the action is
    // told instead (app/actions.js), and answers with a message the form shows.
    headers.set(LIMITED, '1');
  } else if (refused) {
    return new NextResponse(refused.message, { status: refused.status, headers: { 'content-type': 'text/plain; charset=utf-8', ...refused.headers } });
  }
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
