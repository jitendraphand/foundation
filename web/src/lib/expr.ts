/**
 * A tiny recursive-descent evaluator for the `function` chart spec.
 *
 * This exists specifically so that an expression arriving from an LLM is never
 * passed to eval() or new Function(). The grammar below is the entire language:
 * numbers, x, + - * / ^, parentheses, unary minus, and a fixed function list.
 * Anything else is a parse error, which the chart renders as a friendly notice.
 *
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := unary ('^' factor)?          // right-associative
 *   unary  := ('-' | '+')? primary
 *   primary:= number | 'x' | 'pi' | 'e' | func '(' expr ')' | '(' expr ')'
 */

const FUNCS: Record<string, (n: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};

type Token = { kind: 'num'; value: number } | { kind: 'ident'; value: string } | { kind: 'op'; value: string };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j++;
      const value = Number(input.slice(i, j));
      if (!Number.isFinite(value)) throw new Error(`"${input.slice(i, j)}" is not a number`);
      tokens.push({ kind: 'num', value });
      i = j;
      continue;
    }

    if (/[a-zA-Z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[a-zA-Z0-9_]/.test(input[j])) j++;
      tokens.push({ kind: 'ident', value: input.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }

    if ('+-*/^(),'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch });
      i++;
      continue;
    }

    throw new Error(`unexpected character "${ch}"`);
  }

  return tokens;
}

export type CompiledExpression = (x: number) => number;

/**
 * Parses once and returns a closure, so plotting 400 points does not re-parse
 * the string 400 times.
 */
export function compileExpression(source: string): CompiledExpression {
  const tokens = tokenize(source);
  let pos = 0;

  const peek = () => tokens[pos];
  const eat = (value: string) => {
    const t = peek();
    if (t && t.kind === 'op' && t.value === value) {
      pos++;
      return true;
    }
    return false;
  };

  type Node = (x: number) => number;

  function parseExpr(): Node {
    let left = parseTerm();
    for (;;) {
      if (eat('+')) {
        const right = parseTerm();
        const l = left;
        left = (x) => l(x) + right(x);
      } else if (eat('-')) {
        const right = parseTerm();
        const l = left;
        left = (x) => l(x) - right(x);
      } else return left;
    }
  }

  function parseTerm(): Node {
    let left = parseFactor();
    for (;;) {
      if (eat('*')) {
        const right = parseFactor();
        const l = left;
        left = (x) => l(x) * right(x);
      } else if (eat('/')) {
        const right = parseFactor();
        const l = left;
        left = (x) => l(x) / right(x);
      } else return left;
    }
  }

  function parseFactor(): Node {
    const base = parseUnary();
    if (eat('^')) {
      const exponent = parseFactor(); // right-associative
      return (x) => Math.pow(base(x), exponent(x));
    }
    return base;
  }

  function parseUnary(): Node {
    if (eat('-')) {
      const operand = parseUnary();
      return (x) => -operand(x);
    }
    eat('+');
    return parsePrimary();
  }

  function parsePrimary(): Node {
    const token = peek();
    if (!token) throw new Error('unexpected end of expression');

    if (token.kind === 'num') {
      pos++;
      return () => token.value;
    }

    if (token.kind === 'ident') {
      pos++;
      const name = token.value;

      if (name === 'x') return (x) => x;
      if (name === 'pi') return () => Math.PI;
      if (name === 'e') return () => Math.E;

      const fn = FUNCS[name];
      if (!fn) throw new Error(`unknown name "${name}"`);
      if (!eat('(')) throw new Error(`"${name}" must be followed by (`);
      const arg = parseExpr();
      if (!eat(')')) throw new Error(`missing ) after ${name}(`);
      return (x) => fn(arg(x));
    }

    if (token.kind === 'op' && token.value === '(') {
      pos++;
      const inner = parseExpr();
      if (!eat(')')) throw new Error('missing )');
      return inner;
    }

    throw new Error(`unexpected "${token.value}"`);
  }

  const root = parseExpr();
  if (pos < tokens.length) {
    const leftover = tokens[pos];
    throw new Error(`unexpected "${'value' in leftover ? leftover.value : '?'}" after the expression`);
  }

  return root;
}

/** Convenience: compile and sample, returning only finite points. */
export function samplePoints(source: string, xMin: number, xMax: number, steps = 240): [number, number][] {
  const fn = compileExpression(source);
  const points: [number, number][] = [];
  const dx = (xMax - xMin) / steps;

  for (let i = 0; i <= steps; i++) {
    const x = xMin + i * dx;
    const y = fn(x);
    // Skip poles and undefined regions rather than drawing a spike through them.
    if (Number.isFinite(y)) points.push([x, y]);
  }
  return points;
}
