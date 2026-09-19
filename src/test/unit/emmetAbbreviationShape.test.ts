import * as assert from 'assert';
import { looksLikeAbbreviation } from '../../providers/aspIndentProvider';
import { ASP_OBJECTS } from '../../constants/aspKeywords';

// Tab expands an abbreviation without requiring emmet.triggerExpansionOnTab, so
// something has to decide which words are worth offering to Emmet.
//
// What keeps VBScript safe is the ZONE: Emmet is only consulted in an HTML or
// CSS zone, never inside <% %>. This is the second line of defence, for the one
// case the zone cannot cover — ASP ends a block at the first `%>`, even one
// inside a string, so on a page like
//
//     <%
//     s = "%>"
//     Response.CharSet = "utf-8"
//     %>
//
// the third line is an HTML zone by the engine's own rule, and the shape test
// alone would hand `Response.CharSet` to Emmet. Reported as it becoming
// <Response class="Charset"></Response>.

describe('looksLikeAbbreviation — intrinsic ASP objects are never abbreviations', () => {

    // Every object the runtime puts in scope, checked through its own first
    // member, so adding an object to ASP_OBJECTS extends this automatically.
    for (const object of ASP_OBJECTS) {
        const member = object.members[0].name;
        it(`leaves ${object.name}.${member} alone`, () => {
            assert.strictEqual(looksLikeAbbreviation(`${object.name}.${member}`), false);
        });
    }

    it('is case-insensitive, as VBScript is', () => {
        assert.strictEqual(looksLikeAbbreviation('response.charset'), false);
        assert.strictEqual(looksLikeAbbreviation('RESPONSE.WRITE'), false);
    });

    it('covers members this extension does not list, not just known ones', () => {
        // The rule keys on the object, so a member added to ASP in some future
        // build — or simply one not enumerated here — is still safe.
        assert.strictEqual(looksLikeAbbreviation('Response.SomethingNotListed'), false);
    });
});

describe('looksLikeAbbreviation — real abbreviations still expand', () => {
    const abbreviations = [
        'div.row',
        'span.badge',
        'ul.list#main',
        'p.lead',
        '.card',
        '#main',
        'table.striped',
        'my-component.active',
        'ul>li*3',
        'tr>td*2',
        'div+p',
    ];

    for (const token of abbreviations) {
        it(`expands ${token}`, () => {
            assert.strictEqual(looksLikeAbbreviation(token), true);
        });
    }
});

describe('looksLikeAbbreviation — prose is left alone', () => {
    for (const token of ['Total', 'Done.', '', 'x', '<div>']) {
        it(`leaves ${JSON.stringify(token)} alone`, () => {
            assert.strictEqual(looksLikeAbbreviation(token), false);
        });
    }

    // A caveat rather than a triumph, pinned so the limit is on record: a
    // variable of your own named like a tag is indistinguishable from an
    // abbreviation by shape alone. Inside <% %> the zone check covers it; the
    // exposure is only the mis-zoned case described at the top of this file.
    for (const token of ['p.Value', 'rs.Fields']) {
        it(`cannot tell ${token} from an abbreviation`, () => {
            assert.strictEqual(looksLikeAbbreviation(token), true);
        });
    }
});
