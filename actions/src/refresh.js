// EXPERIMENTAL (a prototype on experiment/next; not exported from the package yet).
//
// A plain form post without the reload. The form still posts to the app's own route and the server
// still answers with a redirect back to the page. A form that says which parts of the page its
// post changes, by id, is sent with fetch instead, and those parts are taken from the new page:
//
//   <form method="post" action="/add" data-zb-refresh="site said">…</form>
//   <nav id="site">…Your order (2)…</nav>
//   <div id="said" role="status">…Added to your order.…</div>
//
// Only a part's children change, so the element itself (a live region, say) stays. Everything else
// on the page, components and their state included, is left alone. Without this script, or without
// JavaScript, the same form posts as it always did; so does any form without the attribute.
//
// It steps aside (the browser's own post, or a normal navigation) when the answer is another page
// or a named part is missing from either page, and it leaves alone forms that aren't same-origin posts,
// `data-zb-native` forms, and @zubra/actions' own forms.
const native = new WeakSet();

async function submit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || event.defaultPrevented || native.has(form) || form.hasAttribute('data-zb-native')) return;
  const ids = (form.getAttribute('data-zb-refresh') ?? '').split(/\s+/).filter(Boolean);
  if (!ids.length || ids.some((id) => !document.getElementById(id))) return;
  const submitter = event.submitter;
  const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase();
  const action = new URL(submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? '', location.href);
  if (method !== 'post' || action.origin !== location.origin || action.pathname.startsWith('/_zb/action/')) return;
  if ((submitter?.getAttribute('formtarget') ?? form.target ?? '') !== '') return;
  event.preventDefault();
  const data = new FormData(form, submitter ?? undefined);
  const multipart = (submitter?.getAttribute('formenctype') ?? form.enctype) === 'multipart/form-data';
  form.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(action, { method: 'POST', body: multipart ? data : new URLSearchParams(data), headers: { accept: 'text/html' } });
    const to = new URL(response.url);
    const html = (response.headers.get('content-type') ?? '').includes('text/html');
    const here = to.origin === location.origin && to.pathname === location.pathname;
    if (!html || !here) {
      // Another page. After a redirect, go there as the browser would have. A post answered with
      // a page of its own (no redirect) can't be asked for again without posting twice, so that
      // page is shown as it came.
      if (response.redirected || !html) return void location.assign(to);
      const text = await response.text();
      history.pushState(null, '', to);
      document.open();
      document.write(text);
      document.close();
      return;
    }
    const next = new DOMParser().parseFromString(await response.text(), 'text/html');
    if (ids.some((id) => !next.getElementById(id))) {
      location.assign(to);
      return;
    }
    for (const id of ids) {
      const part = document.getElementById(id);
      const fresh = next.getElementById(id);
      if (fresh.innerHTML !== part.innerHTML) part.replaceChildren(...document.importNode(fresh, true).childNodes);
    }
    if (next.title) document.title = next.title;
    history.replaceState(history.state, '', to);
    form.dispatchEvent(new CustomEvent('refresh', { bubbles: true, detail: { url: to.href } }));
  } catch {
    // Offline or a failed request: let the browser do it, and show its own error.
    native.add(form);
    form.requestSubmit(submitter ?? undefined);
    native.delete(form);
  } finally {
    form.removeAttribute('aria-busy');
  }
}

/** Listen for form posts under `root` (the document by default; pass a shadow root for forms inside one). */
export function refresh(root = document) {
  root.addEventListener('submit', submit);
  return () => root.removeEventListener('submit', submit);
}

if (typeof document !== 'undefined') refresh();
