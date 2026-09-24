import * as assert from 'assert';
import * as ts from 'typescript';
import {
    buildVirtualJsContent,
    disposeJsLanguageService,
    getJsLanguageService,
} from '../../utils/jsUtils';
import { getJsBlockRanges } from '../../utils/zoneUtils';
import { SUPPRESSED_CODES } from '../../providers/jsDiagnosticsProvider';

// Classic ASP pages were written for Internet Explorer, but TypeScript's DOM
// library only describes modern standards-compliant browsers — so every IE-era
// API, every cross-frame call and every named collection lookup was reported as
// "property does not exist".
//
// The two corpora below are the whole point: the ambient declarations must make
// the legacy patterns clean WITHOUT making ordinary typos stop being reported.
// Widening a base interface is easy; doing it without losing real errors is the
// part worth pinning down.

/** The error codes the extension would actually show for one <script> body. */
function shownCodes(scriptBody: string): number[] {
    const fullText = `<script>\n${scriptBody}\n</script>\n`;
    const jsRanges = getJsBlockRanges(fullText);
    if (jsRanges.length === 0) { return []; }

    const { virtualContent, preambleLength } = buildVirtualJsContent(fullText, 0);
    const svc = getJsLanguageService();
    svc.updateContent(virtualContent);

    return [...svc.getSyntacticDiagnostics(), ...svc.getSemanticDiagnostics()]
        .filter(d => d.start !== undefined && d.length !== undefined)
        .filter(d => {
            const offset = d.start! - preambleLength;
            return jsRanges.some(r => offset >= r.start && offset <= r.end);
        })
        .filter(d => !SUPPRESSED_CODES.has(d.code))
        .map(d => d.code);
}

const describeCodes = (body: string) => {
    const fullText = `<script>\n${body}\n</script>\n`;
    const { virtualContent } = buildVirtualJsContent(fullText, 0);
    const svc = getJsLanguageService();
    svc.updateContent(virtualContent);
    return [...svc.getSemanticDiagnostics()]
        .map(d => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
        .join(' | ') || '(clean)';
};

// The service is a process-wide singleton; drop it so each run starts fresh.
after(() => { disposeJsLanguageService(); });

describe('legacy browser APIs are recognised', () => {
    const clean = (body: string) =>
        assert.deepStrictEqual(shownCodes(body), [], `expected no errors for ${JSON.stringify(body)}; got ${describeCodes(body)}`);

    it('accepts the IE event-attach methods', () => {
        clean('window.attachEvent("onload", function(){});');
        clean('window.detachEvent("onload", function(){});');
    });

    it('accepts window.execScript and the dialog helpers', () => {
        clean('window.execScript("x");');
        clean('window.showModalDialog("a.asp");');
    });

    it('accepts document.selection and createStyleSheet', () => {
        clean('document.selection.createRange();');
        clean('document.createStyleSheet("a.css");');
    });

    // The named property getter is real DOM behaviour that the typings omit.
    it('accepts looking a form or element up by name', () => {
        clean('document.forms.myForm.myField.value = "1";');
        clean('document.all.myBtn.style.display = "";');
        clean('document.forms[0].elements.myField.value = "1";');
    });

    // event.srcElement is typed EventTarget, which has almost no members.
    it('accepts the IE event model reading its target', () => {
        clean('if (event.srcElement.tagName == "TD") { }');
        clean('event.srcElement.parentElement.style.color = "Black";');
        clean('event.srcElement.parentElement.style.backgroundColor = "#f9fbb7";');
        clean('var v = event.srcElement.value;');
        clean('event.srcElement.setAttribute("data-x", "1");');
    });

    it('accepts jQuery, including through a parent frame', () => {
        clean('$("#x").hide();');
        clean('parent.$("#myModalWindow").dialog("close");');
    });

    // The projection replaces <%= expr %> with a generated _asp_<name> stand-in;
    // used as `top.<%= callback %>(…)` it is read as a window property.
    it('accepts a generated ASP stand-in read as a window property', () => {
        clean('if (typeof(top._asp_callback) == "function") { top._asp_callback("x"); }');
        clean('parent._asp_someName(1);');
    });
});

// Everything above widens a type. This is the half that proves the widening did
// not go too far: a misspelt member must still be reported.
describe('ordinary mistakes are still reported', () => {
    const flagged = (body: string) =>
        assert.ok(shownCodes(body).length > 0, `expected an error for ${JSON.stringify(body)}, got none`);

    it('reports a misspelt document method', () => {
        flagged('document.getElementByIdd("x");');
        flagged('document.querySelectorAll(".a").forEeach(function(){});');
    });

    it('reports a misspelt member on an element', () => {
        flagged('document.body.innerHTMLL = "x";');
        flagged('document.getElementById("x").innerHTMLL = "y";');
    });

    // Guards the pattern index signature: only the _asp_ prefix is accepted, so
    // an ordinary misspelt window property is still an error.
    it('reports a misspelt window property', () => {
        flagged('window.docuemnt.getElementById("x");');
        flagged('window.myTypoHere();');
    });

    // Guards the EventTarget members: naming them individually, rather than
    // allowing any property, is what keeps this an error.
    it('reports a misspelt style property', () => {
        flagged('document.body.styl.color = "red";');
    });

    it('reports misspelt methods on built-in types', () => {
        flagged('var s = "abc"; s.toUpperCasee();');
        flagged('var n = 5; n.toFixed(2).charAtt(0);');
        flagged('JSON.parseX("{}");');
        flagged('var d = new Date(); d.getFullYearr();');
        flagged('Math.floorr(1.5);');
        flagged('var a = [1,2]; a.pushh(3);');
        flagged('console.logg("hi");');
        flagged('document.title.trimm();');
    });

    it('still reports a syntax error', () => {
        assert.ok(shownCodes('function f( {').length > 0);
    });
});
