import * as assert from 'assert';
import { isBlockOpener, stripTrailingComment, tagToAutoClose } from '../../providers/aspIndentProvider';
import { Zone } from '../../utils/zoneUtils';

// The shared opener test used by both Enter and Tab. A single-line `If … Then <stmt>` opens nothing; Property and access-modified declarations DO open a block.
describe('isBlockOpener', () => {
    it('is false for a single-line If … Then <statement>', () => {
        assert.strictEqual(isBlockOpener('If x Then y = 1'), false);
    });

    it('is true for a multi-line If … Then (bare, or with only a comment)', () => {
        assert.strictEqual(isBlockOpener('If x Then'), true);
        assert.strictEqual(isBlockOpener("If x Then   ' note"), true);
    });

    it('is true for Property Get/Let/Set (with or without access modifier)', () => {
        assert.strictEqual(isBlockOpener('Property Get Balance'), true);
        assert.strictEqual(isBlockOpener('Public Property Get Balance'), true);
        assert.strictEqual(isBlockOpener('Public Default Property Get Item'), true);
    });

    it('is true for access-modified Sub / Function / Class', () => {
        assert.strictEqual(isBlockOpener('Public Sub Foo'), true);
        assert.strictEqual(isBlockOpener('Private Function Bar'), true);
        assert.strictEqual(isBlockOpener('Public Class Account'), true);
    });

    it('is false for plain statements and declarations', () => {
        assert.strictEqual(isBlockOpener('Dim x'), false);
        assert.strictEqual(isBlockOpener('x = 1'), false);
        assert.strictEqual(isBlockOpener('Public Balance'), false); // a field, not a block
    });
});

// A trailing ' comment must be stripped before opener matching, but
// an apostrophe inside a string is data, not a comment.
describe('stripTrailingComment', () => {
    it('removes a trailing comment so the opener can be matched', () => {
        assert.strictEqual(stripTrailingComment("If b Then   ' note").trim(), 'If b Then');
    });

    it('keeps an apostrophe that lives inside a string literal', () => {
        assert.strictEqual(stripTrailingComment('x = "a \' b"'), 'x = "a \' b"');
    });

    it('leaves a comment-free line unchanged', () => {
        assert.strictEqual(stripTrailingComment('For i = 1 To 10'), 'For i = 1 To 10');
    });
});

// Typing `>` auto-inserts a closing tag. The attribute-value guard only arms once
// a tag opener has been seen on the line, so inside a VBScript string there is
// none and `Response.Write "<div>"` — the ordinary way to emit HTML in Classic
// ASP — was getting `</div>` injected into the middle of the string.
describe('tagToAutoClose', () => {
    const inZone = (zone: Zone) => () => zone;

    it('closes an ordinary HTML tag', () => {
        assert.strictEqual(tagToAutoClose('<div class="x"', inZone('html')), 'div');
    });

    it('does not close inside a VBScript string', () => {
        assert.strictEqual(tagToAutoClose('  Response.Write "<div', inZone('asp')), null);
    });

    it('does not close inside a JavaScript string', () => {
        assert.strictEqual(tagToAutoClose('  document.write("<div', inZone('js')), null);
    });

    it('does not close after a string containing a comparison', () => {
        assert.strictEqual(
            tagToAutoClose('  sql = "SELECT a FROM t WHERE a<b" & "<b', inZone('asp')),
            null,
        );
    });

    it('does not close inside a quoted attribute value', () => {
        assert.strictEqual(tagToAutoClose('<a href="<', inZone('html')), null);
    });

    it('does not close a hand-written self-closing tag', () => {
        assert.strictEqual(tagToAutoClose('<div /', inZone('html')), null);
    });

    it('does not close a void element', () => {
        assert.strictEqual(tagToAutoClose('<br', inZone('html')), null);
    });

    it('does not close when no tag precedes the caret', () => {
        assert.strictEqual(tagToAutoClose('x = a ', inZone('html')), null);
    });

    it('does not consult the zone until the cheap checks pass', () => {
        let asked = 0;
        tagToAutoClose('x = a ', () => { asked++; return 'html'; });
        assert.strictEqual(asked, 0, 'the document scan must be skipped for ordinary keystrokes');
    });
});
