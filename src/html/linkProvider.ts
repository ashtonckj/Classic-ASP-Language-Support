import * as vscode from 'vscode';
import * as path from 'path';
import { isExternalPath, FILE_LINK_ATTRIBUTES } from './htmlLinkUtils';
import { getVirtualRoot } from '../asp/includeProvider';
import { parseIncludeDirectives, resolveIncludeDirective } from '../core/includeDirectives';
import { isFile } from '../core/paths';
import { textOf, zonesFor } from '../platform/documentState';
import { pathCompletions } from '../platform/pathCompletion';

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

                if (!isFile(fullPath)) continue;

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
// Underlines the paths in href, src, action, and data-src attributes, resolved
// the way VS Code's own HTML support resolves them in a .html file.
// ─────────────────────────────────────────────────────────────────────────────

/** Where an attribute value points: a file, or a place in this same page. */
export type HtmlLinkTarget = { file: string } | { fragment: string };

/**
 * Where an href/src value points, by the rules a .html file follows:
 *   • a value with a scheme (http:, mailto:, javascript:, data:, …) or `//host`
 *     is not a local path, and VS Code's own URL detection handles the URLs;
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
    if (/^\w[\w\d+.-]*:/.test(ref) || ref.startsWith('//')) { return undefined; }
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

// The value quoted either way, or bare (`href=page.asp`), as HTML allows.
const FILE_LINK_PATTERN = new RegExp(
    `\\b(?:${FILE_LINK_ATTRIBUTES.join('|')})\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s"'<>\`]+))`,
    'gi',
);

export class HtmlAttributeLinkProvider implements vscode.DocumentLinkProvider {

    provideDocumentLinks(
        document: vscode.TextDocument
    ): vscode.ProviderResult<vscode.DocumentLink[]> {

        const links:       vscode.DocumentLink[] = [];
        const text        = textOf(document);
        const zones       = zonesFor(document);
        const virtualRoot = getVirtualRoot(document.uri.fsPath);
        const onDisk      = document.uri.scheme === 'file';

        // Existence is deliberately not checked: a .html file links a missing
        // page too, and following it offers to create the file. Asking the disk
        // once per link was also slow on the network shares IIS sites live on.
        FILE_LINK_PATTERN.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = FILE_LINK_PATTERN.exec(text)) !== null) {
            // Only real markup: an href inside a Response.Write string or a
            // JavaScript string is text there, as it is in a .html file.
            if (zones.zoneAt(match.index) !== 'html') { continue; }

            const quoted = match[1] ?? match[2];
            const value  = quoted ?? match[3];
            const target = resolveHtmlLink(value, document.uri.fsPath, virtualRoot);
            if (!target) { continue; }
            // A page that is not on disk has no folder for a relative path to start from.
            if ('file' in target && !onDisk && !value.trim().startsWith('/')) { continue; }

            const valueEnd   = match.index + match[0].length - (quoted !== undefined ? 1 : 0);
            const valueStart = valueEnd - value.length;
            const link = new vscode.DocumentLink(
                new vscode.Range(document.positionAt(valueStart), document.positionAt(valueEnd)),
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
// Suggests files and folders inside href, src, action, and data-src attribute
// values, the way IncludePathCompletionProvider does (platform/pathCompletion).
// Skips values that are already external URLs.
// ─────────────────────────────────────────────────────────────────────────────

// Pattern matching the opening of any file-link attribute up to the cursor,
// capturing the typed path so far. Used to decide when to activate.
const ATTR_TRIGGER_PATTERN = new RegExp(
    `\\b(${FILE_LINK_ATTRIBUTES.join('|')})\\s*=\\s*["']([^"']*)$`,
    'i'
);

export class HtmlAttributePathCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token?: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {

        const lineText   = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);

        const attrMatch = textBefore.match(ATTR_TRIGGER_PATTERN);

        // If no attribute match, return false so we don't interfere with other providers.
        if (!attrMatch) return new vscode.CompletionList([], false);

        const typedSoFar = attrMatch[2];

        // Don't suggest for external URLs, but return isIncomplete:true so the
        // session stays alive — VS Code's built-in HTML provider would otherwise
        // close the suggestion session with isIncomplete:false, preventing our
        // provider from firing again when the user continues typing.
        if (isExternalPath(typedSoFar)) return new vscode.CompletionList([], true);

        // A root-relative path browses from the site root, as it does in a .html
        // file; it used to be resolved against the drive root.
        const baseDir = typedSoFar.startsWith('/')
            ? getVirtualRoot(document.uri.fsPath)
            : path.dirname(document.uri.fsPath);

        return pathCompletions(position, typedSoFar, baseDir, 'File', token);
    }
}
