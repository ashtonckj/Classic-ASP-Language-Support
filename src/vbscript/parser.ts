/**
 * parser.ts
 *
 * An error-tolerant recursive-descent parser for VBScript. It builds the tree
 * in ast.ts from the tokens of one program (see pageSegments.ts) and never
 * throws: half-typed code is the normal case in an editor, so every error is
 * recorded as a diagnostic and parsing carries on at the next statement.
 *
 * Recovery works on two levels:
 *   - Inside a statement, the first error skips the rest of the statement, to
 *     the next line break or `:`.
 *   - Blocks close on their own keyword or on one that belongs to a block
 *     further out. An `End Sub` inside an unclosed `If` reports the missing
 *     `End If` and still closes the Sub, and a `Sub` line inside another Sub
 *     (a forgotten `End Sub`) ends the first one, so one mistake does not turn
 *     the rest of the page into errors.
 *
 * The grammar rules and the error wording follow cscript.exe, which is what
 * IIS runs. The checks that need names rather than syntax, such as a name
 * declared twice, are not done here.
 */

import type * as A from './ast';
import { tokenize, Token, TokenKind } from './lexer';
import type { Segment } from './pageSegments';

/** Words that can never be a plain name. After a `.` any word is a name. */
const RESERVED = new Set([
    'and', 'byref', 'byval', 'call', 'case', 'class', 'const', 'dim', 'do', 'each', 'else',
    'elseif', 'empty', 'end', 'eqv', 'exit', 'false', 'for', 'function', 'get', 'goto', 'if',
    'imp', 'in', 'is', 'let', 'loop', 'mod', 'new', 'next', 'not', 'nothing', 'null', 'on',
    'option', 'or', 'preserve', 'private', 'public', 'redim', 'resume', 'select', 'set',
    'stop', 'sub', 'then', 'to', 'true', 'until', 'wend', 'while', 'with', 'xor',
]);

type BlockKind = 'if' | 'select' | 'for' | 'foreach' | 'do' | 'while' | 'with' | 'sub' | 'function' | 'property' | 'class';

const PROCEDURE_KINDS = new Set<BlockKind>(['sub', 'function', 'property']);

const END_WORDS: Record<string, BlockKind> = {
    if: 'if', select: 'select', with: 'with', sub: 'sub', function: 'function', property: 'property', class: 'class',
};

/** How deep expressions may nest before the parser gives up on one, so no input can overflow the stack. */
const MAX_DEPTH = 500;

export function parseProgram(text: string, segments: Segment[], server = true): A.Program {
    const { tokens, comments } = tokenize(text, segments);
    const parser = new Parser(tokens);
    const body = parser.parseModule();
    return {
        start: segments.length > 0 ? segments[0].start : 0,
        end: segments.length > 0 ? segments[segments.length - 1].end : 0,
        body,
        diagnostics: parser.diagnostics,
        comments,
        server,
    };
}

class Parser {
    readonly diagnostics: A.Diagnostic[] = [];

    private pos = 0;
    private readonly blocks: BlockKind[] = [];
    /** Set by the first error in a statement; later errors in the same statement are noise. */
    private panic = false;
    /** Above 0 while parsing the statements of a one-line `If … Then … Else …`. */
    private singleLine = 0;
    private depth = 0;
    private sawStatement = false;
    /**
     * Set when a block ended without its closing keyword, at the start of a
     * statement that belongs further out. That statement must not then be
     * skipped as junk after the block.
     */
    private endedEarly = false;
    /** The variables of the For and For Each loops open around the current statement. */
    private readonly loopVariables: string[] = [];

    constructor(private readonly tokens: Token[]) {}

    // ── Token helpers ────────────────────────────────────────────────────────

    private get tok(): Token { return this.tokens[this.pos]; }

    private peek(n: number): Token {
        return this.tokens[Math.min(this.pos + n, this.tokens.length - 1)];
    }

    private advance(): Token {
        const t = this.tokens[this.pos];
        if (this.pos < this.tokens.length - 1) { this.pos++; }
        return t;
    }

    /** The lowercase keyword `n` tokens ahead, or null when that token is not a bare word. */
    private word(n = 0): string | null {
        const t = this.peek(n);
        return t.kind === TokenKind.Identifier && !t.bracketed ? t.value : null;
    }

    private isPunct(value: string, n = 0): boolean {
        const t = this.peek(n);
        return t.kind === TokenKind.Punct && t.value === value;
    }

    private get prevEnd(): number {
        return this.pos > 0 ? this.tokens[this.pos - 1].end : this.tok.start;
    }

    private atEOS(): boolean {
        const k = this.tok.kind;
        if (k === TokenKind.Newline || k === TokenKind.Colon || k === TokenKind.EOF) { return true; }
        if (this.singleLine > 0) {
            const w = this.word();
            return w === 'else' || (w === 'end' && this.word(1) === 'if');
        }
        return false;
    }

    private error(start: number, end: number, message: string, code?: A.Diagnostic['code']): void {
        if (this.panic) { return; }
        this.panic = true;
        this.diagnostics.push(code ? { start, end, message, code } : { start, end, message });
    }

    /** The span from the current token to the one `n` tokens on, both included. */
    private spanTo(n: number): A.Span {
        return { start: this.tok.start, end: this.peek(n).end };
    }

    private errorAtTok(message: string): void {
        const t = this.tok;
        this.error(t.start, t.end, message);
    }

    /** Skips to the end of the statement. Returns the skipped span, if any. */
    private skipToEOS(): A.Span | null {
        const start = this.tok.start;
        let end = start;
        while (!this.atEOS()) { end = this.advance().end; }
        return end > start ? { start, end } : null;
    }

    private expectEOS(): void {
        if (this.atEOS()) { return; }
        const t = this.tok;
        this.errorAtTok(t.kind === TokenKind.Invalid ? t.error ?? 'Invalid character' : 'Expected end of statement');
        this.skipToEOS();
    }

    private expectWord(w: string, display: string): boolean {
        if (this.word() === w) { this.advance(); return true; }
        this.errorAtTok(`Expected '${display}'`);
        return false;
    }

    private expectPunct(p: string): boolean {
        if (this.isPunct(p)) { this.advance(); return true; }
        this.errorAtTok(`Expected '${p}'`);
        return false;
    }

    private nameFrom(t: Token): A.Name {
        return { name: t.value, text: t.text ?? t.value, start: t.start, end: t.end };
    }

    /** A declarable name: any word that is not reserved or `Me`, or any `[bracketed]` name. */
    private parseName(): A.Name | null {
        const t = this.tok;
        if (t.kind === TokenKind.Identifier && (t.bracketed || (!RESERVED.has(t.value) && t.value !== 'me'))) {
            this.advance();
            return this.nameFrom(t);
        }
        this.errorAtTok('Expected identifier');
        return null;
    }

    private missingName(): A.Name {
        const at = this.tok.start;
        return { name: '', text: '', start: at, end: at };
    }

    // ── Blocks ───────────────────────────────────────────────────────────────

    parseModule(): A.Stmt[] {
        return this.parseBlock();
    }

    /**
     * Statements up to the keyword that ends the innermost open block, or one
     * that ends a block further out, or the end of the program. The caller
     * checks which it was.
     */
    private parseBlock(): A.Stmt[] {
        const body: A.Stmt[] = [];
        for (;;) {
            while (this.tok.kind === TokenKind.Newline || this.tok.kind === TokenKind.Colon) { this.advance(); }
            if (this.tok.kind === TokenKind.EOF) { break; }
            if (this.blocks.some(k => this.closes(k))) { break; }

            this.panic = false;
            const before = this.pos;
            const stmt = this.parseStatement();
            if (stmt) { body.push(stmt); }
            this.endStatement(before);
        }
        return body;
    }

    /** After a statement: the rest of the line must be empty, unless a block ended early. */
    private endStatement(before: number): void {
        if (this.endedEarly) { this.endedEarly = false; }
        else { this.expectEOS(); }
        if (this.pos === before) { this.advance(); }
    }

    /** True when the statement starting here is a procedure or class header. */
    private atProcedureStart(): boolean {
        let n = 0;
        if (this.word(n) === 'public' || this.word(n) === 'private') { n++; }
        if (this.word(n) === 'default') { n++; }
        const w = this.word(n);
        if (w === 'sub' || w === 'function' || w === 'class') { return true; }
        if (w === 'property') {
            const acc = this.word(n + 1);
            return acc === 'get' || acc === 'let' || acc === 'set';
        }
        return false;
    }

    private atClassStart(): boolean {
        const w = this.word();
        return w === 'class' || ((w === 'public' || w === 'private') && this.word(1) === 'class');
    }

    private atEnd(of: string): boolean {
        return this.word() === 'end' && this.word(1) === of;
    }

    /** True when the statement starting here ends, or continues, an open block of `kind`. */
    private closes(kind: BlockKind): boolean {
        const w = this.word();
        switch (kind) {
            // A Sub or Function may sit inside an If or a Select Case, oddly, but not
            // inside a loop or a With, and a Class may sit in none of them.
            case 'if':      return w === 'elseif' || w === 'else' || this.atEnd('if') || this.atClassStart();
            case 'select':  return w === 'case' || this.atEnd('select') || this.atClassStart();
            case 'for':
            case 'foreach': return w === 'next' || this.atProcedureStart();
            case 'do':      return w === 'loop' || this.atProcedureStart();
            case 'while':   return w === 'wend' || this.atProcedureStart();
            case 'with':    return this.atEnd('with') || this.atProcedureStart();
            case 'sub':
            case 'function':
            case 'property':
                return this.atEnd('sub') || this.atEnd('function') || this.atEnd('property') || this.atEnd('class')
                    || this.atProcedureStart() || w === 'public' || w === 'private';
            case 'class':   return this.atEnd('class') || this.atClassStart();
        }
    }

    /** Reports a block that was never closed, at the token that ended it. */
    private unclosed(display: string): void {
        this.panic = false;
        this.errorAtTok(`Expected '${display}'`);
        this.endedEarly = true;
    }

    /** Consumes a one-word closer such as `Next`, or reports it missing. Returns its span. */
    private parseCloser(word: string, display: string): A.Span | null {
        if (this.word() !== word) { this.unclosed(display); return null; }
        const t = this.advance();
        return { start: t.start, end: t.end };
    }

    /** Consumes `End <word>`, or reports it missing. Returns the End statement's span. */
    private parseEnd(word: string, display: string): A.Span | null {
        if (!this.atEnd(word)) { this.unclosed(display); return null; }
        const start = this.advance().start;
        const end = this.advance().end;
        return { start, end };
    }

    // ── Statements ───────────────────────────────────────────────────────────

    private parseStatement(): A.Stmt | null {
        const t = this.tok;
        const first = !this.sawStatement;
        this.sawStatement = true;

        if (t.kind === TokenKind.Html) {
            this.advance();
            return { kind: 'Html', start: t.start, end: t.end };
        }
        if (t.kind === TokenKind.Output) {
            this.advance();
            const value = this.parseExpr();
            return { kind: 'Output', start: t.start, end: value.end, value };
        }
        if (t.kind === TokenKind.Punct && t.value === '.') {
            return this.parseAssignOrCall();
        }
        if (t.kind === TokenKind.Invalid) {
            this.error(t.start, t.end, t.error ?? 'Invalid character');
            return this.errorStmt();
        }
        if (t.kind !== TokenKind.Identifier) {
            this.errorAtTok('Expected statement');
            return this.errorStmt();
        }
        if (t.bracketed) { return this.parseAssignOrCall(); }

        switch (t.value) {
            case 'option':   return this.parseOption(first);
            case 'dim':      return this.parseDim();
            case 'redim':    return this.parseDim();
            case 'const':    return this.parseConst(t.start, null);
            case 'public':
            case 'private':  return this.parseAccessModifier();
            case 'default':
                return this.atProcedureStart() ? this.parseProcedure() : this.parseAssignOrCall();
            case 'set':      return this.parseSetOrLet(true);
            case 'let':
                // VBScript reserves Let but has no Let statement. Read it as an
                // assignment anyway, so the rest of the tree is still useful.
                this.errorAtTok('Expected statement');
                return this.parseSetOrLet(false);
            case 'call':     return this.parseCallKeyword();
            case 'if':       return this.parseIf();
            case 'select':   return this.parseSelect();
            case 'for':      return this.parseFor();
            case 'do':       return this.parseDo();
            case 'while':    return this.parseWhile();
            case 'with':     return this.parseWith();
            case 'sub':
            case 'function': return this.parseProcedure();
            case 'property':
                return this.atProcedureStart() ? this.parseProcedure() : this.parseAssignOrCall();
            case 'class':    return this.parseClass();
            case 'on':       return this.parseOnError();
            case 'exit':     return this.parseExit();
            case 'erase':
                return this.isPunct('=', 1) ? this.parseAssignOrCall() : this.parseErase();
            case 'stop':
                this.advance();
                return { kind: 'Stop', start: t.start, end: t.end };
            case 'next':
                this.error(t.start, t.end, "Unexpected 'Next'", 'stray-closer');
                return this.errorStmt();
            case 'loop':
                this.error(t.start, t.end, "'Loop' without 'Do'", 'stray-closer');
                return this.errorStmt();
            case 'wend':
                this.error(t.start, t.end, "'Wend' without 'While'", 'stray-closer');
                return this.errorStmt();
            case 'end': {
                const what = this.word(1);
                if (what && END_WORDS[what]) {
                    const span = this.spanTo(1);
                    this.error(span.start, span.end, `'End ${capitalise(what)}' without a matching '${capitalise(what)}'`, 'stray-closer');
                } else {
                    this.errorAtTok('Expected statement');
                }
                return this.errorStmt();
            }
        }

        if (RESERVED.has(t.value)) {
            this.errorAtTok('Expected statement');
            return this.errorStmt();
        }
        return this.parseAssignOrCall();
    }

    private errorStmt(): A.ErrorStmt | null {
        const span = this.skipToEOS();
        return span ? { kind: 'Error', ...span } : null;
    }

    private parseOption(first: boolean): A.Stmt {
        const start = this.advance().start;
        this.expectWord('explicit', 'Explicit');
        if (!first) { this.error(start, this.prevEnd, 'Option Explicit must be the first statement on the page'); }
        return { kind: 'OptionExplicit', start, end: this.prevEnd };
    }

    private parseDim(): A.DimStmt {
        const kwTok = this.advance();
        const keyword = kwTok.value as A.DimStmt['keyword'];
        let preserve = false;
        if (keyword === 'redim' && this.word() === 'preserve') { this.advance(); preserve = true; }

        const declarators: A.Declarator[] = [];
        for (;;) {
            const name = this.parseName();
            if (!name) {
                // `Dim empty, total`: report the reserved word, keep reading the list.
                if (this.tok.kind === TokenKind.Identifier && this.peek(1).kind === TokenKind.Punct && this.peek(1).value === ',') {
                    this.advance();
                    this.advance();
                    continue;
                }
                break;
            }
            let bounds: A.Expr[] | null = null;
            if (this.isPunct('(')) {
                this.advance();
                bounds = [];
                if (!this.isPunct(')')) {
                    do { bounds.push(this.parseExpr()); } while (this.isPunct(',') && this.advance());
                }
                // Only ReDim takes a size worked out at run time; Dim needs a whole number.
                const loose = keyword === 'redim' ? undefined : bounds.find(b => !isIntegerLiteral(b));
                if (loose && loose.kind !== 'Missing') { this.error(loose.start, loose.end, 'Expected integer constant'); }
                this.expectPunct(')');
            } else if (keyword === 'redim') {
                this.errorAtTok("Expected '('");
            }
            declarators.push({ name, bounds, start: name.start, end: this.prevEnd });
            if (!this.isPunct(',')) { break; }
            this.advance();
        }
        return { kind: 'Dim', keyword, preserve, declarators, start: kwTok.start, end: this.prevEnd };
    }

    private parseConst(start: number, access: A.ConstStmt['access']): A.ConstStmt {
        this.advance(); // Const
        const declarators: A.ConstStmt['declarators'] = [];
        for (;;) {
            const name = this.parseName();
            if (!name) { break; }
            if (!this.expectPunct('=')) { break; }
            const value = this.parseExpr();
            if (value.kind !== 'Missing' && !isLiteralConstant(value)) {
                this.error(value.start, value.end, 'Expected literal constant');
            }
            declarators.push({ name, value, start: name.start, end: value.end });
            if (!this.isPunct(',')) { break; }
            this.advance();
        }
        return { kind: 'Const', access, declarators, start, end: this.prevEnd };
    }

    private parseAccessModifier(): A.Stmt | null {
        const next = this.word(1);
        if (this.atProcedureStart() && next !== 'class') { return this.parseProcedure(); }
        if (next === 'class') {
            this.error(this.peek(1).start, this.peek(1).end, 'Expected identifier');
            this.advance();
            return this.parseClass();
        }
        if (next === 'const') {
            const modTok = this.advance();
            return this.parseConst(modTok.start, modTok.value as 'public' | 'private');
        }
        return this.parseDim();
    }

    private parseSetOrLet(isSet: boolean): A.AssignStmt {
        const start = this.advance().start;
        const target = this.parsePostfix().expr;
        this.expectPunct('=');
        const value = this.parseExpr();
        return { kind: 'Assign', set: isSet, target, value, start, end: value.end };
    }

    private parseCallKeyword(): A.CallStmt {
        const start = this.advance().start;
        const { expr } = this.parsePostfix();
        const [callee, args] = expr.kind === 'Call' ? [expr.callee, expr.args] : [expr, []];
        return { kind: 'CallStmt', callee, args, hasCallKeyword: true, start, end: expr.end };
    }

    /**
     * A statement that starts with a name: an assignment (`x = 1`,
     * `a(1).b = 2`) or a call (`Foo`, `Foo a, b`, `Foo(a)`, `Foo (a) & b`).
     *
     * The chain is read first, brackets included. If an `=` follows, it is an
     * assignment. If the statement ends, it is a call, and brackets around
     * more than one argument are an error, as in IIS. Otherwise the last
     * bracketed group was the start of the first argument, as in
     * `Response.Write (a) & b`, and the arguments are read again from there.
     */
    private parseAssignOrCall(): A.Stmt {
        const start = this.tok.start;
        const chain = this.parsePostfix();

        if (this.isPunct('=')) {
            this.advance();
            const value = this.parseExpr();
            return { kind: 'Assign', set: false, target: chain.expr, value, start, end: value.end };
        }

        if (this.atEOS()) {
            const expr = chain.expr;
            if (expr.kind === 'Call') {
                if (expr.args.length > 1) {
                    this.error(expr.start, expr.end, 'Cannot use parentheses when calling a Sub');
                }
                return { kind: 'CallStmt', callee: expr.callee, args: expr.args, hasCallKeyword: false, start, end: expr.end };
            }
            return { kind: 'CallStmt', callee: expr, args: [], hasCallKeyword: false, start, end: expr.end };
        }

        let callee = chain.expr;
        if (chain.lastGroup) {
            callee = chain.lastGroup.callee;
            this.pos = chain.lastGroup.tokenIndex;
        }
        const args = this.parseArgList();
        return { kind: 'CallStmt', callee, args, hasCallKeyword: false, start, end: this.prevEnd };
    }

    /** Arguments without brackets: `a, , c`. An omitted one is null. */
    private parseArgList(): (A.Expr | null)[] {
        const args: (A.Expr | null)[] = [];
        for (;;) {
            if (this.isPunct(',')) { args.push(null); this.advance(); continue; }
            args.push(this.parseExpr());
            if (!this.isPunct(',')) { break; }
            this.advance();
            if (this.atEOS()) { break; }
        }
        return args;
    }

    private parseIf(): A.IfStmt {
        const opener = this.spanTo(0);
        const start = this.advance().start;
        const condition = this.parseExpr();
        this.expectWord('then', 'Then');

        if (this.tok.kind !== TokenKind.Newline && this.tok.kind !== TokenKind.EOF) {
            return this.parseSingleLineIf(start, opener, condition);
        }
        let closer: A.Span | null = null;

        const branches: A.IfBranch[] = [];
        let branchStart = start;
        let branchCond: A.Expr | null = condition;

        this.blocks.push('if');
        for (;;) {
            const body = this.parseBlock();
            branches.push({ condition: branchCond, body, start: branchStart, end: this.prevEnd });

            const w = this.word();
            if ((w === 'elseif' || w === 'else' || this.atEnd('if')) && this.tokens[this.pos - 1]?.kind === TokenKind.Colon) {
                this.panic = false;
                this.errorAtTok('Must be first statement on the line');
            }
            if (w === 'elseif' && branchCond !== null) {
                branchStart = this.advance().start;
                branchCond = this.parseExpr();
                this.expectWord('then', 'Then');
                continue;
            }
            if (w === 'else' && branchCond !== null) {
                branchStart = this.advance().start;
                branchCond = null;
                continue;
            }
            closer = this.parseEnd('if', 'End If');
            break;
        }
        this.blocks.pop();
        return { kind: 'If', singleLine: false, branches, opener, closer, start, end: this.prevEnd };
    }

    /** `If c Then a : b Else d`, all on one line. A trailing `End If` is tolerated, as IIS tolerates it. */
    private parseSingleLineIf(start: number, opener: A.Span, condition: A.Expr): A.IfStmt {
        this.singleLine++;
        const branches: A.IfBranch[] = [];
        const thenStart = this.tok.start;
        const thenBody = this.parseSingleLineBody();
        branches.push({ condition, body: thenBody, start: thenStart, end: this.prevEnd });

        if (this.word() === 'else') {
            if (thenBody.length === 0) { this.errorAtTok('Expected statement'); }
            const elseStart = this.advance().start;
            const elseBody = this.parseSingleLineBody();
            branches.push({ condition: null, body: elseBody, start: elseStart, end: this.prevEnd });
        }
        if (this.atEnd('if')) { this.advance(); this.advance(); }
        this.singleLine--;
        return { kind: 'If', singleLine: true, branches, opener, closer: null, start, end: this.prevEnd };
    }

    private parseSingleLineBody(): A.Stmt[] {
        const body: A.Stmt[] = [];
        for (;;) {
            while (this.tok.kind === TokenKind.Colon) { this.advance(); }
            const k = this.tok.kind;
            if (k === TokenKind.Newline || k === TokenKind.EOF) { break; }
            if (this.word() === 'else' || this.atEnd('if')) { break; }

            const before = this.pos;
            const stmt = this.parseStatement();
            if (stmt) { body.push(stmt); }
            this.endStatement(before);
        }
        return body;
    }

    private parseSelect(): A.SelectStmt {
        const opener = this.spanTo(this.word(1) === 'case' ? 1 : 0);
        const start = this.advance().start;
        this.expectWord('case', 'Case');
        const subject = this.parseExpr();
        this.expectEOS();

        this.blocks.push('select');
        // Anything before the first Case is an error, which IIS reports at the
        // Case (or End Select) that follows it.
        const before = this.parseBlock();
        if (before.length > 0) {
            this.panic = false;
            this.errorAtTok("Expected 'Case'");
        }

        const cases: A.CaseClause[] = [];
        let closer: A.Span | null = null;
        for (;;) {
            if (this.word() === 'case') {
                const caseStart = this.advance().start;
                let values: A.Expr[] | null = null;
                if (this.word() === 'else') {
                    this.advance();
                } else {
                    values = [];
                    do { values.push(this.parseExpr()); } while (this.isPunct(',') && this.advance());
                }
                this.expectEOS();
                const body = this.parseBlock();
                cases.push({ values, body, start: caseStart, end: this.prevEnd });
                continue;
            }
            closer = this.parseEnd('select', 'End Select');
            break;
        }
        this.blocks.pop();
        return { kind: 'Select', subject, cases, opener, closer, start, end: this.prevEnd };
    }

    private parseFor(): A.ForStmt | A.ForEachStmt {
        const isEach = this.word(1) === 'each';
        const opener = this.spanTo(isEach ? 1 : 0);
        const start = this.advance().start;

        if (isEach) {
            this.advance();
            const variable = this.parseName() ?? this.missingName();
            this.expectWord('in', 'In');
            const collection = this.parseExpr();
            const { body, closer } = this.parseLoopBody('foreach', variable);
            return { kind: 'ForEach', variable, collection, body, opener, closer, start, end: this.prevEnd };
        }

        const counter = this.parseName() ?? this.missingName();
        this.expectPunct('=');
        const from = this.parseExpr();
        this.expectWord('to', 'To');
        const to = this.parseExpr();
        let step: A.Expr | null = null;
        if (this.word() === 'step') { this.advance(); step = this.parseExpr(); }
        const { body, closer } = this.parseLoopBody('for', counter);
        return { kind: 'For', counter, from, to, step, body, opener, closer, start, end: this.prevEnd };
    }

    /** A nested loop may not reuse the variable of a loop around it. */
    private parseLoopBody(kind: 'for' | 'foreach', variable: A.Name): { body: A.Stmt[]; closer: A.Span | null } {
        if (variable.name && this.loopVariables.includes(variable.name)) {
            this.error(variable.start, variable.end, "Invalid 'for' loop control variable");
        }
        this.expectEOS();
        this.blocks.push(kind);
        this.loopVariables.push(variable.name);
        const body = this.parseBlock();
        const closer = this.parseCloser('next', 'Next');
        this.loopVariables.pop();
        this.blocks.pop();
        return { body, closer };
    }

    private parseLoopCondition(): A.LoopCondition | null {
        const w = this.word();
        if (w !== 'while' && w !== 'until') { return null; }
        this.advance();
        return { until: w === 'until', expr: this.parseExpr() };
    }

    private parseDo(): A.DoStmt {
        const opener = this.spanTo(this.word(1) === 'while' || this.word(1) === 'until' ? 1 : 0);
        const start = this.advance().start;
        const pre = this.parseLoopCondition();
        this.expectEOS();
        this.blocks.push('do');
        const body = this.parseBlock();
        let post: A.LoopCondition | null = null;
        const closer = this.parseCloser('loop', 'Loop');
        // A loop has its condition at the top or the bottom, never both.
        if (closer && !pre) { post = this.parseLoopCondition(); }
        this.blocks.pop();
        return { kind: 'Do', pre, post, body, opener, closer, start, end: this.prevEnd };
    }

    private parseWhile(): A.WhileStmt {
        const opener = this.spanTo(0);
        const start = this.advance().start;
        const condition = this.parseExpr();
        this.expectEOS();
        this.blocks.push('while');
        const body = this.parseBlock();
        const closer = this.parseCloser('wend', 'Wend');
        this.blocks.pop();
        return { kind: 'While', condition, body, opener, closer, start, end: this.prevEnd };
    }

    private parseWith(): A.WithStmt {
        const opener = this.spanTo(0);
        const start = this.advance().start;
        const object = this.parseExpr();
        this.expectEOS();
        this.blocks.push('with');
        const body = this.parseBlock();
        const closer = this.parseEnd('with', 'End With');
        this.blocks.pop();
        return { kind: 'With', object, body, opener, closer, start, end: this.prevEnd };
    }

    private parseProcedure(): A.ProcedureStmt | A.ClassStmt {
        const start = this.tok.start;
        let access: A.ProcedureStmt['access'] = null;
        let isDefault = false;

        const w = this.word();
        if (w === 'public' || w === 'private') { access = w; this.advance(); }
        if (this.word() === 'default') {
            const d = this.advance();
            isDefault = true;
            if (access !== 'public') { this.error(d.start, d.end, "'Default' specification must also specify 'Public'"); }
        }

        if (this.word() === 'class') {
            // `Public Default Class C`: report it, then read the class anyway.
            this.error(start, this.tok.end, 'Expected identifier');
            return this.parseClass();
        }
        const opener = this.spanTo(0);
        const procKind = this.advance().value as A.ProcedureStmt['procKind'];
        let accessor: A.ProcedureStmt['accessor'] = null;
        if (procKind === 'property') {
            accessor = this.advance().value as 'get' | 'let' | 'set';
            if (isDefault && accessor !== 'get') {
                this.error(start, this.prevEnd, "'Default' specification can only be on Property Get");
            }
        }

        const name = this.parseName() ?? this.missingName();

        let paramList: A.Span | null = null;
        const params: A.Parameter[] = [];
        if (this.isPunct('(')) {
            const open = this.advance();
            while (!this.isPunct(')') && !this.atEOS()) {
                const pStart = this.tok.start;
                let passing: A.Parameter['passing'] = null;
                const pw = this.word();
                if (pw === 'byval' || pw === 'byref') { passing = pw; this.advance(); }
                const pname = this.parseName();
                if (!pname) { break; }
                let isArray = false;
                if (this.isPunct('(') && this.isPunct(')', 1)) { this.advance(); this.advance(); isArray = true; }
                params.push({ name: pname, passing, isArray, start: pStart, end: this.prevEnd });
                if (!this.isPunct(',')) { break; }
                this.advance();
            }
            paramList = { start: open.end, end: this.tok.start };
            this.expectPunct(')');
        } else if (!this.atEOS()) {
            // Code may follow `Sub A()` on the same line, but not a bare `Sub A`.
            this.errorAtTok("Expected '('");
            this.skipToEOS();
        }

        this.blocks.push(procKind);
        const body = this.parseBlock();

        let endStatement: A.Span | null = null;
        let closer: A.Span | null = null;
        const endWord = this.word(1);
        if (this.word() === 'end' && (endWord === 'sub' || endWord === 'function' || endWord === 'property')) {
            endStatement = this.spanTo(1);
            if (endWord === procKind) {
                closer = endStatement;
            } else {
                // `End Function` ending a Sub: it still ends it, but it is no closer for it.
                this.panic = false;
                this.error(endStatement.start, endStatement.end, `Expected 'End ${capitalise(procKind)}'`, 'stray-closer');
            }
            this.advance();
            this.advance();
        } else {
            this.unclosed(`End ${capitalise(procKind)}`);
        }
        this.blocks.pop();

        return {
            kind: 'Procedure', procKind, accessor, access, isDefault, name, paramList, params, body, endStatement,
            opener, closer, start, end: this.prevEnd,
        };
    }

    private parseClass(): A.ClassStmt {
        const opener = this.spanTo(0);
        const start = this.advance().start;
        const name = this.parseName() ?? this.missingName();
        this.expectEOS();

        this.blocks.push('class');
        const members = this.parseBlock();
        for (const m of members) {
            const allowed = m.kind === 'Procedure' || (m.kind === 'Dim' && m.keyword !== 'redim') || m.kind === 'Error';
            if (!allowed) {
                this.panic = false;
                this.error(m.start, m.end, 'Only declarations are allowed directly inside a Class');
            }
        }
        const closer = this.parseEnd('class', 'End Class');
        this.blocks.pop();
        return { kind: 'Class', name, members, endStatement: closer, opener, closer, start, end: this.prevEnd };
    }

    private parseOnError(): A.OnErrorStmt {
        const start = this.advance().start;
        this.expectWord('error', 'Error');
        let resumeNext = false;
        if (this.word() === 'resume') {
            this.advance();
            this.expectWord('next', 'Next');
            resumeNext = true;
        } else if (this.word() === 'goto') {
            this.advance();
            if (this.tok.kind === TokenKind.Number && this.tok.value === '0') { this.advance(); }
            else { this.errorAtTok("Expected '0'"); }
        } else {
            this.errorAtTok("Expected 'Resume Next' or 'GoTo 0'");
        }
        return { kind: 'OnError', resumeNext, start, end: this.prevEnd };
    }

    private parseExit(): A.ExitStmt {
        const exitTok = this.advance();
        const target = this.word() ?? '';

        let ok = false;
        let wrongProcedure: string | null = null;
        for (let i = this.blocks.length - 1; i >= 0; i--) {
            const b = this.blocks[i];
            if (PROCEDURE_KINDS.has(b)) {
                if (target === b) { ok = true; }
                else if (PROCEDURE_KINDS.has(target as BlockKind)) { wrongProcedure = b; }
                break;
            }
            if ((target === 'for' && (b === 'for' || b === 'foreach')) || (target === 'do' && b === 'do')) { ok = true; break; }
        }

        if (['do', 'for', 'sub', 'function', 'property'].includes(target)) { this.advance(); }
        if (wrongProcedure) {
            this.error(this.prevEnd - target.length, this.prevEnd, `Expected '${capitalise(wrongProcedure)}'`);
        } else if (!ok) {
            this.error(exitTok.start, this.prevEnd, "Invalid 'exit' statement");
        }
        return { kind: 'Exit', target, start: exitTok.start, end: this.prevEnd };
    }

    private parseErase(): A.EraseStmt {
        const start = this.advance().start;
        const targets: A.Expr[] = [];
        while (!this.atEOS()) {
            targets.push(this.parsePostfix().expr);
            if (!this.isPunct(',')) { break; }
            this.advance();
        }
        return { kind: 'Erase', targets, start, end: this.prevEnd };
    }

    // ── Expressions ──────────────────────────────────────────────────────────
    //
    // Lowest to highest: Imp, Eqv, Xor, Or, And, Not, comparison (= <> < > <=
    // >= Is), &, + -, Mod, \, * /, unary - +, ^. `-2 ^ 2` is -4, and the right
    // side of ^ may carry its own sign: `2 ^ -1`.

    parseExpr(): A.Expr {
        if (++this.depth > MAX_DEPTH) {
            this.depth--;
            this.errorAtTok('Expression is nested too deeply');
            const at = this.tok.start;
            return { kind: 'Missing', start: at, end: at };
        }
        const e = this.parseBinaryWords(0);
        this.depth--;
        return e;
    }

    private static readonly WORD_LEVELS = ['imp', 'eqv', 'xor', 'or', 'and'];

    private parseBinaryWords(level: number): A.Expr {
        if (level === Parser.WORD_LEVELS.length) { return this.parseNot(); }
        let left = this.parseBinaryWords(level + 1);
        while (this.word() === Parser.WORD_LEVELS[level]) {
            const op = this.advance().value;
            const right = this.parseBinaryWords(level + 1);
            left = { kind: 'Binary', op, left, right, start: left.start, end: right.end };
        }
        return left;
    }

    private parseNot(): A.Expr {
        if (this.word() === 'not') {
            const start = this.advance().start;
            const operand = this.parseNot();
            return { kind: 'Unary', op: 'not', operand, start, end: operand.end };
        }
        return this.parseComparison();
    }

    private parseComparison(): A.Expr {
        let left = this.parseConcat();
        for (;;) {
            const t = this.tok;
            const isCmp = (t.kind === TokenKind.Punct && ['=', '<>', '<', '>', '<=', '>='].includes(t.value)) || this.word() === 'is';
            if (!isCmp) { return left; }
            this.advance();
            const right = this.parseConcat();
            left = { kind: 'Binary', op: t.value, left, right, start: left.start, end: right.end };
        }
    }

    private parsePunctLevel(ops: string[], next: () => A.Expr): A.Expr {
        let left = next();
        while (this.tok.kind === TokenKind.Punct && ops.includes(this.tok.value)) {
            const op = this.advance().value;
            const right = next();
            left = { kind: 'Binary', op, left, right, start: left.start, end: right.end };
        }
        return left;
    }

    private parseConcat(): A.Expr { return this.parsePunctLevel(['&'], () => this.parseAdditive()); }
    private parseAdditive(): A.Expr { return this.parsePunctLevel(['+', '-'], () => this.parseMod()); }

    private parseMod(): A.Expr {
        let left = this.parseIntDiv();
        while (this.word() === 'mod') {
            this.advance();
            const right = this.parseIntDiv();
            left = { kind: 'Binary', op: 'mod', left, right, start: left.start, end: right.end };
        }
        return left;
    }

    private parseIntDiv(): A.Expr { return this.parsePunctLevel(['\\'], () => this.parseMultiplicative()); }
    private parseMultiplicative(): A.Expr { return this.parsePunctLevel(['*', '/'], () => this.parseUnary()); }

    private parseUnary(): A.Expr {
        if (this.isPunct('-') || this.isPunct('+')) {
            if (++this.depth > MAX_DEPTH) {
                this.depth--;
                this.errorAtTok('Expression is nested too deeply');
                const at = this.tok.start;
                return { kind: 'Missing', start: at, end: at };
            }
            const t = this.advance();
            const operand = this.parseUnary();
            this.depth--;
            return { kind: 'Unary', op: t.value, operand, start: t.start, end: operand.end };
        }
        return this.parsePower();
    }

    private parsePower(): A.Expr {
        let left = this.parsePostfix().expr;
        while (this.isPunct('^')) {
            this.advance();
            const right = this.isPunct('-') || this.isPunct('+') ? this.parseUnary() : this.parsePostfix().expr;
            left = { kind: 'Binary', op: '^', left, right, start: left.start, end: right.end };
        }
        return left;
    }

    /**
     * A primary with any `.name` and `(args)` after it. Also reports where the
     * last bracketed group began, which the call statement needs to re-read
     * `Foo (a) & b` as a call with one argument.
     */
    private parsePostfix(): { expr: A.Expr; lastGroup: { callee: A.Expr; tokenIndex: number } | null } {
        let expr: A.Expr = this.parsePrimary();
        let lastGroup: { callee: A.Expr; tokenIndex: number } | null = null;
        // `New C()` is an error in VBScript, so nothing binds to a New.
        if (expr.kind === 'Missing' || expr.kind === 'New') { return { expr, lastGroup }; }

        for (;;) {
            if (this.isPunct('.') && !this.tok.spaceBefore) {
                this.advance();
                const name = this.memberName();
                expr = { kind: 'Member', object: expr, name, start: expr.start, end: name.end };
                lastGroup = null;
                continue;
            }
            if (this.isPunct('(')) {
                const tokenIndex = this.pos;
                const callee: A.Expr = expr;
                const args = this.parseBracketedArgs();
                expr = { kind: 'Call', callee, args, start: callee.start, end: this.prevEnd };
                lastGroup = { callee, tokenIndex };
                continue;
            }
            return { expr, lastGroup };
        }
    }

    /** `(a, , c)`. An omitted argument is null; one after the last comma is an error. */
    private parseBracketedArgs(): (A.Expr | null)[] {
        this.advance(); // (
        const args: (A.Expr | null)[] = [];
        if (this.isPunct(')')) { this.advance(); return args; }
        for (;;) {
            if (this.isPunct(',')) { args.push(null); this.advance(); continue; }
            if (this.isPunct(')') && args.length > 0) {
                this.errorAtTok('Syntax error');
                break;
            }
            args.push(this.parseExpr());
            if (!this.isPunct(',')) { break; }
            this.advance();
        }
        this.expectPunct(')');
        return args;
    }

    private memberName(): A.Name {
        const t = this.tok;
        if (t.kind === TokenKind.Identifier) {
            this.advance();
            return this.nameFrom(t);
        }
        this.errorAtTok('Expected identifier');
        return this.missingName();
    }

    private parsePrimary(): A.Expr {
        const t = this.tok;
        switch (t.kind) {
            case TokenKind.Number:
            case TokenKind.String:
            case TokenKind.Date: {
                this.advance();
                if (t.error) { this.error(t.start, t.end, t.error); }
                const type = t.kind === TokenKind.Number ? 'number' : t.kind === TokenKind.String ? 'string' : 'date';
                return { kind: 'Literal', type, raw: t.value, start: t.start, end: t.end };
            }
            case TokenKind.Invalid:
                this.advance();
                this.error(t.start, t.end, t.error ?? 'Invalid character');
                return { kind: 'Missing', start: t.start, end: t.end };
            case TokenKind.Punct:
                if (t.value === '(') {
                    this.advance();
                    const inner = this.parseExpr();
                    this.expectPunct(')');
                    return { kind: 'Paren', expr: inner, start: t.start, end: this.prevEnd };
                }
                if (t.value === '.') {
                    // `.Name` inside a With block.
                    this.advance();
                    const name = this.memberName();
                    return { kind: 'Member', object: null, name, start: t.start, end: name.end };
                }
                break;
            case TokenKind.Identifier: {
                if (t.bracketed) {
                    this.advance();
                    return { kind: 'Ident', name: this.nameFrom(t), start: t.start, end: t.end };
                }
                const literal = LITERAL_WORDS[t.value];
                if (literal) {
                    this.advance();
                    return { kind: 'Literal', type: literal, raw: t.value, start: t.start, end: t.end };
                }
                if (t.value === 'me') {
                    this.advance();
                    return { kind: 'Me', start: t.start, end: t.end };
                }
                if (t.value === 'new') {
                    this.advance();
                    const className = this.parseName() ?? this.missingName();
                    return { kind: 'New', className, start: t.start, end: this.prevEnd };
                }
                if (!RESERVED.has(t.value)) {
                    this.advance();
                    return { kind: 'Ident', name: this.nameFrom(t), start: t.start, end: t.end };
                }
                break;
            }
        }
        this.errorAtTok(t.kind === TokenKind.EOF || t.kind === TokenKind.Newline ? 'Expected expression' : 'Syntax error');
        return { kind: 'Missing', start: t.start, end: t.start };
    }
}

const LITERAL_WORDS: Record<string, A.LiteralExpr['type']> = {
    true: 'boolean', false: 'boolean', empty: 'empty', null: 'null', nothing: 'nothing',
};

/** A whole number as written: `10`, `&H1F`. Not `-1`, `(2)` or `1.5`. */
function isIntegerLiteral(e: A.Expr): boolean {
    return e.kind === 'Literal' && e.type === 'number' && /^(?:\d+|&[hHoO][0-9a-fA-F]+&?)$/.test(e.raw);
}

/** What Const accepts: a literal, optionally signed or bracketed. `Const A = 1 + 2` is an error in VBScript. */
function isLiteralConstant(e: A.Expr): boolean {
    if (e.kind === 'Literal') { return true; }
    if (e.kind === 'Unary' && (e.op === '-' || e.op === '+')) { return isLiteralConstant(e.operand); }
    if (e.kind === 'Paren') { return isLiteralConstant(e.expr); }
    return false;
}

function capitalise(w: string): string {
    return w.charAt(0).toUpperCase() + w.slice(1);
}
