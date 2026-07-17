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
];
