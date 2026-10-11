import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readIncludeText } from '../../asp/includeProvider';

describe('readIncludeText', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-include-text-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    // VS Code strips the mark, so keeping it would put every position on the
    // first line one column to the right, and rename would edit the wrong text.
    it('drops a UTF-8 byte order mark, as the editor does', () => {
        const file = path.join(dir, 'lib.inc');
        fs.writeFileSync(file, '﻿<% Sub Bump() : End Sub %>');
        assert.strictEqual(readIncludeText(file), '<% Sub Bump() : End Sub %>');
    });
});
