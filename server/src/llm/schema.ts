import { z } from 'zod';
import { blockSchema } from '../lib/content.js';

/**
 * The strict reply contract the LLM must follow.
 *
 * Three things enforce it:
 *  1. DEFAULT_SYSTEM_PROMPT states the schema in full, with worked examples.
 *  2. response_format json_object is set where the provider supports it.
 *  3. Everything is re-validated here with Zod. A model that ignores the
 *     contract fails validation, and the caller sends the validation errors
 *     back to the model for one repair round.
 *
 * A question that still fails after the repair round is dropped and reported
 * to the admin, never silently half-imported.
 */

/**
 * The image-generation prompt a model must supply whenever it flags a question
 * as needing a real picture. Kept strict so the admin never receives a
 * half-written prompt they have to guess their way through.
 */
export const imagePromptSchema = z.object({
  version: z.number().int().default(1),
  prompt: z.string().min(20).max(2000),
  description: z.string().min(10).max(1000),
  details: z.array(z.string().max(300)).max(20).default([]),
  style: z.string().max(300).default('clean flat vector illustration, white background'),
  widthPx: z.number().int().min(128).max(4096).default(800),
  heightPx: z.number().int().min(128).max(4096).default(600),
  aspectRatio: z.string().max(16).optional(),
  altText: z.string().max(500).default(''),
  placement: z.enum(['STEM', 'OPTION']).default('STEM'),
  optionId: z.string().max(8).nullable().optional(),
});

export type LlmImagePrompt = z.infer<typeof imagePromptSchema>;

export const llmQuestionSchema = z.object({
  format: z.enum(['MCQ_SINGLE', 'MCQ_MULTI']),
  content: z.object({
    version: z.number().int().optional(),
    blocks: z.array(blockSchema).min(1).max(40),
  }),
  options: z
    .array(z.object({ id: z.string().min(1).max(8), blocks: z.array(blockSchema).min(1).max(12) }))
    .max(8)
    .default([]),
  answerKey: z.record(z.any()),
  /// Models emit false / null / absent in the overwhelmingly common case.
  imageRequired: z.boolean().default(false),
  imagePrompt: imagePromptSchema.nullable().optional(),
  explanation: z
    .object({ version: z.number().int().optional(), blocks: z.array(blockSchema).max(40) })
    .default({ blocks: [] }),
  difficultyTag: z.string().min(1),
  cognitiveTag: z.string().min(1),
  skillTags: z.array(z.string().min(1)).min(1).max(4),
  subject: z.string().min(1),
  topic: z.string().optional().nullable(),
  subtopic: z.string().optional().nullable(),
  estimatedSeconds: z.number().int().min(5).max(1800).default(60),
});

export type LlmQuestion = z.infer<typeof llmQuestionSchema>;

export const llmResponseSchema = z.object({
  questions: z.array(llmQuestionSchema).min(1),
});

/**
 * Models wrap JSON in prose or fences no matter what you tell them. This pulls
 * the object out rather than failing, which materially raises the success rate.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim();

  // 1. Straight parse.
  try {
    return JSON.parse(text);
  } catch {
    /* continue */
  }

  // 2. Fenced code block.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* continue */
    }
  }

  // 3. Widest balanced {...} span in the text.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const candidate = text.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // 4. Last resort: repair trailing commas, which are the single most
      //    common thing models get wrong in long JSON.
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        /* fall through */
      }
    }
  }

  throw new Error('Response did not contain a parsable JSON object.');
}

/** Compact, model-readable summary of what failed, for the repair round. */
export function describeIssues(err: z.ZodError, limit = 20): string {
  return err.issues
    .slice(0, limit)
    .map((i) => `- at ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}
