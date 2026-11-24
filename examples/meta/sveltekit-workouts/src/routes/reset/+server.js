// For the tests: back to the seed data (not on a hosted demo, where it resets on its own).
import { error } from '@sveltejs/kit';
import { reset } from '#lib/server/log.js';
import { fromEnv } from '#lib/server/hosted.js';

export function POST() {
  if (fromEnv()) error(404, 'Not found');
  reset();
  return new Response(null, { status: 204 });
}
