import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

// Flat config. Uses the installed @typescript-eslint/{parser,eslint-plugin}
// packages directly (the previous config imported the `typescript-eslint`
// meta-package, which is not a dependency of this project).
export default [
    {
        files: ["**/*.ts"],

        plugins: {
            "@typescript-eslint": tsPlugin,
        },

        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: "module",
        },

        rules: {
            "@typescript-eslint/naming-convention": ["warn", {
                selector: "import",
                format: ["camelCase", "PascalCase"],
            }],

            // curly: "warn",
            eqeqeq: "warn",
            "no-throw-literal": "warn",
            semi: "warn",
        },
    },

    // ── The import direction (CLAUDE.md 3.1) ─────────────────────────────────
    // Core code runs on the worker threads and in unit tests with no vscode
    // module, so it may not import vscode or anything that does.
    {
        files: ["src/core/**/*.ts", "src/vbscript/**/*.ts", "src/constants/**/*.ts"],
        rules: {
            "no-restricted-imports": ["error", {
                paths: [{ name: "vscode", message: "Core code is vscode-free: it runs on the workers and in unit tests." }],
                patterns: [{
                    group: ["../platform/*", "../asp/*", "../html/*", "../css/*", "../js/*", "../formatter/*", "../workers/*", "../extension"],
                    message: "Core code imports only core code (core/, vbscript/, constants/).",
                }],
            }],
        },
    },
    // The worker entries, and the JavaScript module the JS worker loads.
    {
        files: ["src/workers/*Worker.ts", "src/workers/serveWorker.ts", "src/js/jsUtils.ts"],
        rules: {
            "no-restricted-imports": ["error", {
                paths: [{ name: "vscode", message: "A worker thread has no vscode module." }],
                patterns: [{
                    group: ["../platform/*", "../asp/*", "../html/*", "../css/*", "../formatter/*", "../extension"],
                    message: "A worker loads only vscode-free code.",
                }],
            }],
        },
    },
    // The formatter works out text and tells nobody; it never reaches into a
    // provider. (formatCommands.ts is the editor side and may.)
    {
        files: ["src/formatter/htmlFormatter.ts", "src/formatter/aspFormatter.ts"],
        rules: {
            "no-restricted-imports": ["error", {
                paths: [{ name: "vscode", message: "The formatter returns a result; formatCommands.ts talks to the editor." }],
                patterns: [{
                    group: ["../asp/*", "../html/*", "../css/*", "../js/*"],
                    message: "The formatter never imports a provider: shared logic moves down to core/.",
                }],
            }],
        },
    },
];
