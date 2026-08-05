import * as assert from 'assert';
import { classifyLine, extractAspStatementCode } from '../../providers/aspStructureDiagnosticsProvider';

function kinds(actions: Array<{ type: string; kind: string }>): string[] {
    return actions.map(a => `${a.type}:${a.kind}`);
}

// Only the code INSIDE <% %> is VBScript; the HTML around an inline
// <%= %> must never reach the block classifier (else prose words like "with",
// "do", "class" fake a block opener and raise a false "Missing End …").
describe('extractAspStatementCode — HTML prose is not classified as VBScript', () => {
    it('ignores HTML text around an inline <%= %> output expression', () => {
        const code = extractAspStatementCode('<td>Total <%= x %> items with tax</td>');
        assert.strictEqual(code.trim(), '');
        assert.deepStrictEqual(classifyLine(code), []); // no phantom With
    });

    it('does not fake a Do / Class opener from prose next to <%= %>', () => {
        assert.deepStrictEqual(classifyLine(extractAspStatementCode('What to do <%= a %> now')), []);
        assert.deepStrictEqual(classifyLine(extractAspStatementCode('see class notes <%= b %>')), []);
    });

    it('still extracts a real inline <% %> statement block', () => {
        assert.strictEqual(extractAspStatementCode('<% With obj %>').trim(), 'With obj');
        assert.deepStrictEqual(kinds(classifyLine(extractAspStatementCode('<% With obj %>'))), ['open:with']);
    });

    it('classifies two <% %> blocks on one line (join with colon)', () => {
        const code = extractAspStatementCode('<% If a Then %>x<% End If %>');
        assert.deepStrictEqual(kinds(classifyLine(code)), ['open:if', 'close:if']);
    });

    it('treats a line with no <% as pure code (multi-line block body)', () => {
        assert.strictEqual(extractAspStatementCode('With obj'), 'With obj');
        assert.deepStrictEqual(kinds(classifyLine(extractAspStatementCode('With obj'))), ['open:with']);
    });
});

// A REM comment (like a ' comment) must never be classified, or a
// commented-out opener such as `REM If x Then` fakes a "Missing End If".
describe('classifyLine — REM comments are not classified', () => {
    it('does not open an If for a REM-commented If', () => {
        assert.deepStrictEqual(classifyLine('REM If x Then'), []);
    });

    it('handles the inline <% REM If x Then %> form', () => {
        assert.deepStrictEqual(classifyLine(extractAspStatementCode('<% REM If x Then %>').trim()), []);
    });

    it('ignores a REM after a colon separator', () => {
        assert.deepStrictEqual(classifyLine('x = 1 : REM For each row'), []);
    });

    it('still classifies a real If (guards against over-stripping)', () => {
        assert.deepStrictEqual(kinds(classifyLine('If x Then')), ['open:if']);
    });

    it('does not treat a "rem"-prefixed identifier as a comment', () => {
        assert.deepStrictEqual(classifyLine('remainder = 5'), []);
    });
});

// D1 — a `:`-joined one-liner must be seen as BOTH an opener and a closer, so it
// balances and no false "Missing …" diagnostic is raised.
describe('classifyLine — colon-joined statements', () => {
    it('sees opener AND closer in `For i = 1 To 10 : Next`', () => {
        assert.deepStrictEqual(kinds(classifyLine('For i = 1 To 10 : Next')), ['open:for', 'close:for']);
    });

    it('balances `Do : Loop` on one line', () => {
        assert.deepStrictEqual(kinds(classifyLine('Do : Loop')), ['open:do', 'close:do']);
    });
});

// D2 — member access (obj.Do, rs.With) must not be read as a block keyword.
describe('classifyLine — member access is not a block keyword', () => {
    it('does not open a Do block for obj.Do', () => {
        assert.deepStrictEqual(classifyLine('obj.Do'), []);
    });

    it('does not open a With block for rs.With', () => {
        assert.deepStrictEqual(classifyLine('x = rs.With'), []);
    });

    it('does not treat Set x = obj.Do() as a block', () => {
        assert.deepStrictEqual(classifyLine('Set x = obj.Do()'), []);
    });
});

// Real keywords must still be classified (guard against over-correction).
describe('classifyLine — real keywords still classified', () => {
    it('opens Do While', () => {
        assert.deepStrictEqual(kinds(classifyLine('Do While x > 0')), ['open:do']);
    });

    it('opens a block If ... Then', () => {
        assert.deepStrictEqual(kinds(classifyLine('If x Then')), ['open:if']);
    });

    it('treats single-line If ... Then <stmt> as opening nothing', () => {
        assert.deepStrictEqual(classifyLine('If x Then y = 1'), []);
    });

    it('closes End If and Next', () => {
        assert.deepStrictEqual(kinds(classifyLine('End If')), ['close:if']);
        assert.deepStrictEqual(kinds(classifyLine('Next')), ['close:for']);
    });

    it('opens With / closes End With', () => {
        assert.deepStrictEqual(kinds(classifyLine('With obj')), ['open:with']);
        assert.deepStrictEqual(kinds(classifyLine('End With')), ['close:with']);
    });

    it('does not treat On Error Resume Next as a For closer', () => {
        assert.deepStrictEqual(classifyLine('On Error Resume Next'), []);
    });
});
