/**
 * asp-dom.d.ts
 *
 * Custom TypeScript definitions for Classic ASP embedded JavaScript.
 *
 * Overrides document.getElementById to return a rich union of all concrete
 * HTML element interfaces instead of the base HTMLElement. This means:
 *
 *   - form.submit(), form.reset(), form.elements  → HTMLFormElement  ✓
 *   - input.value, input.checked, input.select()  → HTMLInputElement ✓
 *   - select.value, select.selectedIndex, select.options → HTMLSelectElement ✓
 *   - textarea.value, textarea.select()           → HTMLTextAreaElement ✓
 *   - table.insertRow(), table.deleteRow()        → HTMLTableElement ✓
 *   - tr.insertCell(), tr.deleteCell()            → HTMLTableRowElement ✓
 *   - img.src, img.alt                            → HTMLImageElement ✓
 *   - a.href, a.click()                           → HTMLAnchorElement ✓
 *   - button.disabled, button.click()             → HTMLButtonElement ✓
 *   - ...and all other HTMLXxxElement types from lib.dom.d.ts
 *
 * We do NOT augment HTMLElement itself — that would conflict with the
 * subinterfaces in lib.dom.d.ts and produce ts(2430) errors.
 *
 * The union approach preserves real type errors: if the element doesn't
 * expose a property (e.g. a <div> has no .submit), TypeScript still warns.
 */

type AspHtmlElement =
    | HTMLFormElement
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
    | HTMLButtonElement
    | HTMLAnchorElement
    | HTMLImageElement
    | HTMLTableElement
    | HTMLTableRowElement
    | HTMLTableCellElement
    | HTMLTableSectionElement
    | HTMLLabelElement
    | HTMLLegendElement
    | HTMLFieldSetElement
    | HTMLOptionElement
    | HTMLOptGroupElement
    | HTMLDivElement
    | HTMLSpanElement
    | HTMLParagraphElement
    | HTMLHeadingElement
    | HTMLUListElement
    | HTMLOListElement
    | HTMLLIElement
    | HTMLCanvasElement
    | HTMLVideoElement
    | HTMLAudioElement
    | HTMLIFrameElement
    | HTMLScriptElement
    | HTMLStyleElement
    | HTMLLinkElement
    | HTMLMetaElement
    | HTMLBodyElement;

interface Document {
    getElementById(elementId: string): AspHtmlElement | null;
}