// For the tests: back to the seed data. Not on a hosted demo, where it would let one visitor wipe
// everyone's edits (the demo resets on its own). Refused here, in the route, not by matching its
// path in middleware: the router also takes /api/reset/ and /api/%72eset.
import { fromEnv } from '../hosted.js';

const hosted = Boolean(fromEnv());

export default defineEventHandler(() => {
  if (hosted) throw createError({ statusCode: 404, statusMessage: 'Not found.' });
  resetBooks();
  return { ok: true };
});
