// Browser-facing startup diagnostics. Keep this module independent of the
// game runtime so it remains available when importing the runtime itself
// fails.

export const I_STARTUP_ERROR_ID = 'doom-startup-error';

export function I_StartupErrorDetail(error) {
  try {
    if (error instanceof Error) {
      const message = typeof error.message === 'string' ? error.message : '';
      const name = typeof error.name === 'string' ? error.name : '';
      if (message.length !== 0) return message;
      if (name.length !== 0) return name;
      return 'Unknown error';
    }
    const detail = String(error);
    return detail.length === 0 ? 'Unknown error' : detail;
  } catch (_error) {
    return 'Unknown error';
  }
}

function style(element, properties) {
  Object.assign(element.style, properties);
}

function makeElement(documentObject, tagName, text) {
  const element = documentObject.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  return element;
}

function stopGameInput(event) {
  event.stopPropagation();
}

export function I_ShowStartupError(
  error,
  documentObject = globalThis.document,
  retry = () => documentObject.defaultView?.location.reload(),
) {
  if (documentObject?.body == null) return null;

  let panel = documentObject.getElementById(I_STARTUP_ERROR_ID);
  if (panel === null) {
    panel = makeElement(documentObject, 'main');
    panel.id = I_STARTUP_ERROR_ID;
    panel.setAttribute('role', 'alert');
    panel.setAttribute('aria-live', 'assertive');
    panel.setAttribute('aria-atomic', 'true');
    panel.setAttribute('aria-labelledby', `${I_STARTUP_ERROR_ID}-title`);
    panel.tabIndex = -1;
    // Graphics may already own document/window input when a late startup
    // import fails. Keep those handlers from cancelling Tab or Enter while
    // retaining the browser's normal keyboard behavior inside this panel.
    panel.addEventListener('keydown', stopGameInput);
    panel.addEventListener('keyup', stopGameInput);
    panel.addEventListener('click', stopGameInput);
    style(panel, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      boxSizing: 'border-box',
      display: 'grid',
      placeItems: 'center',
      overflow: 'auto',
      padding: '32px',
      background: '#090909',
      color: '#f2f2f2',
      fontFamily: 'monospace',
    });

    const card = makeElement(documentObject, 'section');
    style(card, { width: 'min(100%, 640px)' });

    const title = makeElement(documentObject, 'h1', 'DOOM failed to start');
    title.id = `${I_STARTUP_ERROR_ID}-title`;
    style(title, {
      margin: '0 0 16px',
      color: '#ff4d4d',
      fontSize: 'clamp(24px, 6vw, 44px)',
    });

    const message = makeElement(
      documentObject,
      'p',
      'Check the URL or WAD path, then try again.',
    );
    style(message, { margin: '0 0 16px', fontSize: '16px' });

    const detail = makeElement(documentObject, 'pre');
    detail.dataset.startupErrorDetail = '';
    style(detail, {
      boxSizing: 'border-box',
      margin: '0 0 24px',
      padding: '16px',
      overflowWrap: 'anywhere',
      whiteSpace: 'pre-wrap',
      background: '#1a1a1a',
      border: '1px solid #555',
      color: '#fff',
    });

    const button = makeElement(documentObject, 'button', 'Retry');
    button.type = 'button';
    style(button, {
      padding: '10px 18px',
      border: '1px solid #aaa',
      background: '#222',
      color: '#fff',
      font: 'inherit',
      cursor: 'pointer',
    });
    button.addEventListener('click', retry);

    card.append(title, message, detail, button);
    panel.append(card);
    documentObject.body.append(panel);
  }

  const detail = panel.querySelector('[data-startup-error-detail]');
  if (detail !== null) detail.textContent = I_StartupErrorDetail(error);
  try {
    panel.focus({ preventScroll: true });
  } catch (_error) {
    panel.focus();
  }
  return panel;
}
