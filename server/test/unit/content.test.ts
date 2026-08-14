import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSvg, normalizeBlocks, blocksToText } from '../../src/lib/content.js';

/**
 * Question content comes from a language model and is rendered inside the app.
 *
 * That makes it untrusted input on a page where a teacher is signed in, so the
 * SVG a model draws has to be filtered rather than trusted. These are the
 * shapes an attack takes, and the ordinary drawings that must survive it.
 */

describe('filtering an SVG a model produced', () => {
  test('an ordinary drawing survives intact', () => {
    const svg = '<svg viewBox="0 0 100 100"><polygon points="10,90 50,10 90,90" fill="none" stroke="#111"/></svg>';
    const out = sanitizeSvg(svg);
    assert.match(out, /polygon/);
    assert.match(out, /viewBox/);
    assert.match(out, /stroke/);
  });

  test('a script tag does not survive', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="5" height="5"/></svg>');
    assert.doesNotMatch(out, /script/i);
    assert.doesNotMatch(out, /alert/);
    assert.match(out, /rect/);
  });

  test('an inline event handler does not survive', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 10 10"><rect onload="alert(1)" onclick="steal()" width="5" height="5"/></svg>');
    assert.doesNotMatch(out, /onload/i);
    assert.doesNotMatch(out, /onclick/i);
    assert.match(out, /rect/);
  });

  test('a javascript: link does not survive', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 10 10"><a href="javascript:alert(1)"><text x="1" y="1">x</text></a></svg>');
    assert.doesNotMatch(out, /javascript:/i);
  });

  test('a foreignObject, which can carry arbitrary HTML, does not survive', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 10 10"><foreignObject><body><img src=x onerror="alert(1)"></body></foreignObject></svg>');
    assert.doesNotMatch(out, /foreignObject/i);
    assert.doesNotMatch(out, /onerror/i);
  });

  test('an external image reference does not survive', () => {
    // Otherwise opening the review screen tells someone else's server which
    // school is looking at which question, and when.
    const out = sanitizeSvg('<svg viewBox="0 0 10 10"><image href="http://evil.example/pixel.png"/></svg>');
    assert.doesNotMatch(out, /evil\.example/);
  });

  test('a self-closing element stays self-closing', () => {
    // The bug this guards, and it destroyed whole diagrams: the attribute
    // pattern is greedy and swallowed the trailing slash, so `<line ... />`
    // came out as `<line ...>`. The markup is handed to the DOM with
    // innerHTML, where an unclosed SVG element stays open, so every following
    // element became a child of the one before it.
    const out = sanitizeSvg(
      '<svg viewBox="0 0 100 100">'
      + '<line x1="0" y1="0" x2="10" y2="10" stroke="#111"/>'
      + '<circle cx="5" cy="5" r="2" fill="#111"/>'
      + '</svg>',
    );
    assert.equal((out.match(/\/>/g) ?? []).length, 2, `both should close themselves: ${out}`);
    assert.doesNotMatch(out, /<line[^>]*[^/]>\s*<circle/, 'the line was left open');
  });

  test('a velocity-time graph survives with every mark a sibling', () => {
    // The real drawing that found it. Sixteen siblings became a chain ten deep,
    // and it rendered as a single horizontal line.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500">
      <!-- Axes -->
      <line x1="90" y1="430" x2="730" y2="430" stroke="black" stroke-width="3"/>
      <line x1="90" y1="430" x2="90" y2="60" stroke="black" stroke-width="3"/>
      <polygon points="730,430 715,422 715,438" fill="black"/>
      <line x1="90" y1="340" x2="650" y2="120" stroke="#1769d1" stroke-width="5"/>
      <circle cx="90" cy="340" r="7" fill="#1769d1"/>
      <line x1="650" y1="120" x2="650" y2="430" stroke="black" stroke-width="2" stroke-dasharray="8,8"/>
      <text x="735" y="440" font-size="24" font-style="italic">t</text>
      <text x="350" y="235" font-size="24" fill="#1769d1" transform="rotate(-21 350 235)">slope = a</text>
    </svg>`;
    const out = sanitizeSvg(svg);

    // Six drawing marks, each closing itself, so none of them contains another.
    assert.equal((out.match(/<line\b[^>]*\/>/g) ?? []).length, 4);
    assert.equal((out.match(/<polygon\b[^>]*\/>/g) ?? []).length, 1);
    assert.equal((out.match(/<circle\b[^>]*\/>/g) ?? []).length, 1);

    // The attributes a graph is made of survive: dashes for the guide lines,
    // the rotation on the slope label, the italic on the axis names.
    assert.match(out, /stroke-dasharray="8,8"/);
    assert.match(out, /transform="rotate\(-21 350 235\)"/);
    assert.match(out, /font-style="italic"/);
    assert.match(out, /text-anchor|font-size="24"/);
    assert.match(out, /viewBox="0 0 800 500"/);
    assert.match(out, /slope = a/);
  });

  test('text and labels are kept, because a diagram without them is useless', () => {
    const out = sanitizeSvg('<svg viewBox="0 0 100 100"><text x="10" y="20" font-size="12">ABC</text></svg>');
    assert.match(out, /ABC/);
    assert.match(out, /text/);
  });
});

describe('normalising blocks', () => {
  test('a well-formed block list is preserved', () => {
    const blocks = normalizeBlocks([
      { type: 'text', value: 'What is ' },
      { type: 'math', tex: 'x^2', display: false },
    ]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].type, 'text');
    assert.equal(blocks[1].type, 'math');
  });

  test('rubbish is refused loudly rather than quietly becoming nothing', () => {
    // Refusing is the right answer here, not returning []. The callers wrap one
    // question at a time (see toQuestionRow in llm/generate.ts), so a malformed
    // question is reported to the reviewer with a reason while the rest of the
    // batch is kept. Silently returning an empty block list would instead store
    // a question with no text in it.
    assert.throws(() => normalizeBlocks(null));
    assert.throws(() => normalizeBlocks('nonsense'));
    assert.throws(() => normalizeBlocks(42));
  });

  test('an unknown block type is refused, never stored to be rendered later', () => {
    assert.throws(() => normalizeBlocks([
      { type: 'text', value: 'keep me' },
      { type: 'iframe', src: 'http://evil.example' },
    ]));
  });

  test('one bad question does not cost the whole batch', () => {
    // The isolation the comment above relies on, exercised the way generate.ts
    // does it: each question normalised inside its own try.
    const incoming = [
      [{ type: 'text', value: 'good one' }],
      'not a block list at all',
      [{ type: 'text', value: 'also good' }],
    ];
    const kept: string[] = [];
    const rejected: number[] = [];
    incoming.forEach((raw, i) => {
      try {
        kept.push(blocksToText(normalizeBlocks(raw)));
      } catch {
        rejected.push(i);
      }
    });
    assert.deepEqual(rejected, [1]);
    assert.equal(kept.length, 2);
  });
});

describe('flattening blocks to plain text', () => {
  test('text and maths read as one sentence', () => {
    const text = blocksToText(normalizeBlocks([
      { type: 'text', value: 'Solve ' },
      { type: 'math', tex: 'x+1=2', display: false },
      { type: 'text', value: ' for x.' },
    ]));
    assert.match(text, /Solve/);
    assert.match(text, /x\+1=2/);
    assert.match(text, /for x/);
  });

  test('an empty list is an empty string, not "undefined"', () => {
    assert.equal(blocksToText([]), '');
  });
});
