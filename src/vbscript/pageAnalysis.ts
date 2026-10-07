/**
 * pageAnalysis.ts
 *
 * What the editor shows about a whole page, read from its syntax tree: the
 * blocks (for the structure warnings and the matching-keyword highlight), the
 * object of each With block, and every assignment that needs Set.
 *
 * Results are offsets into the page, not editor positions, and nothing here
 * imports vscode, so the VBScript worker thread (workers/vbscriptWorker.ts) can
 * run it as well as the extension host.
 */

import type * as A from './ast';
import { sourceOf, symbolsOfPage, walkStatements, type ParsedPage } from './symbols';
import { COM_METHOD_RETURN_TYPES } from '../constants/comObjects';
import type { FileSymbols } from './symbolParser';

/**
 * What completion, the outline, the matching-keyword highlight and the
 * structure warnings need after every edit, from one parse of the page.
 */
export interface PageAnalysis {
    /** The page's own symbols, without its includes'. */
    symbols: FileSymbols;
    blocks:  PageBlocks;
}

export function analysePage(page: ParsedPage, filePath: string): PageAnalysis {
    return { symbols: symbolsOfPage(page, filePath), blocks: pageBlocks(page) };
}

// ── Blocks ────────────────────────────────────────────────────────────────────

/** A block keyword as written, and the words the messages call it by. */
export interface Keyword { start: number; end: number; text: string; }

/** An opener and the closer the parser matched it with: `If` … `End If`. */
export interface BlockPairSpan { opener: Keyword; closer: Keyword; }

/** A block with no closer, or a closer with no block. */
export interface BlockWarning { start: number; end: number; message: string; }

/**
 * A With block: `object` as written, and the offsets a bare `.name` belongs
 * to it between, `from` included and `to` not.
 */
export interface WithBlock { object: string; from: number; to: number; }

/**
 * Where a block opens, starts another branch (ElseIf, Else, Case) or closes.
 * `block` names only the two whose branches are alternatives.
 */
export interface BlockEvent { at: number; type: 'open' | 'branch' | 'close'; block: 'if' | 'select' | 'other'; }

export interface PageBlocks {
    warnings:   BlockWarning[];
    pairs:      BlockPairSpan[];
    withBlocks: WithBlock[];
    /** In page order. A block with no closer has no close; a closer with no block is a close of its own. */
    events:     BlockEvent[];
}

type Block = A.IfStmt | A.SelectStmt | A.ForStmt | A.ForEachStmt | A.DoStmt | A.WhileStmt
    | A.WithStmt | A.ProcedureStmt | A.ClassStmt;

function isBlock(s: A.Stmt): s is Block {
    return 'opener' in s && !(s.kind === 'If' && s.singleLine);
}

/** The block's keywords as the messages spell them: `Do While` … `Loop`. */
function keywordsOf(b: Block): { opener: string; closer: string } {
    switch (b.kind) {
        case 'If':        return { opener: 'If', closer: 'End If' };
        case 'Select':    return { opener: 'Select Case', closer: 'End Select' };
        case 'For':       return { opener: 'For', closer: 'Next' };
        case 'ForEach':   return { opener: 'For Each', closer: 'Next' };
        case 'Do':        return { opener: b.pre ? (b.pre.until ? 'Do Until' : 'Do While') : 'Do', closer: 'Loop' };
        case 'While':     return { opener: 'While', closer: 'Wend' };
        case 'With':      return { opener: 'With', closer: 'End With' };
        case 'Class':     return { opener: 'Class', closer: 'End Class' };
        case 'Procedure': {
            const word = b.procKind.charAt(0).toUpperCase() + b.procKind.slice(1);
            return { opener: word, closer: `End ${word}` };
        }
    }
}

/** `end   if` → `End If`: a stray closer as the message spells it. */
function closerWords(source: string): string {
    return source.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/**
 * The page's blocks: each opener matched with its closer, a warning for each
 * one that is not, and the With blocks. Warnings and pairs are in page order;
 * With blocks in the order their statements start, so an inner one comes
 * after the one around it.
 */
export function pageBlocks(page: ParsedPage): PageBlocks {
    const text = page.text;
    const warnings: BlockWarning[] = [];
    const pairs: BlockPairSpan[] = [];
    const withBlocks: WithBlock[] = [];
    const events: BlockEvent[] = [];

    for (const program of page.programs) {
        walkStatements(program.body, stmt => {
            if (stmt.kind === 'With') {
                // A block still being typed, with no End With yet, runs to where the parser closed it.
                withBlocks.push({
                    object: sourceOf(text, stmt.object),
                    from:   stmt.object.end + 1,
                    to:     stmt.closer ? stmt.closer.start : stmt.end + 1,
                });
            }
            if (!isBlock(stmt)) { return; }
            const block = stmt.kind === 'If' ? 'if' : stmt.kind === 'Select' ? 'select' : 'other';
            events.push({ at: stmt.opener.start, type: 'open', block });
            if (stmt.kind === 'If') { for (const b of stmt.branches.slice(1)) { events.push({ at: b.start, type: 'branch', block }); } }
            if (stmt.kind === 'Select') { for (const c of stmt.cases) { events.push({ at: c.start, type: 'branch', block }); } }
            if (stmt.closer) { events.push({ at: stmt.closer.start, type: 'close', block }); }
            const words = keywordsOf(stmt);
            if (stmt.closer) {
                pairs.push({
                    opener: { start: stmt.opener.start, end: stmt.opener.end, text: words.opener },
                    closer: { start: stmt.closer.start, end: stmt.closer.end, text: words.closer },
                });
            } else {
                warnings.push({
                    start: stmt.opener.start, end: stmt.opener.end,
                    message: `Missing closing keyword — no '${words.closer}' found for this '${words.opener}'`,
                });
            }
        });

        for (const d of program.diagnostics) {
            if (d.code === 'stray-branch') { events.push({ at: d.start, type: 'branch', block: text.slice(d.start, d.end).toLowerCase() === 'case' ? 'select' : 'if' }); }
            if (d.code !== 'stray-closer') { continue; }
            const closer = text.slice(d.start, d.end).toLowerCase().replace(/\s+/g, ' ');
            events.push({ at: d.start, type: 'close', block: closer === 'end if' ? 'if' : closer === 'end select' ? 'select' : 'other' });
            warnings.push({
                start: d.start, end: d.end,
                message: `Unexpected closing keyword — no matching opener found for '${closerWords(text.slice(d.start, d.end))}'`,
            });
        }
    }

    warnings.sort((a, b) => a.start - b.start);
    pairs.sort((a, b) => a.closer.start - b.closer.start);
    events.sort((a, b) => a.at - b.at);
    return { warnings, pairs, withBlocks, events };
}

/** The object of the innermost With block `offset` sits in, as written, or undefined outside one. */
export function withObjectAt(withBlocks: WithBlock[], offset: number): string | undefined {
    let found: WithBlock | undefined;
    for (const block of withBlocks) {
        if (block.from <= offset && offset < block.to) { found = block; }
    }
    return found?.object;
}

// ── Missing Set ───────────────────────────────────────────────────────────────

/**
 * What a method returns, when that result has no value of its own to copy: a
 * Recordset's default is its Fields collection, which needs an index; a
 * TextStream or an XML node has no default at all. Assigning one without Set
 * fails when the page runs. A File or Folder is left out on purpose — its
 * default is its Path, so `p = fso.GetFolder(".")` is a working way to get one.
 */
const OBJECT_ONLY_RESULTS = new Set([
    'adodb.recordset', 'scripting.textstream', 'msxml2.ixmldomnode', 'msxml2.ixmldomnodelist',
]);

/** An assignment that needs Set: the offsets of the name it assigns to. */
export interface MissingSet {
    start:  number;
    end:    number;
    target: string;
}

/**
 * Every `x = …` whose right-hand side is certainly an object, which VBScript
 * only assigns with `Set x = …`: `CreateObject(…)`, `Server.CreateObject(…)`,
 * `GetObject(…)`, `New SomeClass`, and a method on a variable of known type
 * that returns one of OBJECT_ONLY_RESULTS — `rs = conn.Execute(sql)`.
 *
 * Read from the syntax tree, so the call has to be the whole right-hand side:
 * `n = conn.Execute(sql)(0)` reads a value out of the Recordset, and is right
 * as it is. `comTypes` maps a variable name, lower-cased, to the ProgID it
 * was created as.
 */
export function findMissingSet(page: ParsedPage, comTypes: Map<string, string>): MissingSet[] {
    const text = page.text;
    const found: MissingSet[] = [];
    for (const program of page.programs) {
        walkStatements(program.body, stmt => {
            if (stmt.kind !== 'Assign' || stmt.set || !isObjectValue(stmt.value, comTypes)) { return; }
            found.push({ start: stmt.target.start, end: stmt.target.end, target: text.slice(stmt.target.start, stmt.target.end) });
        });
    }
    return found.sort((a, b) => a.start - b.start);
}

function isObjectValue(value: A.Expr, comTypes: Map<string, string>): boolean {
    if (value.kind === 'New') { return true; }

    // A call, or a method with no parentheses: `rs.NextRecordset`.
    const callee = value.kind === 'Call' ? value.callee : value;
    if (callee.kind === 'Ident') {
        return value.kind === 'Call' && (callee.name.name === 'createobject' || callee.name.name === 'getobject');
    }
    if (callee.kind !== 'Member' || callee.object?.kind !== 'Ident') { return false; }

    const objectName = callee.object.name.name;
    const method = callee.name.name;
    if (objectName === 'server' && method === 'createobject') { return value.kind === 'Call'; }

    const progId = comTypes.get(objectName);
    const result = progId && COM_METHOD_RETURN_TYPES[`${progId}.${method}`];
    return !!result && OBJECT_ONLY_RESULTS.has(result);
}
