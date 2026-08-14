import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkDiagram, labelsInQuestionText, isFigure } from '../../src/lib/diagram.js';
import type { Block } from '../../src/lib/content.js';

/**
 * Catching a drawing that cannot be what its caption says it is.
 *
 * The case this exists for, verbatim from a real generation run: a caption
 * reading "Similar Triangles ABC and DEF" over a single diagonal line. Valid
 * SVG, renders cleanly, and contains no triangles and no labels.
 */

const svg = (body: string, caption = '', spec?: Record<string, unknown>): Block =>
  ({ type: 'svg', svg: `<svg viewBox="0 0 300 300">${body}</svg>`, caption, ...(spec ? { spec } : {}) }) as Block;

describe('rejecting a meaningless drawing', () => {
  test('one diagonal line captioned as two triangles is refused', () => {
    const problem = checkDiagram(
      svg('<path d="M20 280 L120 100" stroke="#000"/>', 'Similar Triangles ABC and DEF'),
      'Similar Triangles ABC and DEF are shown.',
    );
    assert.ok(problem, 'expected this to be rejected');
  });

  test('a drawing with no viewBox is refused, because it will not scale', () => {
    const block = { type: 'svg', svg: '<svg><polygon points="10,90 50,10 90,90"/></svg>', caption: 'A triangle' } as Block;
    assert.ok(checkDiagram(block, 'A triangle ABC.'));
  });

  test('an empty drawing is refused', () => {
    assert.ok(checkDiagram(svg('', 'A figure'), 'A figure.'));
  });
});

describe('accepting a real drawing', () => {
  test('a triangle is one polygon, and that is enough', () => {
    // The bar cannot be "several elements": a triangle drawn properly is a
    // single <polygon>, and an earlier version of this rule rejected it.
    const problem = checkDiagram(
      svg('<polygon points="10,90 50,10 90,90" fill="none" stroke="#111"/>'
        + '<text x="8" y="98">A</text><text x="50" y="8">B</text><text x="92" y="98">C</text>',
        'Triangle ABC'),
      'In triangle ABC, find the height.',
    );
    assert.equal(problem, null);
  });

  test('a labelled figure with several strokes passes', () => {
    const problem = checkDiagram(
      svg('<line x1="10" y1="10" x2="90" y2="10" stroke="#111"/>'
        + '<line x1="10" y1="10" x2="10" y2="90" stroke="#111"/>'
        + '<line x1="10" y1="90" x2="90" y2="90" stroke="#111"/>'
        + '<line x1="90" y1="10" x2="90" y2="90" stroke="#111"/>'
        + '<text x="5" y="8">P</text><text x="95" y="8">Q</text>',
        'Rectangle PQRS'),
      'Rectangle PQRS has sides P and Q marked.',
    );
    assert.equal(problem, null);
  });
});

describe('finding the labels a question refers to', () => {
  test('a plain triangle name is found', () => {
    assert.deepEqual(labelsInQuestionText('In triangle ABC, find angle B.'), ['A', 'B', 'C']);
  });

  test('the shape word is matched whatever its case', () => {
    // "Similar Triangles ABC and DEF" is how a caption is actually written, and
    // a case-sensitive match missed every one of them.
    assert.deepEqual(labelsInQuestionText('Similar Triangles ABC and DEF'), ['A', 'B', 'C', 'D', 'E', 'F']);
  });

  test('a continuation after "and" is picked up', () => {
    const labels = labelsInQuestionText('Triangle PQR and STU are congruent.');
    for (const l of ['P', 'Q', 'R', 'S', 'T', 'U']) assert.ok(labels.includes(l), `missing ${l}`);
  });

  test('an ordinary capitalised word is not mistaken for a label', () => {
    // Without the shape-word guard, "In India" and "The Circle Line" both look
    // like figure names.
    assert.deepEqual(labelsInQuestionText('India exports more rice than Vietnam.'), []);
  });

  test('a question with no figure in it yields nothing', () => {
    assert.deepEqual(labelsInQuestionText('What is 2 + 2?'), []);
  });
});

describe('telling a figure from decoration', () => {
  test('an svg block is a figure', () => {
    assert.equal(isFigure(svg('<polygon points="1,1 2,2 3,3"/>')), true);
  });

  test('a text block is not', () => {
    assert.equal(isFigure({ type: 'text', value: 'hello' } as Block), false);
  });
});
