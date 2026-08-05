import * as assert from 'assert';
import { isBlockOpener, stripTrailingComment } from '../../providers/aspIndentProvider';

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
