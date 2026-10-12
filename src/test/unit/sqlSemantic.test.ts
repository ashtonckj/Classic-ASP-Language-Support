import * as assert from 'assert';
import { emitSqlTokensForGroup, isSql } from '../../vbscript/sqlTokens';

// SQL-in-string detection must not light up plain English that happens to
// contain SQL keywords, while still recognising real SQL (including UPDATE…SET
// and aliased column references).
describe('isSql — precision vs recall', () => {
    describe('plain English is NOT SQL', () => {
        for (const s of [
            'Select a report from the history page',
            'Please update the record and set the flag',
            'You can delete a file from the disk',
            'Insert a new line before the footer',
            'Update your profile and set a new password',
            'Please select one from the list where possible',
            'Daily total hours exceeds limit. Delete from Orders where needed',
        ]) {
            it(`rejects: ${s}`, () => assert.strictEqual(isSql(s), false));
        }
    });

    describe('real SQL IS detected', () => {
        for (const s of [
            'SELECT name FROM users WHERE id = 1',
            'UPDATE users SET active = 1 WHERE id = 2',
            'DELETE FROM users WHERE id = 3',
            'INSERT INTO users (name) VALUES (?)',
            'SELECT a.name FROM users a',                     // aliased column (a.name)
            'SELECT TOP 10 * FROM orders ORDER BY total DESC',
            'EXEC sp_x 5',
            'EXECUTE dbo.[Refresh Totals] @id',
            'SELECT .5 * Price FROM t',
            '  (SELECT a FROM t) UNION (SELECT b FROM u)',
            'SELECT * FROM a INNER JOIN b ON a.id = b.id',
        ]) {
            it(`accepts: ${s}`, () => assert.strictEqual(isSql(s), true));
        }
    });
});

// Words in a 'literal' or after a -- comment are data: 'Tom and Jerry' has no
// AND in it, and a comment names no table.
describe('emitSqlTokensForGroup — literals and comments', () => {
    const coloured = (sql: string): string[] => {
        const tokens: string[] = [];
        const group = {
            stitched: sql,
            omLine: new Int32Array(sql.length),
            omCol:  Int32Array.from({ length: sql.length }, (_, i) => i),
        };
        emitSqlTokensForGroup({ push: (_line, col, length) => { tokens.push(sql.slice(col, col + length)); } }, group);
        return tokens;
    };

    it('colours nothing inside a quoted value', () => {
        const words = coloured("SELECT id FROM t WHERE name = 'Tom and Jerry select from' AND d = '2020-01-01'");
        assert.ok(words.includes('SELECT') && words.includes('AND'), JSON.stringify(words));
        for (const inside of ['Tom', 'and', 'select', 'from', '2020', '01']) {
            assert.ok(!words.includes(inside), `${inside} in ${JSON.stringify(words)}`);
        }
    });

    it('colours nothing after a -- comment', () => {
        const words = coloured('SELECT id FROM t -- where from comment');
        assert.ok(!words.includes('where') && !words.includes('comment'), JSON.stringify(words));
    });
});
