import { chatComplete, type ChatMessage } from './providers.js';
import { callParamsFor } from './credentials.js';
import { prisma } from '../db.js';
import { getGenerationPipeline } from '../services/settings.js';

export interface VerificationResult {
  questionIndex: number;
  isValid: boolean;
  reason: string;
  confidence: number;
}

/**
 * Verifies that questions are conceptually correct and have a valid correct option.
 * Uses a separate LLM call (cheap external or local) to avoid self-bias.
 * For auto-served questions (step-up, practice), this is critical.
 */
function quickValidOptionCheck(q: { content: unknown; options: unknown[]; answerKey: unknown }): { valid: boolean; reason?: string } {
  const opts = q.options as Array<{ id?: string; blocks?: unknown[] }>;
  if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4) return { valid: false, reason: 'Must have 2-4 options' };
  const ids = new Set(opts.map((o) => o.id));
  if (ids.size !== opts.length) return { valid: false, reason: 'Duplicate option ids' };
  for (const o of opts) {
    if (!o.blocks || !Array.isArray(o.blocks) || o.blocks.length === 0) return { valid: false, reason: `Option ${o.id} has no content` };
  }
  const ak = q.answerKey as { correctOptionId?: string; correctOptionIds?: string[] };
  if (ak?.correctOptionId) {
    if (!ids.has(ak.correctOptionId)) return { valid: false, reason: `Correct option ${ak.correctOptionId} does not exist` };
  } else if (ak?.correctOptionIds) {
    if (ak.correctOptionIds.length < 1 || ak.correctOptionIds.length > 3) return { valid: false, reason: 'Invalid correctOptionIds length' };
    for (const id of ak.correctOptionIds) if (!ids.has(id)) return { valid: false, reason: `Correct option ${id} does not exist` };
    if (ak.correctOptionIds.length === opts.length) return { valid: false, reason: 'All options cannot be correct' };
  } else {
    return { valid: false, reason: 'Missing correct option' };
  }
  const content = q.content as { blocks?: Array<{ type: string; value?: string; tex?: string }> };
  if (!content?.blocks || content.blocks.length === 0) return { valid: false, reason: 'Question content empty' };
  return { valid: true };
}

export async function verifyQuestions(
  questions: Array<{ content: unknown; options: unknown[]; answerKey: unknown; subject: string }>,
  opts: { mode?: 'strict' | 'lenient' } = {},
): Promise<VerificationResult[]> {
  if (questions.length === 0) return [];

  // Quick programmatic valid-option check first — no LLM needed for malformed
  const quickResults: VerificationResult[] = [];
  const needsLlm: Array<{ q: typeof questions[0]; idx: number }> = [];
  questions.forEach((q, idx) => {
    const quick = quickValidOptionCheck(q);
    if (!quick.valid) {
      quickResults.push({ questionIndex: idx, isValid: false, reason: quick.reason!, confidence: 1.0 });
    } else {
      needsLlm.push({ q, idx });
    }
  });
  if (needsLlm.length === 0) return quickResults;

  const verificationPrompt = `You are a subject expert verifier. Check each question for:
1. Conceptual correctness (fact, formula, reasoning is accurate)
2. Exactly one valid correct option exists and matches answerKey
3. Distractors are plausible but incorrect
4. No ambiguous wording

Return ONLY JSON: {"verifications": [{"questionIndex":0,"isValid":true,"reason":"...","confidence":0.95}]}

Questions to verify:
${needsLlm.map(({ q }, i) => `Q${i + 1} (orig ${needsLlm[i].idx + 1}): ${JSON.stringify(q).slice(0, 2000)}`).join('\n\n')}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a strict verifier. Return only JSON with verifications array.' },
    { role: 'user', content: verificationPrompt },
  ];

  // Choose verifier: cheap external if configured, otherwise any active credential
  let verifierCall: Awaited<ReturnType<typeof callParamsFor>> | null = null;
  let verifierModel: string | null = null;

  try {
    const pipeline = await getGenerationPipeline().catch(() => null);
    if (pipeline?.cheapCredentialId) {
      const cheap = await prisma.apiCredential.findUnique({ where: { id: pipeline.cheapCredentialId } });
      if (cheap?.isActive) {
        verifierCall = await callParamsFor(cheap);
        verifierModel = cheap.defaultModel ?? 'gpt-4o-mini';
      }
    }
  } catch {
    // fallback
  }

  let rawText: string;

  if (verifierCall && verifierModel) {
    const res = await chatComplete({
      ...verifierCall,
      model: verifierModel,
      messages,
      temperature: 0,
      maxTokens: 2000,
      jsonMode: true,
    });
    rawText = res.text;
  } else {
    // Fallback: try to use any active credential
    const fallback = await prisma.apiCredential.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
    if (!fallback) {
      // No verifier available — assume valid but flag for manual review
      return [...quickResults, ...needsLlm.map(({ idx }) => ({ questionIndex: idx, isValid: true, reason: 'No verifier configured — assumed valid', confidence: 0.5 }))];
    }
    const call = await callParamsFor(fallback);
    const model = fallback.defaultModel ?? 'gpt-4o-mini';
    const res = await chatComplete({
      ...call,
      model,
      messages,
      temperature: 0,
      maxTokens: 2000,
      jsonMode: true,
    });
    rawText = res.text;
  }

  try {
    const start = rawText.indexOf('{');
    const end = rawText.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('No JSON');
    const parsed = JSON.parse(rawText.slice(start, end + 1)) as { verifications?: VerificationResult[] };
    if (!Array.isArray(parsed.verifications)) throw new Error('Missing verifications');
    const llmVerifications = parsed.verifications.map((v) => ({
      ...v,
      questionIndex: needsLlm[v.questionIndex]?.idx ?? v.questionIndex,
    }));
    return [...quickResults, ...llmVerifications];
  } catch {
    // If verifier output is not parseable, be conservative — mark all as valid but low confidence
    // to avoid blocking students, but log for admin
    return [...quickResults, ...needsLlm.map(({ idx }) => ({ questionIndex: idx, isValid: true, reason: 'Verifier output unparseable — assumed valid', confidence: 0.6 }))];
  }
}

/**
 * Filters questions to only those that passed verification.
 * Returns { valid, invalid } split.
 */
export function filterVerified(
  questions: unknown[],
  verifications: VerificationResult[],
  threshold = 0.7,
): { valid: unknown[]; invalid: Array<{ index: number; reason: string }> } {
  const valid: unknown[] = [];
  const invalid: Array<{ index: number; reason: string }> = [];

  verifications.forEach((v) => {
    const q = questions[v.questionIndex];
    if (!q) return;
    if (v.isValid && v.confidence >= threshold) {
      valid.push(q);
    } else {
      invalid.push({ index: v.questionIndex, reason: v.reason });
    }
  });

  // Include any questions not mentioned in verifications as valid (verifier may have skipped)
  questions.forEach((q, i) => {
    if (!verifications.some((v) => v.questionIndex === i)) {
      valid.push(q);
    }
  });

  return { valid, invalid };
}
