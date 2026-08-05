import * as assert from 'assert';
import { STRUCTURAL_TAGS } from '../../providers/htmlStructureDiagnosticsProvider';

// Elements with OPTIONAL end tags (table cells/rows/sections) must not
// be tracked as "must be closed", or valid tables get flooded with false
// "Missing closing tag" warnings (which also block Format Document).
describe('STRUCTURAL_TAGS — optional-end-tag elements are excluded', () => {
    for (const tag of ['tr', 'td', 'th', 'thead', 'tbody', 'tfoot']) {
        it(`does not require a closing tag for <${tag}>`, () => {
            assert.ok(!STRUCTURAL_TAGS.has(tag), `<${tag}> has an optional end tag and must not be tracked`);
        });
    }

    it('still tracks elements that DO require a closing tag', () => {
        for (const tag of ['div', 'table', 'form', 'ul', 'select']) {
            assert.ok(STRUCTURAL_TAGS.has(tag), `<${tag}> requires a closing tag and must stay tracked`);
        }
    });
});
