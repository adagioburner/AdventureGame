import type { AccountRules } from './accounts.ts';

/**
 * [Q48, 2 to 4] Andrei's account rules for v1.
 *
 * - A username is 3 to 20 letters, digits or underscores, and capitals do not
 *   make a different name: "Andrei" and "andrei" are one account.
 * - A password is at least 8 characters, with nothing else required. There is
 *   no email address, so a forgotten password cannot be reset.
 * - A login lasts 30 days on the browser that made it, or until Log out.
 *
 * Letters are any alphabet's, not only A to Z. The 200-character ceiling on a
 * password is not one of his rules; it only stops a request from making the
 * server hash megabytes.
 */
const USERNAME = /^[\p{L}0-9_]{3,20}$/u;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const ACCOUNT_RULES: AccountRules = {
  canonicalUsername: (username) => username.toLowerCase(),
  usernameProblem: (username) =>
    USERNAME.test(username) ? null : 'A username is 3 to 20 letters, digits or underscores.',
  passwordProblem: (password) => {
    if (password.length < PASSWORD_MIN) return `A password needs at least ${PASSWORD_MIN} characters.`;
    if (password.length > PASSWORD_MAX) return `A password can have at most ${PASSWORD_MAX} characters.`;
    return null;
  },
  loginLifetimeMs: THIRTY_DAYS_MS,
};
