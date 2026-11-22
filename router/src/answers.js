// What a `load` can return besides props. Marked with a registered symbol, so an answer made by
// one copy of this module is recognised by another.
import { RouteError } from './table.js';

export const ANSWER = Symbol.for('@zubra/router.answer');

/** Normalize local redirects and require explicit permission to leave the site. */
export function checkedLocation({ location, external }, url) {
  if (/[\x00-\x1f\x7f]/.test(location)) throw new RouteError('redirect() location contains a control character');
  if (/^[/\\]/.test(location)) return '/' + location.replace(/^[/\\]+/, '');
  let target;
  try {
    target = new URL(location, url);
  } catch {
    throw new RouteError(`redirect() to ${JSON.stringify(location)}: not a URL`);
  }
  if (!['http:', 'https:'].includes(target.protocol)) throw new RouteError(`redirect() to a ${target.protocol} URL is refused`);
  if (target.origin !== url.origin && !external) throw new RouteError(`redirect() to ${target.origin}, another site: say redirect(to, { external: true }) if that's meant`);
  // A path on this site that begins `//` (from `https://site//evil.example`, `.//evil.example` or
  // `..//evil.example`) is protocol-relative in a Location header: one slash keeps it here.
  return target.origin === url.origin ? '/' + (target.pathname + target.search + target.hash).replace(/^[/\\]+/, '') : target.href;
}

/** `return notFound()`: the path has nothing behind it (no such farm). The response is a 404. */
export const notFound = () => ({ [ANSWER]: 'notFound' });

/**
 * `return redirect('/cart')`: send the browser elsewhere (303 unless `status` says otherwise).
 * Only on this site: another site needs `redirect(url, { external: true })` (or
 * `redirect(url, 302, { external: true })`), so a `next` taken from the query string can't send
 * a visitor off it.
 */
export const redirect = (location, status = 303, { external = false } = {}) => {
  if (status && typeof status === 'object') ({ status = 303, external = false } = status);
  if (typeof location !== 'string' || !location) throw new TypeError("@zubra/router: redirect() needs where to go: redirect('/cart')");
  if (![301, 302, 303, 307, 308].includes(status)) throw new TypeError(`@zubra/router: redirect()'s status is 301, 302, 303, 307 or 308, not ${status}`);
  return { [ANSWER]: 'redirect', location, status, external: Boolean(external) };
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
