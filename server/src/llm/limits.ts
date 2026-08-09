import type { ApiCredential } from '@prisma/client';
import { prisma } from '../db.js';
import { LlmError, PROVIDERS } from './providers.js';

/**
 * How large a completion each provider will accept a request for.
 *
 * Every provider caps the number of tokens one reply may contain, the cap
 * varies by model, and asking for more is not a soft limit that quietly returns
 * less - most of them reject the entire call with a 400. Oracle Cloud is the
 * one that bit us:
 *
 *   Invalid 'maxTokens': Value is greater than maximum: 4096
 *
 * but every provider has the same class of failure, with different wording, at
 * a different number, that moves whenever a model is added. Hard-coding a table
 * of every model's ceiling would be wrong within a month and silently wrong for
 * anyone pointing `custom` at their own endpoint.
 *
 * So the ceiling comes from four places, and the last one is the one that
 * actually keeps this working:
 *
 *   1. an administrator's explicit override, per credential
 *   2. what we LEARNED from this provider refusing a request, per model
 *   3. a small table of ceilings low enough to bite on the first call
 *   4. the provider-wide default in providers.ts
 *
 * Learning is what makes this general. The first request to a model with an
 * unexpectedly low ceiling fails, the refusal names the real number, that
 * number is stored against the credential, and the run retries immediately with
 * batches sized to fit. Nobody has to know the number in advance and nobody has
 * to touch a table when a provider changes one.
 */

/** Where a credential keeps everything it has been told or has worked out. */
export interface TokenLimitMeta {
  /** An administrator's explicit ceiling. Honoured exactly, high or low. */
  maxOutputTokens?: number;
  /** What each model was observed to refuse above, keyed by model id. */
  tokenCeilings?: Record<string, number>;
}

/**
 * Ceilings low enough that the very first request would hit them.
 *
 * Deliberately short. An entry that is too low costs every future run on that
 * model - more, smaller calls, forever, and nothing says why - while a missing
 * entry costs exactly one failed call before the real number is learned. That
 * asymmetry means the bar for adding a row here is "documented and stable",
 * not "probably about right".
 *
 * Scoped by provider where the same model name means different things in
 * different places: Llama on Bedrock caps far lower than the same weights
 * served by OpenRouter, so an unscoped rule would slow down the wrong one.
 */
const MODEL_CEILINGS: Array<{ provider?: string; pattern: RegExp; ceiling: number }> = [
  // Anthropic on Bedrock. 3.5 doubled the older models' output budget; 4 and
  // later are far above our own 32k cap and so need no entry.
  { provider: 'bedrock', pattern: /claude-3-5-(sonnet|haiku)/i, ceiling: 8192 },
  { provider: 'bedrock', pattern: /claude-3-(?!5)(opus|sonnet|haiku)/i, ceiling: 4096 },
  // Amazon's own models cap at 5k output regardless of their large context.
  { provider: 'bedrock', pattern: /(^|[./])(us\.)?amazon\.nova|(^|[./])nova-(pro|lite|micro)/i, ceiling: 5120 },
];

function metaOf(credential: Pick<ApiCredential, 'meta'>): TokenLimitMeta {
  return (credential.meta ?? {}) as TokenLimitMeta;
}

/**
 * The completion ceiling to respect for this credential and model.
 *
 * `undefined` means "nothing known", which the callers read as "our own 32k cap
 * binds first" - not as "unlimited".
 */
export function resolveCeiling(
  credential: Pick<ApiCredential, 'provider' | 'meta'>,
  model: string,
): number | undefined {
  const meta = metaOf(credential);

  // An administrator who has typed a number knows their deployment; it is used
  // as given, above or below anything we would have guessed. Provisioned
  // throughput and self-hosted endpoints both legitimately differ from the
  // published figure, and second-guessing that would make the field useless.
  if (meta.maxOutputTokens && meta.maxOutputTokens > 0) return meta.maxOutputTokens;

  const candidates = [
    meta.tokenCeilings?.[model],
    MODEL_CEILINGS.find((r) => (!r.provider || r.provider === credential.provider) && r.pattern.test(model))?.ceiling,
    PROVIDERS[credential.provider]?.maxOutputTokens,
  ].filter((n): n is number => typeof n === 'number' && n > 0);

  // The smallest of them: each is a claim that the provider refuses more, and
  // the safe reading of two such claims is the stricter one.
  return candidates.length ? Math.min(...candidates) : undefined;
}

/**
 * The smallest sane ceiling. Below this a question cannot be written at all, so
 * a parsed number under it is far more likely to be a token count from an
 * unrelated part of the message than a real limit.
 */
const MIN_PLAUSIBLE_CEILING = 256;

/**
 * Whether this error is a provider refusing the size of the completion asked
 * for, rather than any of the other things a 400 can mean.
 *
 * Checked before any number is read, because a message about a bad model name
 * or an unsupported parameter can easily contain a four-digit number and
 * "learning" it would cripple that credential permanently.
 */
const ABOUT_TOKEN_BUDGET =
  /max[_ -]?(tokens|completion[_ -]?tokens|new[_ -]?tokens|gen[_ -]?len|output[_ -]?tokens)/i;

/**
 * Every wording a provider uses to say "that is more than I allow".
 *
 * Real examples, in order:
 *   Oracle    Invalid 'maxTokens': Value is greater than maximum: 4096
 *   OpenAI    Invalid 'max_tokens': integer above maximum value. Expected a value <= 16384
 *   OpenAI    max_tokens is too large: 20000. This model supports at most 16384 completion tokens
 *   Anthropic max_tokens: 30000 > 8192, which is the maximum allowed number of output tokens
 *   Mistral   max_tokens must be less than or equal to 8192
 */
const CEILING_PATTERNS: RegExp[] = [
  /maximum(?:\s+allowed)?(?:\s+(?:value|number))?[^0-9]{0,40}?(\d{3,7})/i,
  /<=\s*(\d{3,7})/,
  /at most\s+(\d{3,7})/i,
  /(?:less than or equal to|no (?:more|greater) than|up to)\s+(\d{3,7})/i,
  />\s*(\d{3,7})\s*,?\s*which is the maximum/i,
];

/**
 * The real ceiling, read out of a provider's refusal.
 *
 * `asked` is what the request actually contained: a parsed number that is not
 * smaller than that is not a ceiling we violated - it is some other figure in
 * the message - and taking it would teach the credential something false.
 */
export function ceilingFromError(err: unknown, asked: number): number | undefined {
  if (!(err instanceof LlmError)) return undefined;

  // 400 and 422 are the two ways this arrives. Anything else - 401, 429, 500 -
  // is a different problem and any number in it is a coincidence.
  if (err.status !== undefined && err.status !== 400 && err.status !== 422) return undefined;

  const text = `${err.message}\n${err.body ?? ''}`;
  if (!ABOUT_TOKEN_BUDGET.test(text)) return undefined;

  const found: number[] = [];
  for (const pattern of CEILING_PATTERNS) {
    const m = pattern.exec(text);
    if (m) found.push(Number(m[1]));
  }

  const usable = found.filter((n) => Number.isFinite(n) && n >= MIN_PLAUSIBLE_CEILING && n < asked);
  return usable.length ? Math.min(...usable) : undefined;
}

/**
 * Writes a learned ceiling onto the credential, so the next run starts correct
 * instead of failing the same way again.
 *
 * Merged into meta rather than replacing it: meta also carries the region, the
 * auth mode and the fallback flag, and losing those would break the credential
 * outright. Never widens a ceiling already recorded - a provider that refused
 * 4096 once will refuse it again, and a later refusal at a higher number tells
 * us nothing new.
 */
export async function rememberCeiling(credentialId: string, model: string, ceiling: number): Promise<void> {
  const credential = await prisma.apiCredential.findUnique({ where: { id: credentialId } });
  if (!credential) return;

  const meta = metaOf(credential);
  const existing = meta.tokenCeilings?.[model];
  if (existing !== undefined && existing <= ceiling) return;

  await prisma.apiCredential.update({
    where: { id: credentialId },
    data: {
      meta: {
        ...(credential.meta as object),
        tokenCeilings: { ...(meta.tokenCeilings ?? {}), [model]: ceiling },
      } as never,
    },
  });
}

/** Exposed for the ceiling-parsing checks; not part of the module's API. */
export const __testing = { MODEL_CEILINGS, CEILING_PATTERNS };
