/**
 * asp-dom.d.ts
 */

interface AspHtmlElement extends HTMLElement {

    // ── HTMLFormElement ───────────────────────────────────────────────────────
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

    // ── HTMLInputElement / HTMLTextAreaElement ────────────────────────────────
    value?:             string;
    defaultValue?:      string;
    checked?:           boolean;
    defaultChecked?:    boolean;
    indeterminate?:     boolean;
    placeholder?:       string;
    readOnly?:          boolean;
    required?:          boolean;
    maxLength?:         number;
    minLength?:         number;
    max?:               string;
    min?:               string;
    step?:              string;
    pattern?:           string;
    multiple?:          boolean;
    accept?:            string;
    files?:             FileList | null;
    selectionStart?:    number | null;
    selectionEnd?:      number | null;
    validity?:          ValidityState;
    validationMessage?: string;
    select?():          void;
    setSelectionRange?(start: number, end: number, direction?: string): void;
    setCustomValidity?(error: string): void;

    // ── HTMLSelectElement ─────────────────────────────────────────────────────
    selectedIndex?:   number;
    options?:         HTMLOptionsCollection;
    selectedOptions?: HTMLCollectionOf<HTMLOptionElement>;
    size?:            number;

    // ── HTMLOptionElement ─────────────────────────────────────────────────────
    selected?:  boolean;
    label?:     string;
    text?:      string;
    index?:     number;

    // ── HTMLImageElement ──────────────────────────────────────────────────────
    naturalWidth?:  number;
    naturalHeight?: number;
    complete?:      boolean;
    currentSrc?:    string;

    // ── HTMLTableElement ──────────────────────────────────────────────────────
    insertRow?(index?: number):  HTMLTableRowElement;
    deleteRow?(index: number):   void;
    createTHead?():              HTMLTableSectionElement;
    createTFoot?():              HTMLTableSectionElement;
    createTBody?():              HTMLTableSectionElement;
    deleteTHead?():              void;
    deleteTFoot?():              void;
    rows?:                       HTMLCollectionOf<HTMLTableRowElement>;
    tHead?:                      HTMLTableSectionElement | null;
    tFoot?:                      HTMLTableSectionElement | null;
    tBodies?:                    HTMLCollectionOf<HTMLTableSectionElement>;
    caption?:                    HTMLTableCaptionElement | null;

    // ── HTMLTableRowElement ───────────────────────────────────────────────────
    insertCell?(index?: number): HTMLTableCellElement;
    deleteCell?(index: number):  void;
    cells?:                      HTMLCollectionOf<HTMLTableCellElement>;
    rowIndex?:                   number;
    sectionRowIndex?:            number;

    // ── HTMLTableCellElement ──────────────────────────────────────────────────
    colSpan?:   number;
    rowSpan?:   number;
    cellIndex?: number;
    abbr?:      string;
    scope?:     string;

    // ── HTMLMediaElement (video / audio) ──────────────────────────────────────
    play?():    Promise<void>;
    pause?():   void;
    canPlayType?(type: string): CanPlayTypeResult;
    paused?:    boolean;
    ended?:     boolean;
    volume?:    number;
    currentTime?: number;
    duration?:  number;

    // ── HTMLCanvasElement ─────────────────────────────────────────────────────
    toDataURL?(type?: string, quality?: any): string;
    toBlob?(callback: BlobCallback, type?: string, quality?: any): void;

    // ── HTMLIFrameElement ─────────────────────────────────────────────────────
    contentDocument?: Document | null;
    contentWindow?:   WindowProxy | null;

    // ── HTMLButtonElement ─────────────────────────────────────────────────────
    formAction?:     string;
    formMethod?:     string;
    formTarget?:     string;
    formNoValidate?: boolean;
}

interface Document {
    getElementById(elementId: string):      AspHtmlElement | null;
    querySelector(selector: string):        AspHtmlElement | null;
    querySelectorAll(selector: string):     NodeListOf<AspHtmlElement>;
    getElementsByTagName(name: string):     HTMLCollectionOf<AspHtmlElement>;
    getElementsByClassName(names: string):  HTMLCollectionOf<AspHtmlElement>;
    getElementsByName(elementName: string): NodeListOf<AspHtmlElement>;
}