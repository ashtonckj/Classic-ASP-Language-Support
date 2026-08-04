import * as assert from 'assert';
import { computeLocalRenameScope } from '../../providers/aspRenameProvider';
import { FileSymbols } from '../../providers/includeProvider';

// F2 on a local variable/parameter must be limited to its own function
// body, not rewritten across every function and every file. computeLocalRenameScope
// returns that body's range for a local, or null for a global.
function fn(name: string, line: number, endLine: number, paramNames: string[] = []): FileSymbols['functions'][number] {
    return { name, kind: 'Sub', params: paramNames.join(', '), paramNames, line, endLine, filePath: 'x.asp' };
}

// Two subs, each with its own local `i`; one module-level `total`.
//  line 2  Sub First()
//  line 3    Dim i
//  line 4    For i = 1 To 3 : Next
//  line 5  End Sub
//  line 7  Sub Second()
//  line 8    Dim i
//  line 9    i = 99
//  line 10 End Sub
//  line 12 Dim total   (module level)
const SYM: FileSymbols = {
    variables: [
        { name: 'i',     line: 3,  filePath: 'x.asp' },
        { name: 'i',     line: 8,  filePath: 'x.asp' },
        { name: 'total', line: 12, filePath: 'x.asp' },
    ],
    constants: [],
    functions: [fn('First', 2, 5), fn('Second', 7, 10)],
    comVariables: [],
    classes: [],
};

describe('computeLocalRenameScope', () => {
    it('restricts a local Dim to its own function body', () => {
        assert.deepStrictEqual(computeLocalRenameScope(SYM, 3, 'i'), { line: 2, endLine: 5 });
    });

    it('gives a different (correct) body for the other function\'s local', () => {
        assert.deepStrictEqual(computeLocalRenameScope(SYM, 8, 'i'), { line: 7, endLine: 10 });
    });

    it('returns null for a module-level variable (rename stays global)', () => {
        assert.strictEqual(computeLocalRenameScope(SYM, 12, 'total'), null);
    });

    it('returns null for a function name used inside a body (functions are global)', () => {
        // caret inside First (line 4) on a call to Second → Second is global.
        assert.strictEqual(computeLocalRenameScope(SYM, 4, 'second'), null);
    });

    it('treats a parameter as local to its function', () => {
        const sym: FileSymbols = { ...SYM, functions: [fn('Greet', 2, 4, ['who'])] };
        assert.deepStrictEqual(computeLocalRenameScope(sym, 3, 'who'), { line: 2, endLine: 4 });
    });

    it('returns null when the caret is not inside any function body', () => {
        assert.strictEqual(computeLocalRenameScope(SYM, 0, 'i'), null);
    });
});
