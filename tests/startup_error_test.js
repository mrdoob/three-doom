import {
  I_ShowStartupError,
  I_STARTUP_ERROR_ID,
  I_StartupErrorDetail,
} from '../src/i_startup_error.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.id = '';
    this.focused = false;
    this.listeners = new Map();
  }

  append(...children) {
    this.children.push(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  focus() {
    this.focused = true;
  }

  querySelector(selector) {
    if (selector === '[data-startup-error-detail]' &&
        Object.hasOwn(this.dataset, 'startupErrorDetail')) {
      return this;
    }
    for (const child of this.children) {
      const result = child.querySelector(selector);
      if (result !== null) return result;
    }
    return null;
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body', this);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    const visit = (element) => {
      if (element.id === id) return element;
      for (const child of element.children) {
        const result = visit(child);
        if (result !== null) return result;
      }
      return null;
    };
    return visit(this.body);
  }
}

Deno.test('startup error details are useful for Error and unusual thrown values', () => {
  assert(I_StartupErrorDetail(new URIError('URI malformed')) === 'URI malformed',
    'Error message was not preserved');
  assert(I_StartupErrorDetail(new Error('')) === 'Error',
    'empty Error did not fall back to its name');
  assert(I_StartupErrorDetail('missing.wad') === 'missing.wad',
    'string failure was not preserved');
  assert(I_StartupErrorDetail('') === 'Unknown error',
    'empty failure did not get a useful fallback');
  assert(I_StartupErrorDetail({ toString() { throw new Error('bad conversion'); } }) ===
    'Unknown error', 'unprintable failure did not get a useful fallback');
});

Deno.test('startup error view is accessible, reusable, and treats detail as text', () => {
  const documentObject = new FakeDocument();
  let retries = 0;
  const injection = '<img id="startup-injected" src=x>';
  const panel = I_ShowStartupError(injection, documentObject, () => { retries++; });

  assert(panel.id === I_STARTUP_ERROR_ID, 'startup alert has the wrong id');
  assert(panel.attributes.get('role') === 'alert', 'startup alert role is missing');
  assert(panel.attributes.get('aria-live') === 'assertive', 'startup alert is not live');
  assert(panel.attributes.get('aria-atomic') === 'true', 'startup alert is not atomic');
  assert(panel.focused, 'startup alert did not receive focus');
  const detail = panel.querySelector('[data-startup-error-detail]');
  assert(detail?.textContent === injection, 'diagnostic detail was not assigned as text');
  assert(documentObject.getElementById('startup-injected') === null,
    'diagnostic detail created injected markup');

  let stopped = 0;
  panel.listeners.get('keydown')({ stopPropagation() { stopped++; } });
  panel.listeners.get('keyup')({ stopPropagation() { stopped++; } });
  panel.listeners.get('click')({ stopPropagation() { stopped++; } });
  assert(stopped === 3, 'startup alert leaked input to the game handlers');

  const button = panel.children[0].children[3];
  button.listeners.get('click')();
  assert(retries === 1, 'Retry did not invoke the reload callback');

  const second = I_ShowStartupError(new Error('second failure'), documentObject);
  assert(second === panel, 'repeated failures created another startup alert');
  assert(documentObject.body.children.length === 1, 'startup alert was duplicated');
  assert(detail.textContent === 'second failure', 'repeated failure did not update detail');
});
