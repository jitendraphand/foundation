import { prisma } from '../db.js';
import { callParamsFor } from './credentials.js';
import { capabilitiesOf } from './capabilities.js';
import { LlmError, PROVIDERS, chatComplete } from './providers.js';
import { resolveCeiling } from './limits.js';
import { extractJson } from './schema.js';
import { blockSchema, sanitizeSvg, blocksToText, type Block } from '../lib/content.js';
import { checkDiagram, describeDiagram } from '../lib/diagram.js';
import type { Question } from '@prisma/client';

/**
 * Drawing one figure again.
 *
 * The generator writes a whole question in one reply, and the diagram is the
 * part it gives least attention to - which is how a question arrives with a
 * single diagonal stroke captioned "Similar Triangles ABC and DEF". Asking for
 * the whole question again would throw away a stem that is usually fine.
 *
 * So this asks for the figure and nothing else. One short prompt, one small
 * reply, all of the model's attention on the picture, and the same structural
 * check applied to the answer as to a generated one - twice, because a model
 * told exactly what was wrong with its first attempt usually fixes it.
 *
 * Nothing is saved here. The candidate goes back to the review screen to be
 * looked at first: a redraw that is worse than the original must be easy to
 * refuse, and it is the administrator who can tell.
 */

const REDRAW_SYSTEM = `You draw one figure for a school examination question. You reply with STRICT JSON and nothing else - no markdown fences, no commentary.

Return exactly one object, either

{ "type": "svg",
  "spec": { "description": "...", "labels": ["A","B","C"], "mustShow": ["..."] },
  "svg": "<svg viewBox=\\"0 0 340 200\\" xmlns=\\"http://www.w3.org/2000/svg\\">...</svg>",
  "caption": "..." }

or, for a flow chart, tree or process only,

{ "type": "mermaid",
  "spec": { "description": "...", "labels": ["Start","..."], "mustShow": ["..."] },
  "code": "graph TD; A[Start] --> B{Is x > 0?}; B -->|Yes| C[Output x]; B -->|No| D[Output -x]",
  "caption": "..." }

WRITE "spec" FIRST, THEN DRAW EXACTLY THAT.
  "description" - what a person looking at the finished figure would see: the shapes, how they are arranged, and any measurement written on it.
  "labels"      - every piece of text that must appear IN the drawing, one entry each: vertex names ("A", "B", "C"), lengths ("6 cm"), angles ("30°").
  "mustShow"    - anything else that must be visible: "a right-angle square at B", "AB and DE drawn parallel".

Then work out real coordinates so the figure is genuinely what you described. A right angle must actually be 90 degrees. A longer side must actually be longer. Two similar triangles must actually have the same angles as each other.

SVG rules:
- Always set viewBox. Never set width or height in pixels.
- Every line, polyline, polygon and open path needs an explicit stroke and stroke-width, or one on a <g> around them; SVG's default stroke is "none" and a shape without one arrives blank.
- Curves and outlines take fill="none".
- Write every label as its own <text>, placed just outside the shape so it does not sit on a line. font-size around 14 in a 340-wide viewBox.
- No <script>, no <foreignObject>, no external images. Keep it under 200 lines.

The drawing is checked automatically. A figure with no viewBox, a figure that is one lonely stroke, or a figure missing the labels its spec promised is rejected outright.`;

function briefFor(question: Question, block: Block | null): string {
  const stem = blocksToText((question.content as { blocks: Block[] }).blocks);
  const lines = [`THE QUESTION\n${stem}`];

  if (block) {
    const { description, details } = describeDiagram(block, stem);
    lines.push(`WHAT THE FIGURE MUST SHOW\n${description}`);
    if (details.length) lines.push(details.map((d) => `- ${d}`).join('\n'));
  }
  return lines.join('\n\n');
}

/**
 * Which credential draws it.
 *
 * The one that wrote the question is the natural first choice - it is the model
 * the administrator picked for this subject, and its output is what they are
 * used to reviewing. Failing that, any active credential that can write text.
 * An explicit choice from the screen always wins.
 */
async function pickCredential(question: Question, chosenId?: string) {
  if (chosenId) {
    const credential = await prisma.apiCredential.findUnique({ where: { id: chosenId } });
    if (!credential?.isActive) throw new LlmError('That provider is not available.');
    return credential;
  }

  const usable = (await prisma.apiCredential.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  })).filter((c) => capabilitiesOf(c).text && c.defaultModel);

  if (usable.length === 0) {
    throw new LlmError('No provider is set up for writing text, so there is nothing to draw with.');
  }
  return usable.find((c) => c.defaultModel === question.sourceModel) ?? usable[0];
}

export interface RedrawResult {
  block: Block;
  usedLabel: string;
  usedModel: string;
  /** What was wrong with the first attempt, when there was a second. */
  retriedBecause?: string;
}

export async function redrawFigure(args: {
  question: Question;
  /** The figure being replaced, when there is one. Its brief is reused. */
  current: Block | null;
  /** The administrator's own words, added to the brief. */
  instructions?: string;
  credentialId?: string;
  model?: string;
}): Promise<RedrawResult> {
  const credential = await pickCredential(args.question, args.credentialId);
  const model = args.model || credential.defaultModel;
  if (!model) throw new LlmError('That provider has no model chosen.');

  const providerDef = PROVIDERS[credential.provider] ?? PROVIDERS.custom;
  const call = await callParamsFor(credential);
  const ceiling = resolveCeiling(credential, model);

  const brief = [
    briefFor(args.question, args.current),
    args.instructions?.trim() ? `THE REVIEWER ASKS FOR\n${args.instructions.trim()}` : '',
    'Return the single JSON object for the figure. Nothing else.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages = [
    { role: 'system' as const, content: REDRAW_SYSTEM },
    { role: 'user' as const, content: brief },
  ];

  let lastProblem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await chatComplete({
      ...call,
      model,
      messages:
        attempt === 0
          ? messages
          : [
              ...messages,
              { role: 'user' as const, content: `Your drawing was rejected: ${lastProblem}. Draw it again, fixing exactly that. Return only the JSON object.` },
            ],
      temperature: 0.2,
      jsonMode: providerDef.supportsJsonMode,
      maxTokens: Math.min(6000, ceiling ?? 6000),
    });

    let candidate: Block;
    try {
      const raw = blockSchema.parse(extractJson(response.text));
      candidate = raw.type === 'svg' ? { ...raw, svg: sanitizeSvg(raw.svg) } : raw;
    } catch (err) {
      lastProblem = err instanceof Error ? err.message : 'the reply was not a usable figure';
      continue;
    }

    if (candidate.type !== 'svg' && candidate.type !== 'mermaid') {
      lastProblem = 'that is not a drawing - return an svg or mermaid block';
      continue;
    }

    const problem = checkDiagram(candidate, blocksToText((args.question.content as { blocks: Block[] }).blocks));
    if (problem) {
      lastProblem = problem.reason;
      continue;
    }

    return {
      block: candidate,
      usedLabel: credential.label,
      usedModel: model,
      ...(attempt > 0 ? { retriedBecause: lastProblem } : {}),
    };
  }

  throw new LlmError(
    `${credential.label} could not draw a usable figure: ${lastProblem}. Try again, add a note saying what it should ` +
      'show, or replace it with a generated picture instead.',
  );
}
