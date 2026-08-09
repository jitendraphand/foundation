import { LlmError, chatComplete, type ChatRequest, type ChatResponse } from './providers.js';

/**
 * Surviving endpoints that are free, busy, or both.
 *
 * The cheap and free tiers - OpenRouter's :free models, NVIDIA's build tier,
 * Hugging Face's shared router - are genuinely useful for a school with no
 * budget, and genuinely unreliable. They rate-limit under load, they return
 * 503 while a model is loading, and they occasionally just drop the
 * connection. None of that means the credential is wrong, but a single attempt
 * reports it as though it were, and a fifty-question run that dies on batch
 * four wastes the three that worked.
 *
 * Two mechanisms, deliberately separate:
 *
 *   retry     the same endpoint again, backing off, for failures that are
 *             plainly transient. Costs only time.
 *   fallback  a different credential entirely, for failures that are not.
 *             Costs whatever the next provider costs, so it is opt-in and
 *             ordered by the administrator.
 */

/**
 * Whether waiting and trying again could plausibly help.
 *
 * Deliberately narrow. Retrying a 401 wastes a minute and still fails;
 * retrying a 400 about a bad model id does the same. Both are configuration,
 * and telling the admin immediately is more useful than persistence.
 */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof LlmError)) return false;

  // No status at all means the request never completed: DNS, connection
  // reset, or our own timeout. All worth another go.
  if (err.status === undefined) {
    return /could not reach|did not respond within|network|socket|timeout|fetch failed/i.test(err.message);
  }

  // 429 rate limit; 500/502/503/504 the far side having a bad day.
  // 408 request timeout. 529 is Anthropic's "overloaded".
  return [408, 429, 500, 502, 503, 504, 529].includes(err.status);
}

/**
 * How long to wait before attempt n, in milliseconds.
 *
 * Exponential with full jitter. The jitter matters more than it looks: a class
 * of batches failing together would otherwise retry in lockstep and rate-limit
 * each other all over again.
 */
export function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  // A provider that says how long to wait is believed, within reason - some
  // send minutes, which is longer than anyone will sit and watch.
  if (retryAfterSeconds && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 60_000);
  }
  const ceiling = Math.min(1000 * 2 ** attempt, 30_000);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** Parsed out of a 429 body or header when the provider offers one. */
export function retryAfterFrom(err: unknown): number | undefined {
  if (!(err instanceof LlmError) || !err.body) return undefined;
  const m = /"?retry[_-]?after"?\s*[:=]\s*"?(\d+(?:\.\d+)?)/i.exec(err.body);
  return m ? Number(m[1]) : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface AttemptNote {
  credentialLabel: string;
  attempt: number;
  waitedMs?: number;
  error: string;
  /** The failure itself, so a caller can inspect its status and body. */
  cause?: unknown;
}

/**
 * Thrown when every candidate has failed.
 *
 * Carries the individual failures, not just the summary, because a caller may
 * need to know which credential produced which error - learning an output-token
 * ceiling from a fallback provider's refusal and storing it against the
 * administrator's chosen credential would be worse than not learning it at all.
 */
export class ProviderChainError extends LlmError {
  constructor(message: string, readonly notes: AttemptNote[], status?: number, body?: string) {
    super(message, status, body);
    this.name = 'ProviderChainError';
  }
}

export interface ResilientOptions {
  /**
   * The credentials to try, in order. The first is what the administrator
   * asked for; the rest are fallbacks, used only once the first has exhausted
   * its retries.
   */
  candidates: Array<{ label: string; model: string; call: Omit<ChatRequest, 'model' | 'messages'> }>;
  /** Attempts per candidate, including the first. */
  maxAttempts?: number;
  /** Called after each failure, so a long run can report progress. */
  onRetry?: (note: AttemptNote) => void;
}

/**
 * One chat call, with retries and then fallbacks.
 *
 * Returns which candidate succeeded, so the caller can say "batch 3 fell back
 * to OpenRouter" rather than silently producing questions from a model nobody
 * chose.
 */
export async function chatWithFallback(
  messages: ChatRequest['messages'],
  options: ResilientOptions,
): Promise<{ response: ChatResponse; usedLabel: string; usedModel: string; notes: AttemptNote[] }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const notes: AttemptNote[] = [];
  let lastError: unknown;

  for (const candidate of options.candidates) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await chatComplete({ ...candidate.call, model: candidate.model, messages });
        return { response, usedLabel: candidate.label, usedModel: candidate.model, notes };
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);

        // Configuration errors do not improve with patience: stop retrying
        // this credential and let the next one have a go.
        if (!isTransient(err)) {
          notes.push({ credentialLabel: candidate.label, attempt, error: message, cause: err });
          break;
        }

        // Out of attempts on this credential.
        if (attempt === maxAttempts) {
          notes.push({ credentialLabel: candidate.label, attempt, error: message, cause: err });
          break;
        }

        const waitedMs = backoffMs(attempt, retryAfterFrom(err));
        notes.push({ credentialLabel: candidate.label, attempt, waitedMs, error: message, cause: err });
        options.onRetry?.(notes[notes.length - 1]);
        await sleep(waitedMs);
      }
    }
  }

  // Everything failed. Report the last real error, with the trail attached so
  // an admin can see it was not one unlucky request.
  const trail = notes
    .map((n) => `  ${n.credentialLabel} attempt ${n.attempt}: ${n.error}`)
    .join('\n');

  throw new ProviderChainError(
    `Every provider failed.\n${trail}`,
    notes,
    lastError instanceof LlmError ? lastError.status : undefined,
    lastError instanceof LlmError ? lastError.body : undefined,
  );
}
