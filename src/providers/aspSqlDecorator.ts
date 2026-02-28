import * as vscode from 'vscode';

// ─────────────────────────────────────────────────────────────────────────────
// SQL String Decorator
//
// Detects confirmed SQL strings (requires DML verb + clause keyword) across
// multi-line & _ continuations, and applies configurable decorations.
//
// Because tmLanguage grammars cannot do multi-keyword lookahead detection,
// SQL keyword token colouring inside strings is intentionally NOT done in
// the grammar file (to avoid false positives like "Select an option here!").
// Instead, this decorator applies BOTH a background highlight AND a foreground
// colour to confirmed SQL string ranges, giving full visual distinction.
//
// Settings (all under aspLanguageSupport.sqlHighlight.*):
//   enabled          — toggle the feature on/off
//   backgroundColor  — rgba colour for the background e.g. rgba(234, 92, 0, 0.33)
//   borderEnabled    — whether to show a border around SQL ranges
//   borderColor      — rgba colour for the border e.g. rgba(234, 92, 0, 0.63)
//   foregroundColor  — css colour for SQL string text e.g. #e8a87c
//                      set to "" to disable foreground colouring
// ─────────────────────────────────────────────────────────────────────────────

// ── SQL detection ─────────────────────────────────────────────────────────────
// Requires BOTH a DML/DDL verb AND a clause keyword.
// This prevents false positives like "Select an option" (verb but no clause)
// or "FROM the results" (clause but no verb) from being treated as SQL.
const SQL_VERBS   = /\b(SELECT|INSERT|UPDATE|DELETE|EXEC|EXECUTE|CREATE|DROP|ALTER|TRUNCATE|MERGE)\b/i;
const SQL_CLAUSES = /\b(FROM|INTO|TABLE|SET|VALUES|WHERE|JOIN|UNION|HAVING|GROUP\s+BY|ORDER\s+BY|RETURNING|DECLARE|BEGIN\s+TRAN|COMMIT|ROLLBACK)\b/i;

function isSql(text: string): boolean {
    return SQL_VERBS.test(text) && SQL_CLAUSES.test(text);
}

// ── Validate rgba() / css colour values ──────────────────────────────────────
// Accepts rgba(...), rgb(...), #hex, or named colours.
// Falls back to the provided default so the extension never breaks.
function safeColor(value: string, fallback: string): string {
    const v = value.trim();
    if (!v) { return ''; } // empty string = disabled
    const validRgba  = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/.test(v);
    const validHex   = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v);
    const validNamed = /^[a-zA-Z]+$/.test(v); // e.g. "orange", "transparent"
    return (validRgba || validHex || validNamed) ? v : fallback;
}

// ── Read settings and build a fresh decoration type ───────────────────────────
function buildDecorationFromSettings(): vscode.TextEditorDecorationType {
    const cfg           = vscode.workspace.getConfiguration('aspLanguageSupport.sqlHighlight');
    const bgColor       = safeColor(cfg.get<string>('backgroundColor', 'rgba(234, 92, 0, 0.33)'), 'rgba(234, 92, 0, 0.33)');
    const borderEnabled = cfg.get<boolean>('borderEnabled', false);
    const borderColor   = safeColor(cfg.get<string>('borderColor', 'rgba(234, 92, 0, 0.63)'), 'rgba(234, 92, 0, 0.63)');

    // Foreground colour — applied to SQL string text so it looks distinct
    // even without tmLanguage keyword colouring inside strings.
    // Default: a warm orange that complements most dark themes.
    // Set to "" in settings to disable foreground colouring entirely.
    const fgRaw = cfg.get<string>('foregroundColor', '#e8a87c');
    const fgColor = safeColor(fgRaw ?? '', '');

    return vscode.window.createTextEditorDecorationType({
        backgroundColor: bgColor,
        borderRadius:    '2px',
        ...(fgColor ? { color: fgColor } : {}),
        ...(borderEnabled ? {
            border: `1px solid ${borderColor}`,
        } : {}),
        isWholeLine: false,
    });
}

// ── String extraction with & _ continuation stitching ────────────────────────
interface StringGroup {
    stitched: string;
    ranges:   vscode.Range[];
}

function extractStringGroups(document: vscode.TextDocument): StringGroup[] {
    const groups: StringGroup[] = [];
    const lineCount = document.lineCount;

    let i = 0;
    while (i < lineCount) {
        const lineText = document.lineAt(i).text;
        let col = 0;

        while (col < lineText.length) {
            if (lineText[col] !== '"') { col++; continue; }

            // Found opening quote — read string content
            col++;
            const contentStartCol = col;
            let content = '';

            while (col < lineText.length) {
                if (lineText[col] === '"') {
                    if (col + 1 < lineText.length && lineText[col + 1] === '"') {
                        content += '"';
                        col += 2;
                    } else {
                        break;
                    }
                } else {
                    content += lineText[col++];
                }
            }

            if (col >= lineText.length) { col++; continue; } // unterminated string

            const closeCol = col;
            col++; // step past closing quote

            const group: StringGroup = {
                stitched: content,
                ranges:   [new vscode.Range(
                    new vscode.Position(i, contentStartCol),
                    new vscode.Position(i, closeCol)
                )],
            };

            // Follow & _ continuations
            let scanLine = i;
            let scanText = lineText;
            let scanCol  = col;

            while (true) {
                // Check if rest of line ends with & _  (ignoring inline comments)
                const rest        = scanText.substring(scanCol).trimEnd();
                const commentPos  = rest.indexOf("'");
                const effective   = commentPos !== -1 ? rest.substring(0, commentPos).trimEnd() : rest;
                if (!/&\s*_$/.test(effective)) break;

                scanLine++;
                if (scanLine >= lineCount) break;

                const nextText    = document.lineAt(scanLine).text;
                const nextTrimmed = nextText.trimStart();
                const indent      = nextText.length - nextTrimmed.length;

                if (!nextTrimmed.startsWith('"')) break;

                // Read next fragment
                let nCol     = indent + 1;
                const nStart = nCol;
                let nContent = '';

                while (nCol < nextText.length) {
                    if (nextText[nCol] === '"') {
                        if (nCol + 1 < nextText.length && nextText[nCol + 1] === '"') {
                            nContent += '"';
                            nCol += 2;
                        } else { break; }
                    } else {
                        nContent += nextText[nCol++];
                    }
                }

                const nClose = nCol;
                nCol++;

                group.stitched += ' ' + nContent;
                group.ranges.push(new vscode.Range(
                    new vscode.Position(scanLine, nStart),
                    new vscode.Position(scanLine, nClose)
                ));

                scanText = nextText;
                scanCol  = nCol;
                // scanLine is already incremented above — no reassignment needed
            }

            groups.push(group);
        }

        i++;
    }

    return groups;
}

// ── Main decorator class ──────────────────────────────────────────────────────
export class AspSqlDecorator implements vscode.Disposable {

    private _decoration: vscode.TextEditorDecorationType;
    private _disposables: vscode.Disposable[] = [];

    constructor() {
        this._decoration = buildDecorationFromSettings();

        // Re-decorate when active editor changes
        this._disposables.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (editor) { this.decorate(editor); }
            })
        );

        // Re-decorate on text change
        this._disposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                const editor = vscode.window.activeTextEditor;
                if (editor && event.document === editor.document) {
                    this.decorate(editor);
                }
            })
        );

        // Rebuild decoration type when settings change
        this._disposables.push(
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('aspLanguageSupport.sqlHighlight')) {
                    // Dispose old decoration type and build a new one with updated settings
                    this._decoration.dispose();
                    this._decoration = buildDecorationFromSettings();

                    // Re-apply to current editor immediately
                    if (vscode.window.activeTextEditor) {
                        this.decorate(vscode.window.activeTextEditor);
                    }
                }
            })
        );

        // Apply immediately to current editor
        if (vscode.window.activeTextEditor) {
            this.decorate(vscode.window.activeTextEditor);
        }
    }

    decorate(editor: vscode.TextEditor): void {
        const cfg     = vscode.workspace.getConfiguration('aspLanguageSupport.sqlHighlight');
        const enabled = cfg.get<boolean>('enabled', true);

        if (editor.document.languageId !== 'asp' || !enabled) {
            editor.setDecorations(this._decoration, []);
            return;
        }

        const groups    = extractStringGroups(editor.document);
        const sqlRanges = groups
            .filter(g => isSql(g.stitched))
            .flatMap(g => g.ranges);

        editor.setDecorations(this._decoration, sqlRanges);
    }

    dispose(): void {
        this._disposables.forEach(d => d.dispose());
        this._decoration.dispose();
    }
}