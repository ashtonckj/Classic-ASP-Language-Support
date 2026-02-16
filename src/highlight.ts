import { ExtensionContext, Range, TextEditorDecorationType, window, workspace } from "vscode";
import { getAspRegions } from "./region";

export function addRegionHighlights(context: ExtensionContext) {
	// Declare all variables at the top of the function
	let timeout: NodeJS.Timeout | null = null;
	let bracketDecorationType: TextEditorDecorationType;
	let codeBlockDecorationType: TextEditorDecorationType;
	let configurationDidChange = false;

	function isAspFile(editor: { document: { languageId: string; fileName: string } } | undefined): boolean {
		if (!editor) { return false; }
		return editor.document.languageId === 'html' && editor.document.fileName.endsWith('.asp');
	}

	let activeEditor = window.activeTextEditor;
	if (isAspFile(activeEditor)) {
		triggerUpdateDecorations();
	}

	window.onDidChangeActiveTextEditor(editor => {
		activeEditor = editor;
		if (isAspFile(editor)) {
			triggerUpdateDecorations();
		}
	}, null, context.subscriptions);

	workspace.onDidChangeConfiguration(event => {
		configurationDidChange = true;
		triggerUpdateDecorations();
	});

	workspace.onDidChangeTextDocument(event => {
		if (activeEditor && event.document === activeEditor.document && isAspFile(activeEditor)) {
			triggerUpdateDecorations();
		}
	}, null, context.subscriptions);

	function triggerUpdateDecorations() {
		if (timeout) {
			clearTimeout(timeout);
		}
		timeout = setTimeout(updateDecorations, 200);
	}

	function setDecorationTypes() {
		const aspConfig = workspace.getConfiguration("aspLanguageSupport");

		const bracketLightColor = aspConfig.get<string>("bracketLightColor");
		const bracketDarkColor = aspConfig.get<string>("bracketDarkColor");
		const codeBlockLightColor = aspConfig.get<string>("codeBlockLightColor");
		const codeBlockDarkColor = aspConfig.get<string>("codeBlockDarkColor");

		bracketDecorationType = window.createTextEditorDecorationType({
			light: {
				backgroundColor: bracketLightColor
			},
			dark: {
				backgroundColor: bracketDarkColor
			}
		});

		codeBlockDecorationType = window.createTextEditorDecorationType({
			light: {
				backgroundColor: codeBlockLightColor
			},
			dark: {
				backgroundColor: codeBlockDarkColor
			}
		});
	}

	function updateDecorations() {
		if (!activeEditor) {
			return;
		}

		if (!isAspFile(activeEditor)) {
			return;
		}

		const aspConfig = workspace.getConfiguration("aspLanguageSupport");
		const highlightAspRegions: boolean = aspConfig.get<boolean>("highlightAspRegions", true);

		// Create our decoration types
		if(!bracketDecorationType || !codeBlockDecorationType) {
			setDecorationTypes();
		}

		if(configurationDidChange || !highlightAspRegions) {
			if (bracketDecorationType) {
				bracketDecorationType.dispose();
			}
			if (codeBlockDecorationType) {
				codeBlockDecorationType.dispose();
			}
			setDecorationTypes();

			configurationDidChange = false;
		}

		if (!highlightAspRegions) {
			return;
		}

		const regions = getAspRegions(activeEditor.document);

		if (!regions || regions.length === 0) {
			return;
		}

		const blocks: Range[] = [];
		const brackets: Range[] = [];

		for(const region of regions) {
			brackets.push(region.openingBracket);
			blocks.push(region.codeBlock);
			brackets.push(region.closingBracket);
		}

		activeEditor.setDecorations(bracketDecorationType, brackets);
		activeEditor.setDecorations(codeBlockDecorationType, blocks);
	}
}