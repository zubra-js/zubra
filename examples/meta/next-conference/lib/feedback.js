// Feedback, kept in the server's memory (a real app would use a database). As a hosted demo
// (lib/hosted.js), it keeps the latest MAX_RATINGS per talk and starts over every reset period.
import { epoch, fromEnv, MAX_RATINGS } from './hosted.js';

/** `hosted`: { resetMinutes, maxRatings, now }, or null to keep everything for good. */
export function createFeedback(hosted = null) {
  const store = new Map();
  const { resetMinutes = 1440, maxRatings = MAX_RATINGS, now = Date.now } = hosted ?? {};
  let period = hosted ? epoch(now(), resetMinutes) : 0;
  const current = () => {
    if (hosted && epoch(now(), resetMinutes) !== period) {
      period = epoch(now(), resetMinutes);
      store.clear();
    }
    return store;
  };

  return {
    addFeedback(sessionId, entry) {
      const list = current().get(sessionId) ?? [];
      list.push({ ...entry, at: Date.now() });
      if (hosted && list.length > maxRatings) list.splice(0, list.length - maxRatings);
      store.set(sessionId, list);
    },
    summary(sessionId) {
      const list = current().get(sessionId) ?? [];
      const average = list.length ? list.reduce((sum, entry) => sum + entry.rating, 0) / list.length : 0;
      return { count: list.length, average: Math.round(average * 10) / 10, followups: list.filter((entry) => entry.followup).length };
    },
  };
}

// One store for the server, shared by the action's and the page's bundles.
const feedback = globalThis.__feedback ??= createFeedback(fromEnv());

export const addFeedback = (sessionId, entry) => feedback.addFeedback(sessionId, entry);
export const summary = (sessionId) => feedback.summary(sessionId);
