/**
 * asp-dom.d.ts
 *
 * Custom TypeScript definitions for Classic ASP embedded JavaScript.
 * 
 * Adds element-specific methods/properties to HTMLElement to prevent false
 * errors when accessing form.submit(), input.value, etc. without casting.
 */

interface HTMLElement {
    // HTMLFormElement methods
    submit?: () => void;
    reset?: () => void;
    
    // HTMLInputElement / HTMLTextAreaElement / HTMLSelectElement properties
    value?: string;
    checked?: boolean;
    selectedIndex?: number;
    options?: HTMLOptionsCollection;
    
    // HTMLTableElement / HTMLTableRowElement methods
    insertRow?: (index?: number) => HTMLTableRowElement;
    deleteRow?: (index: number) => void;
    insertCell?: (index?: number) => HTMLTableCellElement;
    deleteCell?: (index: number) => void;
}