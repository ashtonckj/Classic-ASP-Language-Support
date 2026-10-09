import * as assert from 'assert';
import { mergeSemanticTokens } from '../../semanticTokens';

type Token = [line: number, char: number, length: number, type: number, modifiers: number];

/** Tokens at absolute positions, in order, as VS Code's delta encoding. */
function encode(tokens: Token[]): Uint32Array {
    const data: number[] = [];
    let line = 0, char = 0;
    for (const [l, c, length, type, modifiers] of tokens) {
        data.push(l - line, l === line ? c - char : c, length, type, modifiers);
        line = l;
        char = c;
    }
    return Uint32Array.from(data);
}

/** A seeded random number in [0, 1), so a failure can be run again. */
function random(seed: number): () => number {
    return () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
}

describe('mergeSemanticTokens — the VBScript and JavaScript colouring as one stream', () => {

    it('interleaves two streams by position', () => {
        const asp: Token[] = [[0, 2, 3, 1, 0], [0, 10, 2, 2, 1], [4, 0, 5, 3, 0]];
        const js:  Token[] = [[0, 6, 1, 7, 0], [2, 4, 6, 8, 2], [4, 8, 3, 9, 0]];
        const all = [...asp, ...js].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        assert.deepStrictEqual([...mergeSemanticTokens(encode(asp), encode(js))], [...encode(all)]);
    });

    it('returns either stream unchanged when the other is empty', () => {
        const asp = encode([[1, 4, 2, 0, 0], [3, 0, 1, 1, 0]]);
        assert.deepStrictEqual([...mergeSemanticTokens(asp, new Uint32Array())], [...asp]);
        assert.deepStrictEqual([...mergeSemanticTokens(new Uint32Array(), asp)], [...asp]);
    });

    it('gives what sorting both streams gives, for many random pages', () => {
        for (let seed = 1; seed <= 200; seed++) {
            const next = random(seed);
            const asp: Token[] = [];
            const js: Token[] = [];
            // Positions are spread over both streams, one token per place.
            for (let line = 0; line < 40; line++) {
                for (let char = 0; char < 60; char += 3) {
                    const pick = next();
                    if (pick < 0.2) { asp.push([line, char, 2, Math.floor(next() * 9), 0]); }
                    else if (pick < 0.4) { js.push([line, char, 2, Math.floor(next() * 9), 1]); }
                }
            }
            const all = [...asp, ...js].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
            assert.deepStrictEqual([...mergeSemanticTokens(encode(asp), encode(js))], [...encode(all)], `seed ${seed}`);
        }
    });

    it('merges 200,000 tokens in well under the time a sort took', () => {
        const asp: Token[] = [];
        const js: Token[] = [];
        for (let line = 0; line < 20_000; line++) {
            for (let char = 0; char < 10; char++) { (char % 2 ? js : asp).push([line, char * 4, 3, 1, 0]); }
        }
        const [a, b] = [encode(asp), encode(js)];
        const started = performance.now();
        mergeSemanticTokens(a, b);
        assert.ok(performance.now() - started < 100, 'a linear merge of 200k tokens takes a few ms');
    });
});
