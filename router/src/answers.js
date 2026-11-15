// What a `load` can return besides props. Marked with a registered symbol, so an answer made by
// one copy of this module is recognised by another.
export const ANSWER = Symbol.for('@zubra/router.answer');

/** `return notFound()`: the path has nothing behind it (no such farm). The response is a 404. */
export const notFound = () => ({ [ANSWER]: 'notFound' });

/** `return redirect('/cart')`: send the browser elsewhere (303 unless `status` says otherwise). */
export const redirect = (location, status = 303) => {
  if (typeof location !== 'string' || !location) throw new TypeError("@zubra/router: redirect() needs where to go: redirect('/cart')");
  if (![301, 302, 303, 307, 308].includes(status)) throw new TypeError(`@zubra/router: redirect()'s status is 301, 302, 303, 307 or 308, not ${status}`);
  return { [ANSWER]: 'redirect', location, status };
};

/**
 * `return show('sign-in', { next: '/door' })`: render another component here, at the same URL,
 * in place of the one whose `load` this is (a sign-in form, a "this page is for farmers"
 * notice). `status` is the response's (200 unless given: 401, 403).
 */
export const show = (name, props = {}, { status = 200 } = {}) => {
  if (typeof name !== 'string' || !name) throw new TypeError("@zubra/router: show() needs a component's name: show('sign-in', { next })");
  return { [ANSWER]: 'show', name, props, status };
};
