/**
 * [Q300, 3 to 5] The site board's check: Meta's Llama Guard 3 on Cloudflare
 * Workers AI, through the Worker's `AI` binding, so the check runs on the
 * same Cloudflare account as the site and needs no other service or key.
 *
 * The post goes in as the one user message, and Llama Guard answers whether
 * it is safe against its own fixed list of hazards (hate, sexual content,
 * violent and other crimes, self-harm and the like). That list has no insults
 * or swearing, and Cloudflare offers no way to add to it (5 A: Llama Guard
 * alone to start).
 *
 * Anything but a clear answer, including an error or no answer within
 * `CHECK_TIMEOUT_MS`, is `unchecked`. On the free plan an account has 10,000
 * neurons a day, and past that every call fails until 00:00 UTC, which is
 * also `unchecked` (4 A).
 */

export const LLAMA_GUARD_MODEL = '@cf/meta/llama-guard-3-8b';

/** How long a post waits for the check before it is refused with "try again later". */
export const CHECK_TIMEOUT_MS = 10_000;

export type PostVerdict = 'safe' | 'flagged' | 'unchecked';

/** Checks one post's words. Never throws. */
export type PostCheck = (body: string) => Promise<PostVerdict>;

/**
 * The part of the Workers AI binding the check uses, with the model's input
 * and output as `@cloudflare/workers-types` describes them, written out so the
 * tests that run under Node can see them too.
 */
export interface LlamaGuardRunner {
  run(model: typeof LLAMA_GUARD_MODEL, input: LlamaGuardInput): Promise<LlamaGuardOutput>;
}

export interface LlamaGuardInput {
  messages: { role: 'user' | 'assistant'; content: string }[];
  response_format?: { type?: string };
}

export interface LlamaGuardOutput {
  response?: string | { safe?: boolean; categories?: string[] };
}

export function llamaGuardCheck(ai: LlamaGuardRunner, timeoutMs = CHECK_TIMEOUT_MS): PostCheck {
  return async (body) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), timeoutMs);
    });
    try {
      const output = await Promise.race([
        ai.run(LLAMA_GUARD_MODEL, {
          messages: [{ role: 'user', content: body }],
          response_format: { type: 'json_object' },
        }),
        late,
      ]);
      return output === 'late' ? 'unchecked' : verdictOf(output);
    } catch (error) {
      console.error('the post could not be checked', error);
      return 'unchecked';
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };
}

/**
 * Asked for JSON, Llama Guard answers `{ safe, categories }`; without it, the
 * model's own text, "safe" or "unsafe" and the categories on the next line.
 * Both are read, and the JSON as text too, so a change on Cloudflare's side
 * neither lets posts through nor refuses them all as offensive.
 */
export function verdictOf(output: LlamaGuardOutput): PostVerdict {
  const response = output.response;
  if (typeof response === 'object' && typeof response.safe === 'boolean') return response.safe ? 'safe' : 'flagged';
  if (typeof response === 'string') {
    const text = response.trim();
    if (text.startsWith('{')) {
      try {
        return verdictOf({ response: JSON.parse(text) as NonNullable<LlamaGuardOutput['response']> });
      } catch {
        // Not JSON after all; read as text below.
      }
    }
    const first = text.split(/\s+/)[0]?.toLowerCase();
    if (first === 'safe') return 'safe';
    if (first === 'unsafe') return 'flagged';
  }
  console.error('the check gave no verdict', JSON.stringify(output));
  return 'unchecked';
}
