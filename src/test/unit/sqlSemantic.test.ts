import * as assert from 'assert';
import { isSql } from '../../providers/sqlSemanticProvider';

// SQL-in-string detection must not light up plain English that happens to
// contain SQL keywords, while still recognising real SQL (including UPDATE…SET
// and aliased column references).
describe('isSql — precision vs recall (Bug M)', () => {
    describe('plain English is NOT SQL', () => {
        for (const s of [
            'Select a report from the history page',
            'Please update the record and set the flag',
            'You can delete a file from the disk',
            'Insert a new line before the footer',
            'Update your profile and set a new password',
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
        ]) {
            it(`accepts: ${s}`, () => assert.strictEqual(isSql(s), true));
        }
    });
});
