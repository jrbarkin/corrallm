import type { TurnReason } from '../../shared/session';

/*
 * The errors Claude Code ends a turn with, as both connections hear them: an assistant message's
 * `error` (the Agent SDK's) and a StopFailure hook's (Terminal's). Claude Code 2.1.302 names them
 * authentication_failed, oauth_org_not_allowed, account_on_hold, verification_required,
 * billing_error, cloud_credential_error, rate_limit, overloaded, invalid_request, model_not_found,
 * server_error, max_output_tokens and unknown.
 */

/** Errors that mean Claude Code is not logged in, or its login no longer works. */
const LOGIN_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'cloud_credential_error',
  'verification_required',
]);
/** Errors that mean the account can't be used as it is, logged in or not. */
const ACCOUNT_ERRORS = new Set(['account_on_hold', 'billing_error']);

/** Whether Claude Code's error says it must log in (again). */
export function isLoginError(error: string): boolean {
  return LOGIN_ERRORS.has(error);
}

/** Why a turn failed, from Claude Code's error: its login or account, a usage limit, or the API. */
export function claudeFailure(error: string): TurnReason {
  if (LOGIN_ERRORS.has(error) || ACCOUNT_ERRORS.has(error)) return 'auth';
  return error === 'rate_limit' ? 'usage-limit' : 'api';
}
