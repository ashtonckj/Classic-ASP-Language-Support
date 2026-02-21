/**
 * jsKeywords.ts
 * JavaScript keywords and control flow snippets.
 */

export const JS_KEYWORDS = [
    // Control flow
    { keyword: 'if', snippet: 'if (${1:condition}) {\n\t$0\n}', description: 'If statement' },
    { keyword: 'else', snippet: 'else {\n\t$0\n}', description: 'Else clause' },
    { keyword: 'else if', snippet: 'else if (${1:condition}) {\n\t$0\n}', description: 'Else if clause' },
    { keyword: 'switch', snippet: 'switch (${1:expression}) {\n\tcase ${2:value}:\n\t\t$0\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}', description: 'Switch statement' },
    { keyword: 'for', snippet: 'for (let ${1:i} = 0; ${1:i} < ${2:length}; ${1:i}++) {\n\t$0\n}', description: 'For loop' },
    { keyword: 'for...of', snippet: 'for (const ${1:item} of ${2:items}) {\n\t$0\n}', description: 'For...of loop' },
    { keyword: 'for...in', snippet: 'for (const ${1:key} in ${2:object}) {\n\t$0\n}', description: 'For...in loop' },
    { keyword: 'while', snippet: 'while (${1:condition}) {\n\t$0\n}', description: 'While loop' },
    { keyword: 'do...while', snippet: 'do {\n\t$0\n} while (${1:condition});', description: 'Do...while loop' },
    { keyword: 'break', snippet: 'break;', description: 'Break out of loop' },
    { keyword: 'continue', snippet: 'continue;', description: 'Continue to next iteration' },
    { keyword: 'return', snippet: 'return $0;', description: 'Return statement' },

    // Declarations
    { keyword: 'const', snippet: 'const ${1:name} = $0;', description: 'Constant variable' },
    { keyword: 'let', snippet: 'let ${1:name} = $0;', description: 'Block-scoped variable' },
    { keyword: 'var', snippet: 'var ${1:name} = $0;', description: 'Variable declaration' },

    // Functions
    { keyword: 'function', snippet: 'function ${1:name}($2) {\n\t$0\n}', description: 'Function declaration' },
    { keyword: 'arrow function', snippet: 'const ${1:name} = ($2) => {\n\t$0\n};', description: 'Arrow function' },
    { keyword: 'async function', snippet: 'async function ${1:name}($2) {\n\t$0\n}', description: 'Async function' },
    { keyword: 'async arrow', snippet: 'const ${1:name} = async ($2) => {\n\t$0\n};', description: 'Async arrow function' },

    // Classes
    { keyword: 'class', snippet: 'class ${1:Name} {\n\tconstructor($2) {\n\t\t$0\n\t}\n}', description: 'Class declaration' },
    { keyword: 'extends', snippet: 'class ${1:Name} extends ${2:Base} {\n\tconstructor($3) {\n\t\tsuper($3);\n\t\t$0\n\t}\n}', description: 'Class with inheritance' },

    // Error handling
    { keyword: 'try', snippet: 'try {\n\t$0\n} catch (${1:error}) {\n\t\n}', description: 'Try-catch block' },
    { keyword: 'try...finally', snippet: 'try {\n\t$0\n} catch (${1:error}) {\n\t\n} finally {\n\t\n}', description: 'Try-catch-finally block' },
    { keyword: 'throw', snippet: 'throw new Error(\'$0\');', description: 'Throw an error' },

    // Modules (useful in modern script blocks)
    { keyword: 'import', snippet: "import { $1 } from '$0';", description: 'Import statement' },
    { keyword: 'export', snippet: 'export { $0 };', description: 'Export statement' },

    // Misc
    { keyword: 'typeof', snippet: 'typeof $0', description: 'Type check' },
    { keyword: 'instanceof', snippet: '${1:obj} instanceof ${2:Class}', description: 'Instance check' },
    { keyword: 'new', snippet: 'new ${1:Class}($0)', description: 'Create new instance' },
    { keyword: 'delete', snippet: 'delete ${1:obj}.${0:property}', description: 'Delete property' },
    { keyword: 'void', snippet: 'void $0', description: 'Void operator' },
    { keyword: 'await', snippet: 'await $0', description: 'Await a promise' },
    { keyword: 'yield', snippet: 'yield $0', description: 'Yield in generator' },
    { keyword: 'debugger', snippet: 'debugger;', description: 'Debugger breakpoint' },
];