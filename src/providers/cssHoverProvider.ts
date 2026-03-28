import * as vscode from 'vscode';
import { getCSSLanguageService } from 'vscode-css-languageservice';
import { getZone, buildCssDoc, getInlineStyleContext, buildInlineCssDoc } from '../utils/cssUtils';

const cssService = getCSSLanguageService();

export class CssHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.Hover | null {
        const content = document.getText();
        const offset  = document.offsetAt(position);
        const zone    = getZone(content, offset);

        // ── Inline style="" attribute hover ───────────────────────────────────
        // Run for all non-css zones — style="" can appear in HTML, ASP, or JS zones.
        if (zone !== 'css') {
            const inlineCtx = getInlineStyleContext(content, offset);
            if (inlineCtx) {
                const lsDoc = buildInlineCssDoc(
                    document.uri.toString(),
                    content,
                    document.version,
                    inlineCtx.valueStart,
                    inlineCtx.valueEnd
                );
                const stylesheet = cssService.parseStylesheet(lsDoc);
                const lsPosition = lsDoc.positionAt(inlineCtx.wrappedOffset);
                const hover      = cssService.doHover(lsDoc, lsPosition, stylesheet);
                if (!hover) return null;
                return new vscode.Hover(lsHoverToMarkdown(hover.contents));
            }
            return null;
        }

        // ── <style> block hover ───────────────────────────────────────────────
        const lsDoc = buildCssDoc(document.uri.toString(), content, document.version, offset);
        if (!lsDoc) return null;

        const stylesheet = cssService.parseStylesheet(lsDoc);
        const lsPosition = lsDoc.positionAt(offset);
        const hover      = cssService.doHover(lsDoc, lsPosition, stylesheet);
        if (!hover) return null;

        return new vscode.Hover(lsHoverToMarkdown(hover.contents));
    }
}

/**
 * Converts the CSS language service hover contents (which can be a string,
 * a MarkedString { language, value }, a MarkupContent { kind, value },
 * or an array of any of the above) into a single VS Code MarkdownString.
 *
 * Using `any` for the parameter avoids the version-skew between the LS
 * types (MarkupContent | MarkedString | MarkedString[]) and VS Code's own
 * hover content types — both shapes have a `.value` string property so
 * the runtime behaviour is identical regardless of the declared type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lsHoverToMarkdown(raw: any): vscode.MarkdownString {
    if (!raw) { return new vscode.MarkdownString(); }
    if (typeof raw === 'string') { return new vscode.MarkdownString(raw); }
    if (Array.isArray(raw)) {
        const parts = (raw as any[]).map((c: any) =>
            typeof c === 'string' ? c : (c.value ?? '')
        );
        return new vscode.MarkdownString(parts.join('\n\n'));
    }
    // MarkupContent { kind, value } or MarkedString { language, value }
    return new vscode.MarkdownString(raw.value ?? '');
}