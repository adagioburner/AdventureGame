/**
 * [Q300, 3 to 5] What every check of a post on the site's board shares: its
 * verdict, its time limit, and how the board's checks are put together. Llama
 * Guard (`llama-guard.ts`) and the check for slurs and insults
 * (`insult-check.ts`) both see every post.
 */

/** How long a post waits for a check before it is refused with "try again later". */
export const CHECK_TIMEOUT_MS = 10_000;

export type PostVerdict = 'safe' | 'flagged' | 'unchecked';

/** Checks one post's words. Never throws. */
export type PostCheck = (body: string) => Promise<PostVerdict>;

/**
 * Runs one model call against `timeoutMs`. Anything but a clear answer,
 * including an error or no answer in time, is `unchecked` (4 A).
 */
export async function timedCheck<T>(ask: () => Promise<T>, read: (output: T) => PostVerdict, timeoutMs: number): Promise<PostVerdict> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timeoutMs);
  });
  try {
    const output = await Promise.race([ask(), late]);
    return output === 'late' ? 'unchecked' : read(output);
  } catch (error) {
    console.error('the post could not be checked', error);
    return 'unchecked';
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * [Q300, 5] Every check sees the post at once. It is refused as offensive
 * when any of them flags it, and with "try again later" when none flags it
 * but one could not run (4 A); it goes on the board only when all say it is
 * safe.
 */
export function everyCheck(...checks: readonly PostCheck[]): PostCheck {
  return async (body) => {
    const verdicts = await Promise.all(checks.map((check) => check(body)));
    if (verdicts.includes('flagged')) return 'flagged';
    if (verdicts.includes('unchecked')) return 'unchecked';
    return 'safe';
  };
}
