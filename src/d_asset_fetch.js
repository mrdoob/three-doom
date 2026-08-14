// Browser startup asset loading with explicit failure policies.

import { I_Error } from './i_system.js';

export const D_STARTUP_ASSET_FETCH = Object.freeze({
  defaultIwadProbe: Object.freeze({ label: 'IWAD', failure: 'silent' }),
  requiredIwad: Object.freeze({ label: 'IWAD', failure: 'fatal' }),
  optionalPwad: Object.freeze({ label: 'PWAD', failure: 'warn' }),
  externalDemo: Object.freeze({ label: 'demo', failure: 'warn' }),
});

function failureReason(reason) {
  return String(reason?.message ?? reason);
}

function assetFailure(path, policy, operation, reason, warn, fatal) {
  const detail = failureReason(reason);
  if (policy.failure === 'fatal') {
    const message = `Failed to ${operation} ${path}: ${detail}`;
    fatal(message);
    // Keep required assets fatal even when a test or embedder supplies a
    // diagnostic callback that unexpectedly returns instead of throwing.
    throw new Error(message);
  }
  if (policy.failure === 'warn') {
    const state = operation === 'read' ? 'unreadable' : 'unavailable';
    warn(`Skipping ${state} ${policy.label}`, path, `(${detail})`);
  }
  return null;
}

export async function D_FetchStartupAsset(
  path,
  policy,
  dependencies = {},
) {
  const fetchAsset = dependencies.fetchAsset ?? globalThis.fetch;
  const warn = dependencies.warn ?? ((...args) => console.warn(...args));
  const fatal = dependencies.fatal ?? I_Error;

  let response;
  try {
    response = await fetchAsset(path);
  } catch (error) {
    return assetFailure(path, policy, 'load', error, warn, fatal);
  }
  if (!response.ok) {
    return assetFailure(path, policy, 'load', response.status, warn, fatal);
  }
  try {
    return { name: path, buffer: await response.arrayBuffer() };
  } catch (error) {
    return assetFailure(path, policy, 'read', error, warn, fatal);
  }
}
