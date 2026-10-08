/**
 * parseCache.ts
 *
 * The last parse of each recent file, so a second question about the same text
 * parses nothing: hover then Go to Definition on one page, or the checks
 * reading the includes they read a moment ago.
 *
 * One per thread — the extension host, the VBScript worker, the include worker
 * — each with its own bounds. A file's entry is used only while its text is
 * the same; the least recently used go first once the cache holds more files,
 * or more text, than its bounds. Text is the measure because a parse is a few
 * times the size of its text, and one 14,000-line page outweighs a hundred
 * small includes.
 */

import { parsePage, type ParsedPage } from './symbols';
import { pathKey } from '../core/paths';

export class ParseCache {
    private readonly pages = new Map<string, ParsedPage>();
    private chars = 0;

    constructor(
        /** The most files kept. */
        private readonly maxFiles: number,
        /** The most text kept, in characters; the newest file is kept whatever its size. */
        private readonly maxChars: number,
    ) {}

    /** The parse of `text`, the text of `fsPath`, from the cache when the file's text is unchanged. */
    parse(fsPath: string, text: string): ParsedPage {
        const key = pathKey(fsPath);
        const known = this.pages.get(key);
        if (known && known.text === text) {
            // Most recently used goes to the end.
            this.pages.delete(key);
            this.pages.set(key, known);
            return known;
        }

        const page = parsePage(text);
        if (known) { this.forget(key, known); }
        this.pages.set(key, page);
        this.chars += text.length;

        for (const [oldest, oldPage] of this.pages) {
            if (this.pages.size <= 1 || (this.pages.size <= this.maxFiles && this.chars <= this.maxChars)) { break; }
            this.forget(oldest, oldPage);
        }
        return page;
    }

    /** How many files, and how much text, the cache holds. */
    get size(): { files: number; chars: number } {
        return { files: this.pages.size, chars: this.chars };
    }

    clear(): void {
        this.pages.clear();
        this.chars = 0;
    }

    private forget(key: string, page: ParsedPage): void {
        this.pages.delete(key);
        this.chars -= page.text.length;
    }
}
