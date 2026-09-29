/**
 * ast.ts
 *
 * The VBScript syntax tree. Every node carries `start` and `end` offsets into
 * the page text (end exclusive), so a feature can go from a node to the exact
 * source it came from. A node the parser had to invent while recovering from
 * an error (a missing expression) has zero width.
 */

export interface Span {
    start: number;
    end: number;
}

/** An identifier as written. `name` is lowercase and has no brackets. */
export interface Name extends Span {
    name: string;
    text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expressions
// ─────────────────────────────────────────────────────────────────────────────

export type Expr =
    | LiteralExpr
    | IdentExpr
    | MemberExpr
    | CallExpr
    | UnaryExpr
    | BinaryExpr
    | ParenExpr
    | NewExpr
    | MeExpr
    | MissingExpr;

export interface LiteralExpr extends Span {
    kind: 'Literal';
    type: 'number' | 'string' | 'date' | 'boolean' | 'empty' | 'null' | 'nothing';
    raw: string;
}

export interface IdentExpr extends Span {
    kind: 'Ident';
    name: Name;
}

/** `object.name`, or `.name` inside a With block, where `object` is null. */
export interface MemberExpr extends Span {
    kind: 'Member';
    object: Expr | null;
    name: Name;
}

/** `callee(args)`: a call or an array index, which VBScript does not tell apart. An omitted argument is null. */
export interface CallExpr extends Span {
    kind: 'Call';
    callee: Expr;
    args: (Expr | null)[];
}

export interface UnaryExpr extends Span {
    kind: 'Unary';
    op: string;
    operand: Expr;
}

export interface BinaryExpr extends Span {
    kind: 'Binary';
    op: string;
    left: Expr;
    right: Expr;
}

export interface ParenExpr extends Span {
    kind: 'Paren';
    expr: Expr;
}

export interface NewExpr extends Span {
    kind: 'New';
    className: Name;
}

export interface MeExpr extends Span {
    kind: 'Me';
}

export interface MissingExpr extends Span {
    kind: 'Missing';
}

// ─────────────────────────────────────────────────────────────────────────────
// Statements
// ─────────────────────────────────────────────────────────────────────────────

export type Stmt =
    | OptionExplicitStmt
    | DimStmt
    | ConstStmt
    | AssignStmt
    | CallStmt
    | OutputStmt
    | HtmlStmt
    | IfStmt
    | SelectStmt
    | ForStmt
    | ForEachStmt
    | DoStmt
    | WhileStmt
    | WithStmt
    | ProcedureStmt
    | ClassStmt
    | OnErrorStmt
    | ExitStmt
    | EraseStmt
    | StopStmt
    | ErrorStmt;

export interface OptionExplicitStmt extends Span {
    kind: 'OptionExplicit';
}

export interface Declarator extends Span {
    name: Name;
    /** The `(…)` after the name: null when there is none, [] for `x()`. */
    bounds: Expr[] | null;
}

/** Dim, ReDim, and a Public or Private variable declaration. */
export interface DimStmt extends Span {
    kind: 'Dim';
    keyword: 'dim' | 'redim' | 'public' | 'private';
    preserve: boolean;
    declarators: Declarator[];
}

export interface ConstStmt extends Span {
    kind: 'Const';
    access: 'public' | 'private' | null;
    declarators: { name: Name; value: Expr; start: number; end: number }[];
}

/** `x = 1`, `Let x = 1`, or `Set x = y`. */
export interface AssignStmt extends Span {
    kind: 'Assign';
    set: boolean;
    target: Expr;
    value: Expr;
}

/** `Foo a, b`, `Call Foo(a, b)`, `obj.Method`. */
export interface CallStmt extends Span {
    kind: 'CallStmt';
    callee: Expr;
    args: (Expr | null)[];
    hasCallKeyword: boolean;
}

/** `<%= expr %>` */
export interface OutputStmt extends Span {
    kind: 'Output';
    value: Expr;
}

/** HTML between two blocks, which IIS turns into a Response.WriteBlock call. */
export interface HtmlStmt extends Span {
    kind: 'Html';
}

/**
 * Where a block's keywords are: `opener` covers `If`, `Select Case`, `For Each`,
 * `Do While`, the `Sub` of `Public Sub`; `closer` covers `End If`, `Next`,
 * `Loop`. The closer is null when the block is never closed, or is closed by
 * the wrong keyword (an `End Function` ending a Sub).
 */
export interface BlockKeywords {
    opener: Span;
    closer: Span | null;
}

export interface IfBranch extends Span {
    /** null for the Else branch. */
    condition: Expr | null;
    body: Stmt[];
}

export interface IfStmt extends Span, BlockKeywords {
    kind: 'If';
    singleLine: boolean;
    branches: IfBranch[];
}

export interface CaseClause extends Span {
    /** null for Case Else. */
    values: Expr[] | null;
    body: Stmt[];
}

export interface SelectStmt extends Span, BlockKeywords {
    kind: 'Select';
    subject: Expr;
    cases: CaseClause[];
}

export interface ForStmt extends Span, BlockKeywords {
    kind: 'For';
    counter: Name;
    from: Expr;
    to: Expr;
    step: Expr | null;
    body: Stmt[];
}

export interface ForEachStmt extends Span, BlockKeywords {
    kind: 'ForEach';
    variable: Name;
    collection: Expr;
    body: Stmt[];
}

export interface LoopCondition {
    until: boolean;
    expr: Expr;
}

export interface DoStmt extends Span, BlockKeywords {
    kind: 'Do';
    pre: LoopCondition | null;
    post: LoopCondition | null;
    body: Stmt[];
}

export interface WhileStmt extends Span, BlockKeywords {
    kind: 'While';
    condition: Expr;
    body: Stmt[];
}

export interface WithStmt extends Span, BlockKeywords {
    kind: 'With';
    object: Expr;
    body: Stmt[];
}

export interface Parameter extends Span {
    name: Name;
    passing: 'byval' | 'byref' | null;
    isArray: boolean;
}

export interface ProcedureStmt extends Span, BlockKeywords {
    kind: 'Procedure';
    procKind: 'sub' | 'function' | 'property';
    /** Get, Let or Set for a Property, else null. */
    accessor: 'get' | 'let' | 'set' | null;
    access: 'public' | 'private' | null;
    isDefault: boolean;
    name: Name;
    /** The text between the parentheses, or null when there are none. */
    paramList: Span | null;
    params: Parameter[];
    body: Stmt[];
    /** The `End …` statement that ended it, even the wrong one, or null when it is never closed. */
    endStatement: Span | null;
}

export interface ClassStmt extends Span, BlockKeywords {
    kind: 'Class';
    name: Name;
    members: Stmt[];
    endStatement: Span | null;
}

export interface OnErrorStmt extends Span {
    kind: 'OnError';
    resumeNext: boolean;
}

export interface ExitStmt extends Span {
    kind: 'Exit';
    target: string;
}

export interface EraseStmt extends Span {
    kind: 'Erase';
    targets: Expr[];
}

export interface StopStmt extends Span {
    kind: 'Stop';
}

/** Tokens the parser skipped after an error. */
export interface ErrorStmt extends Span {
    kind: 'Error';
    /**
     * An expression written where a statement should start, such as the rest
     * of a string whose `& _` was cut off by a blank line. Kept so the names
     * and strings in it still count.
     */
    expr?: Expr;
}

export interface Diagnostic extends Span {
    message: string;
    /** 'stray-closer': an `End If`, `Next`, `Loop` or `Wend` with no block for it to close. */
    code?: 'stray-closer';
}

export interface Program extends Span {
    body: Stmt[];
    diagnostics: Diagnostic[];
    comments: Span[];
    /**
     * The names in code skipped after an error, so a half-typed line still
     * counts as using them. `member` marks one written after a dot.
     */
    skippedNames: (Name & { member: boolean })[];
    /** False for a client-side `<script language="vbscript">`, which runs in the browser. */
    server: boolean;
}
