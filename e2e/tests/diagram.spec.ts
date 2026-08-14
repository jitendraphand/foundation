import { test, expect, type Page } from '@playwright/test';
import { ADMIN_STATE, importQuestions, watchForBreakage } from '../fixtures/people.js';

/**
 * A diagram a model drew, rendered in a browser.
 *
 * There is a unit test over the sanitiser, and it did not save us: it compared
 * strings, and the bug it missed only existed once the string reached the DOM.
 * The sanitiser was dropping the slash from `<line ... />`, and because the
 * markup is handed over with innerHTML - where an unclosed SVG element stays
 * open - each mark became a child of the one before it. Every attribute was
 * present, every element was present, nothing was rejected, and a velocity-time
 * graph rendered as a single horizontal line.
 *
 * So this checks the one thing a string comparison cannot: the shape of the
 * tree the browser actually built, and that the drawing has two dimensions.
 */

test.use({ storageState: ADMIN_STATE });

/** A velocity-time graph: the kind of figure a physics paper asks for. */
const VELOCITY_TIME_GRAPH = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
  <!-- Axes -->
  <line x1="90" y1="430" x2="730" y2="430" stroke="black" stroke-width="3"/>
  <line x1="90" y1="430" x2="90" y2="60" stroke="black" stroke-width="3"/>
  <!-- Arrowheads -->
  <polygon points="730,430 715,422 715,438" fill="black"/>
  <polygon points="90,60 82,75 98,75" fill="black"/>
  <!-- The line itself -->
  <line x1="90" y1="340" x2="650" y2="120" stroke="#1769d1" stroke-width="5"/>
  <!-- Where it starts and ends -->
  <circle cx="90" cy="340" r="7" fill="#1769d1"/>
  <circle cx="650" cy="120" r="7" fill="#1769d1"/>
  <!-- Dashed guides down to the axes -->
  <line x1="650" y1="120" x2="650" y2="430" stroke="black" stroke-width="2" stroke-dasharray="8,8"/>
  <line x1="90" y1="120" x2="650" y2="120" stroke="black" stroke-width="2" stroke-dasharray="8,8"/>
  <!-- Labels -->
  <text x="735" y="440" font-size="24" font-style="italic">t</text>
  <text x="65" y="55" font-size="24" font-style="italic">v</text>
  <text x="78" y="455" font-size="22" font-style="italic">O</text>
  <text x="65" y="347" font-size="22" font-style="italic">u</text>
  <text x="650" y="455" font-size="22" text-anchor="middle" font-style="italic">t</text>
  <text x="68" y="115" font-size="22" font-style="italic">v</text>
  <text x="350" y="235" font-size="24" fill="#1769d1" transform="rotate(-21 350 235)">slope = a</text>
</svg>`;

/** Sixteen drawing marks, all siblings, none inside another. */
const MARKS = 16;

const MARKER = 'Diagram check: read the acceleration off this graph';

/**
 * Finds the question this test imported, so it can be taken out again.
 *
 * It has to be. This spec runs first, and first-day.spec then reviews the bank
 * and expects to find exactly the five questions it imported itself - an extra
 * one left behind is an extra question on its paper and a different mark at the
 * end of it. Nothing has answered this one, so it is a real delete.
 */
async function removeImported(page: Page, marker: string): Promise<void> {
  await page.evaluate(async (needle) => {
    for (const bucket of ['DRAFT', 'APPROVED']) {
      const url = `/api/admin/questions?bucket=${bucket}&pageSize=100&search=${encodeURIComponent(needle)}`;
      const list = await (await fetch(url, { credentials: 'include' })).json();
      for (const q of (list.questions ?? []) as { id: string }[]) {
        await fetch(`/api/admin/questions/${q.id}`, { method: 'DELETE', credentials: 'include' });
      }
    }
  }, marker);
}

test('a graph a model drew reaches the browser as a graph', async ({ page }) => {
  const problems = watchForBreakage(page);

  await page.goto('/admin');
  await importQuestions(page, [{
    format: 'MCQ_SINGLE',
    content: {
      version: 1,
      blocks: [
        { type: 'text', value: MARKER },
        { type: 'svg', svg: VELOCITY_TIME_GRAPH, caption: 'Velocity against time' },
      ],
    },
    options: ['a', 'b', 'c', 'd'].map((id, k) => ({
      id,
      blocks: [{ type: 'text', value: `${(k + 1) * 2} m/s²` }],
    })),
    answerKey: { correctOptionId: 'b' },
    explanation: { version: 1, blocks: [{ type: 'text', value: 'The slope of a v-t graph is the acceleration.' }] },
    difficultyTag: 'medium',
    cognitiveTag: 'application',
    skillTags: ['data_interpretation'],
    subject: 'Physics',
    estimatedSeconds: 90,
  }]);

  try {
    // Where an import lands: the review queue, which is the first time a person
    // sees what the model drew.
    await page.goto('/admin/questions?bucket=DRAFT');
    const card = page.locator('li.card').filter({ hasText: MARKER }).first();
    await expect(card).toBeVisible({ timeout: 30_000 });

    const drawing = card.locator('.svg-host svg').first();
    await expect(drawing).toBeVisible();

    // The tree the browser built. Under the bug this was one child and ten deep.
    const shape = await drawing.evaluate((svg) => {
      const deepest = (node: Element, d = 0): number =>
        Math.max(d, ...Array.from(node.children).map((c) => deepest(c, d + 1)));
      return {
        directChildren: svg.children.length,
        total: svg.querySelectorAll('*').length,
        depth: deepest(svg),
        // The dashes belong to two guide lines. When a guide stayed open the
        // labels inherited them and the words came out stippled.
        dashedText: svg.querySelectorAll('text[stroke-dasharray], [stroke-dasharray] text').length,
      };
    });

    expect(shape.total, 'marks went missing').toBe(MARKS);
    expect(shape.directChildren, 'the marks nested inside each other instead of sitting side by side').toBe(MARKS);
    expect(shape.depth, 'the drawing became a chain').toBe(1);
    expect(shape.dashedText, 'labels inherited the dashes from a guide line').toBe(0);

    // And it is a graph rather than a line: the axes give it both dimensions.
    // A collapsed drawing is a few pixels tall however wide its box is.
    const box = (await drawing.boundingBox())!;
    expect(box.height, 'the diagram came out flat').toBeGreaterThan(box.width / 4);

    expect(problems).toEqual([]);
  } finally {
    await removeImported(page, MARKER);
  }
});
