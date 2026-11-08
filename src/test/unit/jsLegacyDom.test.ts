import * as assert from 'assert';
import * as ts from 'typescript';
import {
    disposeJsLanguageService,
    getJsLanguageService,
} from '../../js/jsUtils';
import { getJsBlockRanges } from '../../core/zoneUtils';
import { isShown } from '../../js/jsDiagnosticsProvider';

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

    const svc = getJsLanguageService();
    svc.loadPage(fullText);

    return [...svc.getSyntacticDiagnostics(), ...svc.getSemanticDiagnostics()]
        .filter(d => d.start !== undefined && d.length !== undefined)
        .filter(d => {
            return jsRanges.some(r => d.start! >= r.start && d.start! <= r.end);
        })
        .filter(d => isShown(d.code, fullText, d.start!, d.length!, ts.flattenDiagnosticMessageText(d.messageText, ' ')))
        .map(d => d.code);
}

const describeCodes = (body: string) => {
    const fullText = `<script>\n${body}\n</script>\n`;
    const svc = getJsLanguageService();
    svc.loadPage(fullText);
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

    // A control from a collection is typed Element, and an element looked up by
    // a variable id is the widened HTMLElement, where rows and value used to be
    // unions that no use got through.
    it('accepts reading form controls found through a collection or a variable id', () => {
        clean('var el = document.forms[0].elements[0]; if (el.type == "radio" || el.type == "checkbox") { }');
        clean('var id = "grid"; var tab = document.getElementById(id); if (tab.rows.length <= 1) { }');
        clean('var id = "q"; if (document.getElementById(id).value.length > 0) { }');
    });

    // What a page written for Internet Explorer reads off an event, a select, a
    // link, an element and a dialog window.
    it('accepts the IE event fields', () => {
        clean('function f(){ if (event.keyCode == 13) { event.returnValue = false; } }');
        clean('function f(){ var x = event.clientX + event.button + event.which; }');
        clean('function f(){ if (event.srcElement.type == "text") { } }');
    });

    it('accepts a select, a link and a textarea found by id', () => {
        clean('var s = document.getElementById("s"); s.options.length = 0; var n = s.length; s.add(new Option("a", "b"));');
        clean('var a = document.getElementById("a"); a.href = "x"; a.target = "_blank";');
        clean('var t = document.getElementById("t"); t.cols = 40;');
    });

    // A link found by a selector or a collection is a bare Element.
    it('accepts the href of a link found as a bare Element', () => {
        clean('var a = document.querySelector("a.menu"); var h = a.href;');
        clean('var el = document.forms[0].elements[0]; var h = el.href;');
    });

    it('accepts IE-only members, a dialog window and old Date methods', () => {
        clean('var e = document.getElementById("x"); e.currentStyle.display; e.fireEvent("onchange"); e.attachEvent("onclick", function(){});');
        clean('window.returnValue = 1; var a = window.dialogArguments; window.dialogWidth = "10px";');
        clean('var y = new Date().getYear(); var c = document.getElementById("c"); c.firstChild.data = "x";');
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
        flagged('var el = document.forms[0].elements[0]; if (el.tpye == "radio") { }');
        flagged('var a = document.getElementById("a"); a.hrf = "x";');
        flagged('var a = document.querySelector("a.menu"); var h = a.hrf;');
    });

    it('reports a misspelt event field', () => {
        flagged('function f(){ if (event.keyCod == 13) { } }');
        flagged('function f(){ var x = event.clientZ; }');
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
