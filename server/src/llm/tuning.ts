import { z } from 'zod';
import type { ApiCredential } from '@prisma/client';

/**
 * The per-model knobs, as data.
 *
 * build.nvidia.com hands out a different Python snippet for every model, and
 * the difference is never the protocol - it is the same base URL, the same
 * /chat/completions, the same OpenAI shape. Exactly three things vary:
 *
 *   1. the sampling defaults the vendor recommends (temperature, top_p, seed)
 *   2. vendor extensions in extra_body, such as
 *      {"chat_template_kwargs":{"enable_thinking":true},"reasoning_budget":16384}
 *   3. how the reply is read - delta.content alone, or delta.reasoning_content
 *      as well
 *
 * All three are settings, so all three belong here rather than in a growing
 * pile of per-model special cases in the code. Pasting one line from the
 * vendor's snippet into a box is then all it takes to support a model nobody
 * has heard of yet.
 *
 * What this deliberately is NOT is a place to store code. Executing anything
 * an administrator types would be remote code execution on a school's server,
 * reachable by whoever holds the settings privilege. `extraBody` is parsed as
 * JSON and merged into a request body; it is never evaluated.
 */

/**
 * Keys an administrator may not set through extraBody.
 *
 * Not a security boundary - the whole object is inert data either way - but
 * these are the fields the server is responsible for. Letting extraBody carry
 * `messages` would send a different prompt than the one the run recorded, and
 * letting it carry `stream` would put the reader and the request out of step.
 */
const RESERVED = new Set(['model', 'messages', 'stream', 'stream_options']);

export const modelTuningSchema = z.object({
  /**
   * Merged into the request body. Vendor extensions live here:
   * `{"chat_template_kwargs": {"enable_thinking": true}, "reasoning_budget": 16384}`
   */
  extraBody: z.record(z.unknown()).optional(),

  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  /** Some vendors' samples pin this so a run can be repeated exactly. */
  seed: z.number().int().optional(),

  /**
   * Read the reply as it arrives rather than waiting for all of it.
   *
   * On by default, and the reason most stalls stop being mysterious: without
   * it nothing arrives until the model has finished every token, so a queued
   * free tier is indistinguishable from a dead endpoint until the timeout
   * fires with nothing to show for it.
   */
  stream: z.boolean().optional(),

  /**
   * Whether this model writes its working out before the answer.
   *
   * "auto" guesses from the model name, which is all we could do before and is
   * wrong in both directions: nvidia/nemotron-3.5-lightning is a thinking
   * model whose name says nothing about it, and thinkingmachines/inkling
   * matches only because of the vendor's name. Setting it explicitly decides
   * the token budget and tells the reader to expect reasoning_content.
   */
  thinking: z.enum(['auto', 'yes', 'no']).optional(),

  /**
   * Force response_format on or off, overriding what the provider table
   * assumes. Whether a given NIM model honours JSON mode is a fact about the
   * model, not about NVIDIA.
   */
  jsonMode: z.enum(['auto', 'on', 'off']).optional(),
});

export type ModelTuning = z.infer<typeof modelTuningSchema>;

/** What a credential says, or nothing when it says nothing. */
export function tuningOf(credential: Pick<ApiCredential, 'meta'>): ModelTuning {
  const meta = (credential.meta ?? {}) as { tuning?: unknown };
  const parsed = modelTuningSchema.safeParse(meta.tuning ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * The reserved keys an administrator tried to set, so the save can say so
 * rather than silently ignoring half of what they pasted.
 */
export function reservedKeysIn(extraBody: Record<string, unknown> | undefined): string[] {
  return Object.keys(extraBody ?? {}).filter((k) => RESERVED.has(k));
}

/** extraBody with the server's own fields removed. */
export function safeExtraBody(extraBody: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extraBody ?? {})) {
    if (!RESERVED.has(key)) out[key] = value;
  }
  return out;
}
