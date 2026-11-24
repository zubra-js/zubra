// The trip's expenses, in memory (one trip, for the example). As a hosted demo (hosted.server.js)
// they go back to the seed every `resetMinutes`, at midnight UTC by default, and hold at most
// MAX_EXPENSES short ones.
import { fromEnv, MAX_CENTS, MAX_EXPENSES, MAX_TEXT } from './hosted.server.js';

export const PEOPLE = ['Ana', 'Ben', 'Chloé', 'Dev'];
export const CATEGORIES = ['food', 'lodging', 'travel', 'fun'];

const SEED = [
  { what: 'Cabin, two nights', category: 'lodging', cents: 48000, paidBy: 'Ana', split: PEOPLE },
  { what: 'Groceries', category: 'food', cents: 13250, paidBy: 'Ben', split: PEOPLE },
  { what: 'Gas', category: 'travel', cents: 6400, paidBy: 'Dev', split: ['Ana', 'Dev'] },
];
let expenses;
let next;
let demo;
let epoch;
export function reset() {
  next = 1;
  expenses = SEED.map((expense) => ({ id: next++, ...expense, split: [...expense.split] }));
  epoch = demo ? Math.floor(demo.now() / (demo.resetMinutes * 60_000)) : 0;
}

/** Makes the trip a hosted demo (`{ resetMinutes, now }`), or not (null), from its seed. */
export function hostDemo(settings) {
  demo = settings && { resetMinutes: 1440, now: Date.now, ...settings };
  reset();
}
hostDemo(fromEnv());
export const isDemo = () => Boolean(demo);

// A hosted demo's period has passed: back to the seed before anyone reads or writes.
function current() {
  if (demo && Math.floor(demo.now() / (demo.resetMinutes * 60_000)) !== epoch) reset();
  return expenses;
}

export const list = () => current();
export function add(expense) {
  expenses = [...current(), { id: next++, ...expense }];
}
export function remove(id) {
  expenses = current().filter((expense) => expense.id !== id);
}

/** What a hosted demo refuses beyond the form's own checks: long text, huge sums, a full trip. */
export function demoErrors(expense) {
  const errors = {};
  if (!demo) return errors;
  if (expense.what.length > MAX_TEXT) errors.what = `At most ${MAX_TEXT} characters.`;
  if (expense.cents > MAX_CENTS) errors.amount = `At most $${(MAX_CENTS / 100).toLocaleString('en-US')}.`;
  if (current().length >= MAX_EXPENSES) errors.form = `The demo holds ${MAX_EXPENSES} expenses: delete one first.`;
  return errors;
}

/** Each person's balance in cents: what they paid, minus their share of what they were in on. */
export function balances() {
  const totals = Object.fromEntries(PEOPLE.map((name) => [name, 0]));
  for (const { cents, paidBy, split } of current()) {
    totals[paidBy] += cents;
    const share = Math.floor(cents / split.length);
    split.forEach((name, index) => (totals[name] -= share + (index < cents - share * split.length ? 1 : 0)));
  }
  return PEOPLE.map((name) => ({ name, cents: totals[name] }));
}
