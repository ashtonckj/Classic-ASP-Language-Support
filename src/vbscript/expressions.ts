/**
 * expressions.ts
 *
 * Small helpers for reading the expressions of the syntax tree: the ones a
 * statement holds, everything inside an expression, and the pieces of a
 * string built with `&`, which is how an ASP page builds its SQL.
 */

import type * as A from './ast';

/** The expressions written in a statement itself, not in the statements nested in it. */
export function statementExpressions(s: A.Stmt): A.Expr[] {
    const present = (e: A.Expr | null | undefined): e is A.Expr => !!e;
    switch (s.kind) {
        case 'Dim':      return s.declarators.flatMap(d => d.bounds ?? []);
        case 'Const':    return s.declarators.map(d => d.value);
        case 'Assign':   return [s.target, s.value];
        case 'CallStmt': return [s.callee, ...s.args.filter(present)];
        case 'Output':   return [s.value];
        case 'If':       return s.branches.map(b => b.condition).filter(present);
        case 'Select':   return [s.subject, ...s.cases.flatMap(c => c.values ?? [])];
        case 'For':      return [s.from, s.to, s.step].filter(present);
        case 'ForEach':  return [s.collection];
        case 'Do':       return [s.pre?.expr, s.post?.expr].filter(present);
        case 'While':    return [s.condition];
        case 'With':     return [s.object];
        case 'Erase':    return s.targets;
        case 'Error':    return s.expr ? [s.expr] : [];
        default:         return [];
    }
}

/** The expressions directly inside one. */
export function childExpressions(e: A.Expr): A.Expr[] {
    switch (e.kind) {
        case 'Member': return e.object ? [e.object] : [];
        case 'Call':   return [e.callee, ...e.args.filter((a): a is A.Expr => a !== null)];
        case 'Unary':  return [e.operand];
        case 'Binary': return [e.left, e.right];
        case 'Paren':  return [e.expr];
        default:       return [];
    }
}

/**
 * Calls `visit` on `e` and every expression inside it, outside in. When
 * `visit` returns false, what is inside that expression is skipped.
 *
 * A chain of `&`, `.` or `(…)` is a tree as deep as the chain is long, and a
 * page may join thousands of strings in one statement, so the walk keeps its
 * own stack rather than recursing.
 */
export function walkExpression(e: A.Expr, visit: (e: A.Expr) => boolean | void): void {
    const stack = [e];
    while (stack.length > 0) {
        const next = stack.pop()!;
        if (visit(next) === false) { continue; }
        const children = childExpressions(next);
        for (let i = children.length - 1; i >= 0; i--) { stack.push(children[i]); }
    }
}

export function isConcat(e: A.Expr): e is A.BinaryExpr {
    return e.kind === 'Binary' && e.op === '&';
}

/** The pieces joined by `&`, in order: `"a" & b & "c"` gives `"a"`, `b`, `"c"`. Anything else is one piece. */
export function concatOperands(e: A.Expr): A.Expr[] {
    const operands: A.Expr[] = [];
    const stack = [e];
    while (stack.length > 0) {
        const next = stack.pop()!;
        if (isConcat(next)) { stack.push(next.right, next.left); } else { operands.push(next); }
    }
    return operands;
}

export function isStringLiteral(e: A.Expr): e is A.LiteralExpr {
    return e.kind === 'Literal' && e.type === 'string';
}

/** What a string literal holds, with `""` read as one quote. */
export function stringValue(literal: A.LiteralExpr): string {
    return literal.raw.slice(1, literal.raw.endsWith('"') && literal.raw.length > 1 ? -1 : undefined).replace(/""/g, '"');
}
