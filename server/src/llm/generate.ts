import { z } from 'zod';
import { prisma } from '../db.js';
import { decryptSecret } from '../lib/crypto.js';
import { normalizeContent, normalizeBlocks, CONTENT_VERSION } from '../lib/content.js';
import { validateAnswerKey } from '../lib/grading.js';
import { chatComplete, LlmError, PROVIDERS, type ChatMessage } from './providers.js';
import { extractJson, llmResponseSchema, llmQuestionSchema, describeIssues, type LlmQuestion } from './schema.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE, PRACTICE_SYSTEM_SUFFIX, renderTemplate } from './prompts.js';
import type { TestKind, QuestionStatus } from '@prisma/client';

export interface GenerateSpec {
  subject: string;
  topic?: string;
  subtopic?: string;
  grade?: string;
  count: number;
  marksPerQuestion: number;
  difficultyMix?: Record<string, number>;
  cognitiveMix?: Record<string, number>;
  skillFocus?: string[];
  formats?: string[];
  extraInstructions?: string;
}

export interface GenerateOptions {
  requestedById: string;
  /** The provider is read from the credential, never trusted from the client. */
  model: string;
  credentialId: string;
  systemPrompt?: string;
  userPrompt?: string;
  promptTemplateId?: string;
  spec: GenerateSpec;
  kind: TestKind;
  targetUserId?: string;
  temperature?: number;
}

export interface GenerateOutcome {
  runId: string;
  accepted: number;
  parsed: number;
  rejected: Array<{ index: number; reason: string }>;
  warnings: string[];
}

function describeMix(mix: Record<string, number> | undefined, fallback: string): string {
  if (!mix || Object.keys(mix).length === 0) return fallback;
  return Object.entries(mix)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
}

export function buildUserPrompt(spec: GenerateSpec, template = DEFAULT_USER_TEMPLATE): string {
  return renderTemplate(template, {
    count: spec.count,
    subject: spec.subject,
    topic: spec.topic || 'any appropriate topic within the subject',
    subtopic: spec.subtopic || 'any appropriate subtopic',
    grade: spec.grade || 'unspecified',
    marksPerQuestion: spec.marksPerQuestion,
    difficultyMix: describeMix(spec.difficultyMix, 'a balanced spread of easy, moderate and difficult'),
    cognitiveMix: describeMix(spec.cognitiveMix, 'a balanced spread across the cognitive levels'),
    formats: spec.formats?.length ? spec.formats.join(', ') : 'MCQ_SINGLE',
    skillFocus: spec.skillFocus?.length ? spec.skillFocus.join(', ') : 'any relevant skills',
    extraInstructions: spec.extraInstructions ?? '',
  });
}

/**
 * Converts one validated LLM question into the row shape, re-validating the
 * answer key against the declared format and sanitising every SVG on the way
 * in. Throws with a human-readable reason, which is surfaced per-question to
 * the admin rather than failing the whole batch.
 */
function toQuestionRow(q: LlmQuestion, ctx: { runId: string; model: string; validTags: ValidTags }) {
  // Tags must exist in the vocabulary, otherwise analytics silently splits into
  // buckets nobody ever looks at.
  if (!ctx.validTags.difficulty.has(q.difficultyTag)) {
    throw new Error(`unknown difficultyTag "${q.difficultyTag}"`);
  }
  if (!ctx.validTags.cognitive.has(q.cognitiveTag)) {
    throw new Error(`unknown cognitiveTag "${q.cognitiveTag}"`);
  }
  const skills = q.skillTags.filter((s) => ctx.validTags.skill.has(s));
  if (skills.length === 0) {
    throw new Error(`no recognised skillTags in [${q.skillTags.join(', ')}]`);
  }

  const content = normalizeContent({ version: CONTENT_VERSION, blocks: q.content.blocks });

  const options = q.options.map((o) => ({ id: o.id, blocks: normalizeBlocks(o.blocks) }));

  if (q.format === 'MCQ_SINGLE' || q.format === 'MCQ_MULTI') {
    if (options.length < 2) throw new Error('multiple-choice question has fewer than 2 options');
    const ids = new Set(options.map((o) => o.id));
    if (ids.size !== options.length) throw new Error('duplicate option ids');
  } else if (options.length > 0) {
    throw new Error(`${q.format} question must have no options`);
  }

  // Throws if the key does not match the declared format.
  const answerKey = validateAnswerKey(q.format, q.answerKey);

  // The key must point at options that actually exist.
  if (q.format === 'MCQ_SINGLE') {
    const id = (answerKey as { correctOptionId: string }).correctOptionId;
    if (!options.some((o) => o.id === id)) throw new Error(`answer key names option "${id}" which does not exist`);
  }
  if (q.format === 'MCQ_MULTI') {
    const ids = (answerKey as { correctOptionIds: string[] }).correctOptionIds;
    for (const id of ids) {
      if (!options.some((o) => o.id === id)) throw new Error(`answer key names option "${id}" which does not exist`);
    }
  }

  const explanation = q.explanation?.blocks?.length
    ? { version: CONTENT_VERSION, blocks: normalizeBlocks(q.explanation.blocks) }
    : { version: CONTENT_VERSION, blocks: [] };

  return {
    status: 'DRAFT' as QuestionStatus,
    format: q.format,
    content: content as object,
    options: options as object,
    answerKey: answerKey as object,
    explanation: explanation as object,
    difficultyTag: q.difficultyTag,
    cognitiveTag: q.cognitiveTag,
    skillTags: skills,
    subject: q.subject,
    topic: q.topic ?? null,
    subtopic: q.subtopic ?? null,
    estimatedSeconds: q.estimatedSeconds,
    generationRunId: ctx.runId,
    sourceModel: ctx.model,
  };
}

interface ValidTags {
  difficulty: Set<string>;
  cognitive: Set<string>;
  skill: Set<string>;
}

async function loadValidTags(): Promise<ValidTags> {
  const tags = await prisma.tag.findMany({ where: { isActive: true }, select: { axis: true, code: true } });
  return {
    difficulty: new Set(tags.filter((t) => t.axis === 'DIFFICULTY').map((t) => t.code)),
    cognitive: new Set(tags.filter((t) => t.axis === 'COGNITIVE').map((t) => t.code)),
    skill: new Set(tags.filter((t) => t.axis === 'SKILL').map((t) => t.code)),
  };
}

/**
 * Runs one generation. Questions land as DRAFT; nothing reaches a student
 * until an admin approves it and places it on a test.
 */
export async function runGeneration(opts: GenerateOptions): Promise<GenerateOutcome> {
  const credential = await prisma.apiCredential.findUnique({ where: { id: opts.credentialId } });
  if (!credential || !credential.isActive) {
    throw new LlmError('That API credential no longer exists or has been disabled.');
  }

  const apiKey = decryptSecret(credential.encryptedKey);
  const providerDef = PROVIDERS[credential.provider] ?? PROVIDERS.custom;

  let systemPrompt = opts.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  if (opts.kind === 'PRACTICE') systemPrompt += PRACTICE_SYSTEM_SUFFIX;

  const userPrompt = opts.userPrompt?.trim() || buildUserPrompt(opts.spec);

  const run = await prisma.generationRun.create({
    data: {
      status: 'RUNNING',
      requestedById: opts.requestedById,
      provider: credential.provider,
      model: opts.model,
      promptTemplateId: opts.promptTemplateId ?? null,
      systemPrompt,
      userPrompt,
      requestSpec: opts.spec as object,
      kind: opts.kind,
      targetUserId: opts.targetUserId ?? null,
      questionsRequested: opts.spec.count,
    },
  });

  const warnings: string[] = [];

  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    let response = await chatComplete({
      baseUrl: credential.baseUrl,
      apiKey,
      model: opts.model,
      messages,
      temperature: opts.temperature ?? 0.4,
      jsonMode: providerDef.supportsJsonMode,
      maxTokens: Math.min(16000, 1200 * Math.max(1, opts.spec.count)),
    });

    let rawText = response.text;
    let attempts = 1;
    let parsedResponse: z.infer<typeof llmResponseSchema> | null = null;
    let lastError = '';

    // Up to two repair rounds. Sending the model its own validation errors is
    // dramatically more effective than simply retrying the same prompt.
    for (let round = 0; round < 3; round++) {
      try {
        const json = extractJson(rawText);
        parsedResponse = llmResponseSchema.parse(json);
        break;
      } catch (err) {
        lastError =
          err instanceof z.ZodError ? describeIssues(err) : err instanceof Error ? err.message : String(err);

        if (round === 2) break;

        warnings.push(`Repair round ${round + 1}: the model's reply did not match the contract.`);
        messages.push({ role: 'assistant', content: rawText.slice(0, 12_000) });
        messages.push({
          role: 'user',
          content:
            `Your reply did not satisfy the required JSON contract. Problems found:\n${lastError}\n\n` +
            `Return the corrected, complete JSON object now. Output only the JSON object, no fences and no commentary.`,
        });

        response = await chatComplete({
          baseUrl: credential.baseUrl,
          apiKey,
          model: opts.model,
          messages,
          temperature: 0.1,
          jsonMode: providerDef.supportsJsonMode,
          maxTokens: Math.min(16000, 1200 * Math.max(1, opts.spec.count)),
        });
        rawText = response.text;
        attempts++;
      }
    }

    if (!parsedResponse) {
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          rawResponse: rawText.slice(0, 100_000),
          errorMessage: `Could not obtain a valid response after ${attempts} attempts.\n${lastError}`,
          parseAttempts: attempts,
          completedAt: new Date(),
          latencyMs: response.latencyMs,
        },
      });
      throw new LlmError(
        `The model did not return questions in the required format after ${attempts} attempts. ` +
          `Open the run in Admin > Generation history to see its raw reply. Last problem:\n${lastError}`,
      );
    }

    const validTags = await loadValidTags();
    const rejected: Array<{ index: number; reason: string }> = [];
    const rows: ReturnType<typeof toQuestionRow>[] = [];

    parsedResponse.questions.forEach((q, index) => {
      try {
        rows.push(toQuestionRow(q, { runId: run.id, model: opts.model, validTags }));
      } catch (err) {
        rejected.push({ index, reason: err instanceof Error ? err.message : String(err) });
      }
    });

    if (rows.length > 0) {
      await prisma.question.createMany({ data: rows as never });
    }

    await prisma.generationRun.update({
      where: { id: run.id },
      data: {
        status: rows.length > 0 ? 'SUCCEEDED' : 'FAILED',
        rawResponse: rawText.slice(0, 100_000),
        parseAttempts: attempts,
        promptTokens: response.promptTokens ?? null,
        completionTokens: response.completionTokens ?? null,
        latencyMs: response.latencyMs,
        questionsParsed: parsedResponse.questions.length,
        questionsAccepted: rows.length,
        errorMessage: rejected.length ? rejected.map((r) => `Q${r.index + 1}: ${r.reason}`).join('\n') : null,
        completedAt: new Date(),
      },
    });

    if (rows.length === 0) {
      throw new LlmError(
        `All ${parsedResponse.questions.length} questions failed validation:\n` +
          rejected.map((r) => `Q${r.index + 1}: ${r.reason}`).join('\n'),
      );
    }

    return { runId: run.id, accepted: rows.length, parsed: parsedResponse.questions.length, rejected, warnings };
  } catch (err) {
    if (!(err instanceof LlmError)) {
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          errorMessage: err instanceof Error ? err.message : String(err),
          completedAt: new Date(),
        },
      }).catch(() => undefined);
    }
    throw err;
  }
}

export { llmQuestionSchema };
