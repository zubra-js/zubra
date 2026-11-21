// A form-associated component (`form-associated`): the API native form controls have, the form
// lifecycle callbacks, and its value and reset when it has one two-way prop. Its module imports
// this (`forming: $form`), so a page whose components aren't form controls doesn't load it.
import { effect } from './effect.js';
import { $r, hooks, see } from './element.js';
import { untrack } from './signal.js';

// The last formDisabledCallback before the element's setup registered its hooks.
// Chromium always calls it after connectedCallback, so there this is never used (the browser
// tests confirm the behaviour without it). Safari and Firefox can call it first, including
// with `false`: the value itself is replayed once the hooks exist, not only `true`.
const disabledEarly = new WeakMap();

/** @internal What interface 4 output names as `forming` for a form-associated component. */
export const $form = {
  /** On the class, before it's defined: the API and the callbacks the browser looks up then. */
  define(Element, { internals, hooksOf, props }) {
    const api = {
      form: { get() { return internals(this).form; } },
      validity: { get() { return internals(this).validity; } },
      validationMessage: { get() { return internals(this).validationMessage; } },
      willValidate: { get() { return internals(this).willValidate; } },
      labels: { get() { return internals(this).labels; } },
      checkValidity: { value() { return internals(this).checkValidity(); } },
      reportValidity: { value() { return internals(this).reportValidity(); } },
      formResetCallback: { value() { for (const fn of hooksOf(this)?.formReset ?? []) fn(); } },
      formStateRestoreCallback: { value(state, mode) { for (const fn of hooksOf(this)?.formRestore ?? []) fn(state, mode); } },
      formDisabledCallback: {
        value(disabled) {
          const hooks = hooksOf(this);
          if (!hooks) {
            disabledEarly.set(this, disabled);
            return;
          }
          disabledEarly.delete(this);
          for (const fn of hooks.formDisabled) fn(disabled);
        },
      },
    };
    if (!('name' in props)) {
      api.name = {
        get() { return this.getAttribute('name'); },
        set(value) { this.setAttribute('name', value); },
      };
    }
    for (const [key, descriptor] of Object.entries(api)) {
      Object.defineProperty(Element.prototype, key, { ...descriptor, configurable: true });
    }
  },
  /**
   * Before rendering: the server's stand-in for this control's value, for submitting before
   * JavaScript (@zubra/server's injectShadowRoots), goes; the element's own form value takes over.
   */
  begin(element) {
    for (const child of element.querySelectorAll(':scope>input[data-zb-fallback]')) child.remove();
  },
  /**
   * After the script ran: a form control with one two-way prop submits that, and a form reset
   * restores it, unless the script says otherwise.
   */
  model(hooks, $p, props, internals) {
    const models = Object.keys(props).filter((name) => props[name].model);
    if (models.length !== 1) return;
    const [name] = models;
    if (!hooks.formValued) {
      effect(() => {
        const value = $p[name];
        internals.setFormValue(value == null || value === false || value === ''
          ? null
          : value === true ? 'on' : typeof value === 'object' ? JSON.stringify(value) : String(value));
      });
    }
    if (!hooks.formReset.length) {
      const initialValue = untrack(() => $p[name]);
      hooks.formReset.push(() => { $p[name] = initialValue; });
    }
  },
  /** Once rendered: disabled before the hooks existed. */
  end(element, hooks) {
    if (!disabledEarly.has(element)) return;
    const disabled = disabledEarly.get(element);
    disabledEarly.delete(element);
    for (const fn of hooks.formDisabled) fn(disabled);
  },
};

// ---- the helpers a form-associated component's script calls --------------------------------
//
// With `form-associated` on the host, the element is a form control built on the platform's
// ElementInternals: it submits a value, takes part in validation, reset and restore, and is
// disabled by a disabled <fieldset> — and exposes the same API as native controls.

function formHooks(name) {
  const component = hooks(name);
  if (!component.internals) {
    throw new Error(`zubra: ${name}() needs form-associated on the component's host tag${see('forms')}`);
  }
  return component;
}

/** What the form submits for this control: follows `source` (a signal, function or value). */
export function formValue(source) {
  const component = formHooks('formValue');
  const { internals } = component;
  component.formValued = true;
  effect(() => {
    const value = $r(typeof source === 'function' ? source() : source);
    internals.setFormValue(value == null ? null : value instanceof FormData || value instanceof File ? value : String(value));
  });
}

/**
 * Validation: `check()` returns an error message, or '' / null when the value is valid. Re-runs
 * when what it reads changes; the form won't submit while it reports an error.
 */
const FOCUSABLE = 'input:not([type=hidden]), select, textarea, button, [tabindex]:not([tabindex="-1"]), [contenteditable]';

export function validity(check) {
  const component = formHooks('validity');
  const { internals, host } = component;
  // The browser shows the message at the anchor and focuses it when a form won't submit: the
  // first focusable element the component rendered. The host itself is not a safe anchor —
  // Safari throws NotFoundError from setValidity unless the anchor is a focusable
  // shadow-including descendant — and the first run is before the template is inserted.
  // No anchor lets the browser use the element.
  const anchor = () => {
    for (const node of (host.shadowRoot ?? host).querySelectorAll(FOCUSABLE)) {
      if (!node.closest('[data-zb-slotted]')) return node;
    }
    return host.matches?.(FOCUSABLE) ? host : undefined;
  };
  let message = '';
  const apply = () => {
    const node = anchor();
    try {
      if (message) internals.setValidity({ customError: true }, message, node);
      else internals.setValidity({});
    } catch (error) {
      if (!message) throw error;
      internals.setValidity({ customError: true }, message);
    }
  };
  effect(() => {
    message = String($r(check()) || '');
    apply();
  });
  component.mount.push(apply); // once rendered, the anchor is inside
}

/** The form was reset. */
export function onFormReset(fn) {
  formHooks('onFormReset').formReset.push(fn);
}

/** The browser restored a value (back/forward navigation, autofill): `fn(state, mode)`. */
export function onFormRestore(fn) {
  formHooks('onFormRestore').formRestore.push(fn);
}

/** The control was disabled or enabled (its own attribute, or a disabled <fieldset>). */
export function onFormDisabled(fn) {
  formHooks('onFormDisabled').formDisabled.push(fn);
}
