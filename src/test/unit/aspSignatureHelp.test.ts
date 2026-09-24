import * as assert from 'assert';
import { findActiveCall } from '../../providers/aspSignatureHelpProvider';
import { BUILTIN_FUNCTION_DOCS, VBSCRIPT_FUNCTIONS, builtinSignature } from '../../constants/aspKeywords';

// The active-parameter counter must skip string literals: a comma or paren inside
// a string argument is data, not call syntax.
describe('findActiveCall', () => {
    it('does not count a comma inside a string argument', () => {
        assert.deepStrictEqual(findActiveCall('Notify("a, b", '), { openParenCol: 6, activeParam: 1 });
    });

    it('ignores parens inside a string argument', () => {
        assert.strictEqual(findActiveCall('Func("(", ')?.activeParam, 1);
    });

    it('counts real argument separators', () => {
        assert.strictEqual(findActiveCall('Func(a, b, ')?.activeParam, 2);
    });

    it('resolves the innermost call when nested', () => {
        assert.strictEqual(findActiveCall('Func(Other(x, ')?.activeParam, 1);
    });

    it('returns null when the cursor is not inside a call', () => {
        assert.strictEqual(findActiveCall('x = 1 + 2'), null);
    });
});

// A `(` inside a VBScript comment is not call syntax, so commented-out code must
// not raise parameter hints. The scan starts at the line's VBScript so an
// apostrophe in HTML sharing the line is not mistaken for a comment marker.
describe('findActiveCall — comments', () => {
    it('returns null inside a commented-out call', () => {
        assert.strictEqual(findActiveCall("  ' old code: Notify(\"a\", "), null);
    });

    it('returns null when the comment starts mid-line', () => {
        assert.strictEqual(findActiveCall('x = 1 \' Notify(a, '), null);
    });

    it('still resolves a real call that contains an apostrophe in a string', () => {
        assert.strictEqual(findActiveCall('Notify("it\'s", ')?.activeParam, 1);
    });

    it('honours the start offset so HTML on the line is not scanned', () => {
        const line = '<td>it\'s</td><% Notify("a", ';
        assert.strictEqual(findActiveCall(line, line.indexOf('<%') + 2)?.activeParam, 1);
    });
});

// Parameter hints for a built-in come from its doc's heading, so the heading is
// the one place a signature is written down.
describe('builtinSignature', () => {
    it('reads the label and each parameter from the heading', () => {
        const mid = builtinSignature(BUILTIN_FUNCTION_DOCS['mid'])!;
        assert.strictEqual(mid.label, 'Mid(string, start[, length])');
        assert.deepStrictEqual(mid.parameters.map(p => mid.label.slice(...p.range)), ['string', 'start', 'length']);
    });

    it('finds an optional leading parameter', () => {
        const instr = builtinSignature(BUILTIN_FUNCTION_DOCS['instr'])!;
        assert.deepStrictEqual(instr.parameters.map(p => p.name), ['start', 'string1', 'string2', 'compare']);
        assert.deepStrictEqual(instr.parameters.map(p => instr.label.slice(...p.range)), ['start', 'string1', 'string2', 'compare']);
    });

    it('gives a function with no arguments no parameters', () => {
        assert.deepStrictEqual(builtinSignature(BUILTIN_FUNCTION_DOCS['date'])!.parameters, []);
    });

    it('does not repeat the heading in the documentation', () => {
        assert.ok(!builtinSignature(BUILTIN_FUNCTION_DOCS['len'])!.documentation.startsWith('**'));
    });

    it('returns undefined for a doc without a signature heading', () => {
        assert.strictEqual(builtinSignature('Just some prose.'), undefined);
    });
});

describe('built-in function docs', () => {
    it('document every function completion offers, with a signature', () => {
        const missing = VBSCRIPT_FUNCTIONS.filter(name => {
            const doc = BUILTIN_FUNCTION_DOCS[name.toLowerCase()];
            return !doc || !builtinSignature(doc);
        });
        assert.deepStrictEqual(missing, []);
    });

    it('name each function in its heading', () => {
        for (const [key, doc] of Object.entries(BUILTIN_FUNCTION_DOCS)) {
            const label = builtinSignature(doc)?.label ?? '';
            assert.strictEqual(label.slice(0, label.indexOf('(')).toLowerCase(), key, `heading of ${key}`);
        }
    });
});
