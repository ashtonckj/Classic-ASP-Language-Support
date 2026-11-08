/**
 * asp-dom.d.ts
 *
 * Ambient browser declarations for the JavaScript inside <script> blocks.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The <script> error squiggles come from the TypeScript language service, which
 * checks code against lib.dom.d.ts — a description of MODERN, standards-compliant
 * browsers. Classic ASP pages were written for Internet Explorer, so a great deal
 * of what they legitimately use is simply absent from that description and gets
 * reported as "Property 'x' does not exist on type 'y'". A real page can collect a
 * dozen squiggles without containing a single actual mistake.
 *
 * Everything here therefore ADDS names the checker was missing. Nothing that
 * already type-checks changes, and no diagnostic codes are suppressed.
 *
 * HOW IT REACHES THE LANGUAGE SERVICE
 * -----------------------------------
 * The service needs these declarations as a STRING (it serves them as a virtual
 * file), so `npm run compile` runs scripts/generate-dom-types.js to bake this file
 * into src/js/aspDomTypes.generated.ts. Edit THIS file, never that one.
 *
 * Keeping the declarations in a real .d.ts rather than a string literal means
 * scripts/generate-dom-types.js can type-check them on every compile: a clash
 * with lib.dom.d.ts fails the build with a line number, instead of silently
 * doing nothing at runtime. (tsc itself skips .d.ts files: skipLibCheck.)
 *
 * TWO RULES WORTH KNOWING BEFORE EDITING
 * --------------------------------------
 * 1. You can only ADD members. Redeclaring one that lib.dom.d.ts already has
 *    fails with TS2687 / TS2717 ("must have identical modifiers" / "must be of
 *    type X"). `Window.external` is one that bites.
 * 2. Prefer naming specific members over `[name: string]: any`. An index
 *    signature is inherited by every interface that extends the one carrying it,
 *    so putting one on EventTarget switches off property checking for the whole
 *    DOM — measured, it drops typo detection from 19/19 to 11/19.
 *
 * src/test/unit/jsLegacyDom.test.ts holds both halves of that bargain: legacy
 * patterns must be clean, and ordinary typos must still be reported. Run
 * `npm run test:unit` after any change here.
 */

// Augment the standard HTMLElement interface directly so that Classic ASP
// inline scripts can call element-specific members (.submit(), .value,
// .selectedIndex, etc.) without type errors — exactly like plain .html files,
// where the HTML language service never enforces specific element subtypes.
// All members are optional so existing HTMLElement usage is unaffected.
// The Document interface is intentionally left untouched; getElementById /
// querySelector already return HTMLElement | null in lib.dom.d.ts.
interface HTMLElement {

    // ── HTMLFormElement ───────────────────────────────────────────────────
    submit?():          void;
    reset?():           void;
    checkValidity?():   boolean;
    reportValidity?():  boolean;
    elements?:          HTMLFormControlsCollection;
    action?:            string;
    method?:            string;
    enctype?:           string;
    encoding?:          string;
    noValidate?:        boolean;

    // ── HTMLInputElement / HTMLTextAreaElement ────────────────────────────
    // A member that is a different type on different elements is `any`: a union
    // (string | number) let no use through, so `.value.length` was an error on
    // an element looked up by a variable id. `any` is what an .html file's
    // untyped DOM gives, and it still fits every element's own declaration.
    value?:             any;
    defaultValue?:      string;
    checked?:           boolean;
    defaultChecked?:    boolean;
    indeterminate?:     boolean;
    placeholder?:       string;
    readOnly?:          boolean;
    required?:          boolean;
    maxLength?:         number;
    minLength?:         number;
    // max / min: string on input[type=date/number], number on HTMLMeterElement.
    max?:               any;
    min?:               any;
    step?:              string;
    pattern?:           string;
    multiple?:          boolean;
    accept?:            string;
    files?:             FileList | null;
    selectionStart?:    number | null;
    selectionEnd?:      number | null;
    // readonly: HTMLTextAreaElement and others declare both readonly.
    readonly validity?:          ValidityState;
    readonly validationMessage?: string;
    select?():            void;
    setSelectionRange?(start: number | null, end: number | null, direction?: string): void;
    setCustomValidity?(error: string): void;

    // ── HTMLSelectElement ─────────────────────────────────────────────────
    selectedIndex?:   number;
    // Legacy code writes `sel.options.length = 0`, which a read-only
    // HTMLCollectionOf refuses and the real HTMLOptionsCollection allows. The
    // intersection makes `length` writable and keeps every other member checked.
    readonly options?: HTMLCollectionOf<HTMLOptionElement> & { length: number };
    selectedOptions?: HTMLCollectionOf<HTMLOptionElement>;
    // A select's `length` and `add`, reached through getElementById.
    length?:          any;
    add?(...args: any[]): any;
    // size: number on HTMLSelectElement, string on HTMLFontElement/HTMLHRElement.
    size?:            any;

    // ── HTMLOptionElement ─────────────────────────────────────────────────
    selected?:  boolean;
    label?:     string;
    text?:      string;
    index?:     number;

    // ── HTMLImageElement ──────────────────────────────────────────────────
    naturalWidth?:  number;
    naturalHeight?: number;
    complete?:      boolean;
    currentSrc?:    string;

    // ── HTMLTableElement ──────────────────────────────────────────────────
    insertRow?(index?: number):  HTMLTableRowElement;
    deleteRow?(index: number):   void;
    createTHead?():              HTMLTableSectionElement;
    createTFoot?():              HTMLTableSectionElement;
    createTBody?():              HTMLTableSectionElement;
    deleteTHead?():              void;
    deleteTFoot?():              void;
    // HTMLFrameSetElement → string, HTMLTextAreaElement → number, HTMLTableElement → HTMLCollectionOf
    rows?:                       any;
    tHead?:                      HTMLTableSectionElement | null;
    tFoot?:                      HTMLTableSectionElement | null;
    tBodies?:                    HTMLCollectionOf<HTMLTableSectionElement>;
    caption?:                    HTMLTableCaptionElement | null;

    // ── HTMLTableRowElement ───────────────────────────────────────────────
    insertCell?(index?: number): HTMLTableCellElement;
    deleteCell?(index: number):  void;
    cells?:                      HTMLCollectionOf<HTMLTableCellElement>;
    rowIndex?:                   number;
    sectionRowIndex?:            number;

    // ── HTMLTableCellElement ──────────────────────────────────────────────
    colSpan?:   number;
    rowSpan?:   number;
    cellIndex?: number;
    abbr?:      string;
    scope?:     string;

    // ── HTMLMediaElement (video / audio) ──────────────────────────────────
    play?():    Promise<void>;
    pause?():   void;
    canPlayType?(type: string): CanPlayTypeResult;
    paused?:    boolean;
    ended?:     boolean;
    volume?:    number;
    currentTime?: number;
    duration?:  number;

    // ── HTMLCanvasElement ─────────────────────────────────────────────────
    toDataURL?(type?: string, quality?: any): string;
    toBlob?(callback: BlobCallback, type?: string, quality?: any): void;

    // ── HTMLIFrameElement ─────────────────────────────────────────────────
    contentDocument?: Document | null;
    contentWindow?:   WindowProxy | null;

    // ── HTMLButtonElement ─────────────────────────────────────────────────
    formAction?:     string;
    formMethod?:     string;
    formTarget?:     string;
    formNoValidate?: boolean;

    // ── HTMLAnchorElement / HTMLTextAreaElement ───────────────────────────
    // `href` is required and `string` because HTMLAnchorElement and
    // HTMLAreaElement inherit it from HTMLHyperlinkElementUtils as well, and
    // TypeScript allows that only when both declarations are identical. It is
    // on HTMLElement and not Element: SVGAElement's href is an
    // SVGAnimatedString, so no declaration on Element can fit both.
    href:            string;
    target?:         any;
    cols?:           any;
}

// ── Internet Explorer era APIs ────────────────────────────────────────────
// Classic ASP pages were written for IE, but TypeScript's DOM library only
// describes modern standards-compliant browsers. Anything IE-only is simply
// absent from it, so every use is reported as "property does not exist".
// These are all NEW members, so nothing that already type-checks changes;
// they only add names the checker was missing.

interface Window {
    attachEvent(type: string, handler: (e?: Event) => void): boolean;
    detachEvent(type: string, handler: (e?: Event) => void): void;
    execScript?(code: string, language?: string): void;
    showModalDialog?(url?: string, arg?: any, features?: string): any;
    showModelessDialog?(url?: string, arg?: any, features?: string): any;
    createPopup?(): any;
    clipboardData?: any;

    // jQuery is loaded by a <script src> tag on the page (and very often on
    // the PARENT page, reached as parent.$ from inside a modal), so the
    // checker never sees its declaration.
    $?: any;
    jQuery?: any;

    // The projection replaces every <%= expr %> with a generated _asp_<name>
    // stand-in. When the ASP expression is a FUNCTION NAME — the common
    // top.<%= callback %>(…) pattern — the stand-in is read as a property of
    // the window, so it has to exist here too.
    //
    // A PATTERN index signature is used rather than [name: string]: any so
    // that only the generated prefix is accepted: window.somethingMisspelt
    // is still reported.
    [aspGenerated: `_asp_${string}`]: any;
}

// The dialog window opened by showModalDialog, which reads its arguments and
// hands a result back through these.
interface Window {
    returnValue?: any;
    dialogArguments?: any;
    dialogWidth?: string;
    dialogHeight?: string;
    dialogLeft?: string;
    dialogTop?: string;
}

// IE-only members of an element. All optional and new, as above.
interface HTMLElement {
    currentStyle?: any;
    runtimeStyle?: any;
    filters?: any;
    fireEvent?(type: string, event?: any): boolean;
    createTextRange?(): any;
    attachEvent?(type: string, handler: (e?: Event) => void): boolean;
    detachEvent?(type: string, handler: (e?: Event) => void): void;
}

// Date methods browsers kept after the standard dropped them.
interface Date {
    getYear?(): number;
    setYear?(year: number): number;
    toGMTString?(): string;
}

// A text node's `data`, read off `firstChild` or `childNodes[i]`, which are
// typed with the base Node.
interface Node {
    data?: any;
}

interface Document {
    selection?: any;
    expando?: boolean;
    fileSize?: string;
    parentWindow?: Window;
    createStyleSheet?(url?: string, index?: number): any;
    recalc?(force?: boolean): void;
}

// ── Named access on collections ───────────────────────────────────────────
// document.forms.myForm and document.all.myButton are real DOM behaviour —
// the "named property getter" every browser implements. TypeScript's typings
// just don't express it, so this is a correction rather than a loosening.
interface HTMLCollectionBase { [name: string]: any; }
interface HTMLAllCollection  { [name: string]: any; }

// ── The IE event model ────────────────────────────────────────────────────
// Legacy handlers read their target from event.srcElement, which is typed
// EventTarget — an interface with almost nothing on it, so srcElement.tagName
// and friends all fail.
//
// Every interface in the DOM extends EventTarget, which makes this the most
// dangerous interface in the file to touch, in two different ways:
//
//   1. An index signature here would be inherited by Document, Element and
//      HTMLElement, switching off property checking for the whole DOM. Measured:
//      it drops typo detection from 19/19 to 11/19. So members are named
//      individually instead.
//   2. TS2320 fires when an interface extends two types that declare the same
//      member with NON-IDENTICAL types, and the DOM is full of mixins —
//      ParentNode, ElementCSSInlineStyle, HTMLOrSVGElement, SVGURIReference,
//      HTMLHyperlinkElementUtils — that are combined with Element/Node. Adding
//      `style?: any` here breaks SVGElement, MathMLElement and HTMLElement.
//
// Every member below was checked against lib.dom.d.ts one at a time and produces
// zero errors. `style`, `focus` and `blur` are declared with the EXACT signature
// the mixin uses (required, not optional) because that is what makes them
// identical and therefore legal. Do not "tidy" them into optionals.
//
// Deliberately absent, because no variant of them is safe: `id`, `children`
// and `href` (which is on HTMLElement instead, see there). Chains that go
// through `parentElement`, `form` or `parentNode` still reach them, since those
// are typed `any`. `type` is here: what a form control or event target is
// reads it to tell a checkbox from a text box, and it clashes with nothing.
interface Event {
    keyCode?:          number;
    charCode?:         number;
    which?:            number;
    button?:           number;
    clientX?:          number;
    clientY?:          number;
    ctrlKey?:          boolean;
    shiftKey?:         boolean;
    altKey?:           boolean;
}

interface EventTarget {
    type?:             any;
    tagName?:          string;
    className?:        string;
    style:             CSSStyleDeclaration;
    parentElement?:    any;
    parentNode?:       any;
    childNodes?:       any;
    firstChild?:       any;
    lastChild?:        any;
    nextSibling?:      any;
    previousSibling?:  any;
    innerHTML?:        string;
    innerText?:        string;
    outerHTML?:        string;
    value?:            any;
    checked?:          boolean;
    disabled?:         boolean;
    // `any` rather than `string`: MIDIPort declares `name: string | null`, and
    // under the strict build that is not assignable to `string | undefined`.
    name?:             any;
    title?:            string;
    src?:              string;
    form?:             any;
    rows?:             any;
    cells?:            any;
    options?:          any;
    selectedIndex?:    number;
    offsetWidth?:      number;
    offsetHeight?:     number;
    offsetTop?:        number;
    offsetLeft?:       number;
    getAttribute?(name: string): string | null;
    setAttribute?(name: string, value: string): void;
    click?(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
}
