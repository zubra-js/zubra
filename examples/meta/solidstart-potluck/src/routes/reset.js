// POST /reset puts the sign-ups back (for the tests). Not in a public demo, where anyone could.
import { fromEnv } from '../lib/hosted.js';
import { resetPotluck } from '../lib/potluck.js';

export function POST() {
  if (fromEnv()) return new Response(null, { status: 404 });
  resetPotluck();
  return new Response(null, { status: 204 });
}
