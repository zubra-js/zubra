import { isDemo, reset } from '../lib/trip.server.js';

// The tests' way back to the seed. A hosted demo has none: one visitor can't wipe the others' work.
export function action() {
  if (isDemo()) throw new Response('Not found', { status: 404 });
  reset();
  return new Response(null, { status: 204 });
}
