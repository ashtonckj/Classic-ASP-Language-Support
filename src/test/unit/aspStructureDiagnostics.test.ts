import * as assert from 'assert';
import { classifyLine } from '../../providers/aspStructureDiagnosticsProvider';

function kinds(actions: Array<{ type: string; kind: string }>): string[] {
    return actions.map(a => `${a.type}:${a.kind}`);
}

// D1 — a `:`-joined one-liner must be seen as BOTH an opener and a closer, so it
// balances and no false "Missing …" diagnostic is raised.
describe('classifyLine — colon-joined statements (D1)', () => {
    it('sees opener AND closer in `For i = 1 To 10 : Next`', () => {
        assert.deepStrictEqual(kinds(classifyLine('For i = 1 To 10 : Next')), ['open:for', 'close:for']);
    });

    it('balances `Do : Loop` on one line', () => {
        assert.deepStrictEqual(kinds(classifyLine('Do : Loop')), ['open:do', 'close:do']);
    });
});

// D2 — member access (obj.Do, rs.With) must not be read as a block keyword.
describe('classifyLine — member access is not a block keyword (D2)', () => {
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
