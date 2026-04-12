/**
 * asp-dom.d.ts
 *
 * Augments the standard HTMLElement interface so that Classic ASP inline
 * scripts can call element-specific members (e.g. .submit(), .value,
 * .selectedIndex) without type errors — regardless of how the element was
 * retrieved (getElementById, querySelector, etc.).
 *
 * This mirrors how plain .html files behave: VS Code's HTML language service
 * does not enforce that getElementById returns a specific subtype, so calling
 * .submit() on an arbitrary element never errors there. We achieve the same
 * effect by declaration-merging all extra members directly onto HTMLElement
 * as optional properties — no custom interface needed, and Document is left
 * completely untouched.
 *
 * ── Type-compatibility rules (ts2430) ────────────────────────────────────────
 * Every member added here must be compatible with the same member on every
 * HTMLElement subinterface in lib.dom.d.ts. Where subinterfaces disagree on
 * type or mutability, we use the widest compatible form:
 *
 *   options            readonly HTMLCollectionOf<HTMLOptionElement>
 *                        HTMLDataListElement: readonly HTMLCollectionOf<HTMLOptionElement>
 *                        HTMLSelectElement:   HTMLOptionsCollection  (extends HTMLCollectionOf, so ours is wider — ok)
 *
 *   value              string | number
 *                        HTMLInputElement/HTMLTextAreaElement: string
 *                        HTMLLIElement/HTMLMeterElement/HTMLProgressElement: number
 *
 *   rows               string | number | HTMLCollectionOf<HTMLTableRowElement>
 *                        HTMLFrameSetElement:  string  (deprecated frameset cols/rows attr)
 *                        HTMLTextAreaElement:  number  (visible rows count)
 *                        HTMLTableElement:     HTMLCollectionOf<HTMLTableRowElement>
 *
 *   size               string | number
 *                        HTMLFontElement/HTMLHRElement: string (deprecated)
 *                        HTMLSelectElement:             number
 *
 *   max / min          string | number
 *                        HTMLInputElement:  string
 *                        HTMLMeterElement:  number
 *
 *   selectionStart /   number | null
 *   selectionEnd         HTMLInputElement:    number | null
 *                        HTMLTextAreaElement: number        (subset — our union is wider, ok)
 *
 *   validationMessage  readonly string
 *   validity           readonly ValidityState
 *                        HTMLTextAreaElement (and others) declare both readonly
 * ─────────────────────────────────────────────────────────────────────────────
 */

interface HTMLElement {

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
    // string | number: string on input/textarea, number on li/meter/progress.
    value?:               string | number;
    defaultValue?:        string;
    checked?:             boolean;
    defaultChecked?:      boolean;
    indeterminate?:       boolean;
    placeholder?:         string;
    readOnly?:            boolean;
    required?:            boolean;
    maxLength?:           number;
    minLength?:           number;
    // string | number: string on input[type=date/number/...], number on meter.
    max?:                 string | number;
    min?:                 string | number;
    step?:                string;
    pattern?:             string;
    multiple?:            boolean;
    accept?:              string;
    files?:               FileList | null;
    // number | null: HTMLInputElement uses number|null, HTMLTextAreaElement uses number.
    // Our union is the wider type so both subinterfaces remain compatible.
    selectionStart?:      number | null;
    selectionEnd?:        number | null;
    // readonly: HTMLTextAreaElement (and HTMLButtonElement etc.) declare both readonly.
    readonly validationMessage?: string;
    readonly validity?:          ValidityState;
    select?():            void;
    setSelectionRange?(start: number | null, end: number | null, direction?: string): void;
    setCustomValidity?(error: string): void;

    // ── HTMLSelectElement ─────────────────────────────────────────────────────
    selectedIndex?:   number;
    // readonly + HTMLCollectionOf<HTMLOptionElement>: matches HTMLDataListElement exactly.
    // HTMLSelectElement.options is HTMLOptionsCollection which extends HTMLCollectionOf<HTMLOptionElement>,
    // so our wider base type is still compatible.
    readonly options?:         HTMLCollectionOf<HTMLOptionElement>;
    selectedOptions?: HTMLCollectionOf<HTMLOptionElement>;
    // string | number: number on select, string on font/hr (deprecated).
    size?:            string | number;

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
    // string | number | HTMLCollectionOf<...>:
    //   HTMLFrameSetElement → string (deprecated rows attr)
    //   HTMLTextAreaElement → number (visible row count)
    //   HTMLTableElement    → HTMLCollectionOf<HTMLTableRowElement>
    rows?:                       string | number | HTMLCollectionOf<HTMLTableRowElement>;
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