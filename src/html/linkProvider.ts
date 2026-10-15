import * as vscode from 'vscode';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { getVirtualRoot } from '../asp/includeProvider';
import { parseIncludeDirectives, resolveIncludeDirective } from '../core/includeDirectives';
import { textOf } from '../platform/documentState';
import { htmlPathCompletions, linkValues } from './htmlLanguageFeatures';

// ─────────────────────────────────────────────────────────────────────────────
// IncludeDocumentLinkProvider
// Underlines #include file="..." and virtual="..." paths with a "Follow link" tooltip.
// virtual="..." is resolved using the same getVirtualRoot() logic as the symbol
// provider so the two are always consistent.
// ─────────────────────────────────────────────────────────────────────────────

export class IncludeDocumentLinkProvider implements vscode.DocumentLinkProvider {

    provideDocumentLinks(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.DocumentLink[]> {

        const links:       vscode.DocumentLink[] = [];
        const virtualRoot = getVirtualRoot(document.uri.fsPath);

        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;

            for (const directive of parseIncludeDirectives(lineText)) {
                const includePath = directive.raw;
                const fullPath    = resolveIncludeDirective(directive, document.uri.fsPath, virtualRoot);

                // Not checked for existence, as HTML links are not: a stat per
                // include blocked the editor on a slow or dead network share,
                // and a missing include already has its own warning.
                // Underline only the path string, not the whole directive
                const pathStart = lineText.indexOf(includePath, directive.index);
                const link      = new vscode.DocumentLink(
                    new vscode.Range(
                        new vscode.Position(i, pathStart),
                        new vscode.Position(i, pathStart + includePath.length)
                    ),
                    vscode.Uri.file(fullPath)
                );
                link.tooltip = 'Follow link';
                links.push(link);
            }
        }

        return links;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HtmlAttributeLinkProvider
// Underlines the paths in the attributes a .html file links — href, src, a
// form's action… — resolved the way VS Code's own HTML support resolves them.
// ─────────────────────────────────────────────────────────────────────────────

/** Where an attribute value points: a file, or a place in this same page. */
export type HtmlLinkTarget = { file: string } | { fragment: string };

/**
 * True for a value that is not a local path: one with a scheme (http:, mailto:,
 * javascript:, data:, …) or a protocol-relative `//host`.
 */
export function isExternalLink(value: string): boolean {
    return /^\w[\w\d+.-]*:/.test(value) || value.startsWith('//');
}

/**
 * Where an href/src value points, by the rules a .html file follows:
 *   • an external value (isExternalLink) is not a local path, and VS Code's own
 *     URL detection handles the URLs;
 *   • `#top` is a place in this page;
 *   • `/images/x.gif` starts at the site root — the virtual root, which
 *     #include virtual="…" resolves from too — and anything else at the page's
 *     own folder;
 *   • a query string is dropped, and so is a fragment on another file;
 *   • %-escapes are decoded, so `my%20page.asp` is the file with the space.
 * A path built by ASP (`<%= base %>/x.asp`) cannot be resolved and gets nothing.
 */
export function resolveHtmlLink(value: string, documentPath: string, virtualRoot: string): HtmlLinkTarget | undefined {
    const ref = value.trim();
    if (!ref || /[\r\n]/.test(ref)) { return undefined; }
    if (isExternalLink(ref)) { return undefined; }
    if (ref.startsWith('#')) { return { fragment: ref.slice(1) }; }

    const pathPart = ref.replace(/[?#].*$/, '');
    if (!pathPart || pathPart.includes('<%')) { return undefined; }

    let decoded = pathPart;
    try { decoded = decodeURIComponent(pathPart); } catch { /* keep it as written */ }

    return {
        file: decoded.startsWith('/')
            ? path.join(virtualRoot, decoded.slice(1))
            : path.resolve(path.dirname(documentPath), decoded),
    };
}

export class HtmlAttributeLinkProvider implements vscode.DocumentLinkProvider {

    provideDocumentLinks(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.DocumentLink[]> {

        const links:       vscode.DocumentLink[] = [];
        const text        = textOf(document);
        const virtualRoot = getVirtualRoot(document.uri.fsPath);
        const onDisk      = document.uri.scheme === 'file';

        // Existence is deliberately not checked: a .html file links a missing
        // page too, and following it offers to create the file. Asking the disk
        // once per link was also slow on the network shares IIS sites live on.
        for (const { start, end } of linkValues(document)) {
            // The value as written, ASP and all: the HTML service read it blanked.
            const value  = text.slice(start, end);
            const target = resolveHtmlLink(value, document.uri.fsPath, virtualRoot);
            if (!target) { continue; }
            // A page that is not on disk has no folder for a relative path to start from.
            if ('file' in target && !onDisk && !value.trim().startsWith('/')) { continue; }

            const link = new vscode.DocumentLink(
                new vscode.Range(document.positionAt(start), document.positionAt(end)),
                'file' in target
                    ? vscode.Uri.file(target.file)
                    : document.uri.with({ fragment: target.fragment }),
            );
            link.tooltip = 'Follow link';
            links.push(link);
        }

        return links;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HtmlAttributePathCompletionProvider
// Suggests files and folders inside the same attributes' values, as a .html
// file does: the HTML service decides where, and this resolves the paths the
// way the links above resolve them.
// ─────────────────────────────────────────────────────────────────────────────

export class HtmlAttributePathCompletionProvider implements vscode.CompletionItemProvider {

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.CompletionList> {
        // Not for a value that is already a URL or a fragment, but incomplete, so
        // the session stays alive — VS Code's built-in HTML provider would
        // otherwise close it, and this provider would not fire again as the
        // user goes on typing.
        const typed = document.lineAt(position.line).text.slice(0, position.character).match(/["']([^"']*)$/)?.[1];
        if (typed !== undefined && (isExternalLink(typed) || typed.startsWith('#'))) { return new vscode.CompletionList([], true); }

        const virtualRoot = getVirtualRoot(document.uri.fsPath);
        const onDisk      = document.uri.scheme === 'file';
        const items = await htmlPathCompletions(document, position, ref => {
            // A value starting with ASP reads as blank to the service: its folder is unknown.
            if (/^\s/.test(ref)) { return undefined; }
            const target = resolveHtmlLink(ref, document.uri.fsPath, virtualRoot);
            if (!target || !('file' in target) || (!onDisk && !ref.startsWith('/'))) { return undefined; }
            return pathToFileURL(target.file).href;
        });
        return new vscode.CompletionList(items, true);
    }
}

/** True when `offset` is inside the value of one of the page's link attributes. */
export function inLinkValue(document: vscode.TextDocument, offset: number): boolean {
    return linkValues(document).some(value => value.start <= offset && offset <= value.end);
}