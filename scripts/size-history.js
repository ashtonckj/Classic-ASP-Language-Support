#!/usr/bin/env node
/**
 * size-history.js
 *
 * Builds the size history for issue #32 from the published releases, as a
 * Mermaid chart plus the table behind it.
 *
 * The point is that it is regenerated rather than edited. After a release, run
 * it again and paste the output over the old comment — the numbers come from the
 * published assets, so the chart cannot drift from what people actually
 * installed, and there is no list of figures to keep by hand.
 *
 * ── Which size ──────────────────────────────────────────────────────────────
 * The headline number is the INSTALLED size: the extension folder on disk once
 * VS Code has unpacked it. That is the number issue #32 is about — its
 * "approximately 50MB" matches v0.3.4's 49.39 MB almost exactly — and it is
 * several times the download, because a .vsix is a zip. The download is kept in
 * the table beside it, since that is what the Marketplace shows.
 *
 * Working it out does NOT mean downloading every release. A .vsix is a zip, and
 * a zip's central directory sits at the END of the file and records the
 * uncompressed size of every entry. Two HTTP range requests of a few kilobytes
 * each are enough to read it, so the whole history costs a few hundred KB rather
 * than the ~600 MB the assets add up to.
 *
 * Only entries under `extension/` are counted. `[Content_Types].xml` and
 * `extension.vsixmanifest` are packaging metadata that VS Code does not write
 * into the installed folder.
 *
 * Usage:
 *   node scripts/size-history.js                 print the markdown
 *   node scripts/size-history.js --write FILE    write it to FILE instead
 *
 * Needs network access. Unauthenticated GitHub API calls are rate-limited to 60
 * an hour per IP, which is ample for a release-time script.
 */

'use strict';

const https = require('https');
const fs    = require('fs');

const REPO     = 'ashtonckj/Classic-ASP-Language-Support';
const API      = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
const MEGABYTE = 1024 * 1024;

// Zip record signatures.
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP64_LOCATOR            = 0x07064b50;
const ZIP64_END_OF_CD          = 0x06064b50;

function get(url, headers = {}) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'asp-size-history', ...headers } }, response => {
            if ([301, 302, 307, 308].includes(response.statusCode)) {
                response.resume();
                return resolve(get(response.headers.location, headers));
            }
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                body:   Buffer.concat(chunks),
            }));
        }).on('error', reject);
    });
}

/**
 * The installed size of a .vsix, read from its zip central directory.
 *
 * Returns the summed uncompressed size of everything under `extension/`.
 */
async function installedSize(url, totalBytes) {
    // The central directory ends within the last 64KB unless the archive has a
    // comment, which a .vsix does not. Take 128KB so the whole directory is
    // usually in hand already.
    const tailLength = Math.min(totalBytes, 128 * 1024);
    const tailStart  = totalBytes - tailLength;
    const tail = (await get(url, { Range: `bytes=${tailStart}-${totalBytes - 1}` })).body;

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) { eocd = i; break; }
    }
    if (eocd === -1) { throw new Error('no end-of-central-directory record'); }

    let size    = tail.readUInt32LE(eocd + 12);
    let offset  = tail.readUInt32LE(eocd + 16);
    let entries = tail.readUInt16LE(eocd + 10);

    // A saturated field means the real value lives in the ZIP64 record.
    if (offset === 0xffffffff || size === 0xffffffff || entries === 0xffff) {
        let locator = -1;
        for (let i = eocd - 20; i >= 0; i--) {
            if (tail.readUInt32LE(i) === ZIP64_LOCATOR) { locator = i; break; }
        }
        if (locator === -1) { throw new Error('ZIP64 sizes with no locator'); }

        const zip64Offset = Number(tail.readBigUInt64LE(locator + 8));
        const zip64 = (await get(url, { Range: `bytes=${zip64Offset}-${zip64Offset + 55}` })).body;
        if (zip64.readUInt32LE(0) !== ZIP64_END_OF_CD) { throw new Error('bad ZIP64 record'); }
        size   = Number(zip64.readBigUInt64LE(40));
        offset = Number(zip64.readBigUInt64LE(48));
    }

    const directory = (offset >= tailStart && offset + size <= totalBytes)
        ? tail.subarray(offset - tailStart, offset - tailStart + size)
        : (await get(url, { Range: `bytes=${offset}-${offset + size - 1}` })).body;

    let installed = 0;
    let files     = 0;
    let p         = 0;
    while (p + 46 <= directory.length && directory.readUInt32LE(p) === CENTRAL_DIRECTORY_HEADER) {
        const uncompressed = directory.readUInt32LE(p + 24);
        const nameLength   = directory.readUInt16LE(p + 28);
        const extraLength  = directory.readUInt16LE(p + 30);
        const commentLength = directory.readUInt16LE(p + 32);
        const name = directory.toString('utf8', p + 46, p + 46 + nameLength);

        if (name.startsWith('extension/') && !name.endsWith('/')) {
            installed += uncompressed;
            files++;
        }
        p += 46 + nameLength + extraLength + commentLength;
    }
    if (files === 0) { throw new Error('no entries under extension/'); }
    return { installed, files };
}

const mb  = bytes => bytes / MEGABYTE;
const fmt = bytes => mb(bytes).toFixed(2);

function render(rows) {
    const latest = rows[rows.length - 1];
    const peak   = rows.reduce((worst, row) => (row.installed > worst.installed ? row : worst), rows[0]);
    const cut    = (100 - (mb(latest.installed) / mb(peak.installed)) * 100).toFixed(1);
    const axisTop = Math.ceil(mb(peak.installed) / 10) * 10;

    const labels = rows.map(row => `"${row.tag.replace(/^v/, '')}"`).join(', ');
    const values = rows.map(row => fmt(row.installed)).join(', ');

    const table = rows.map((row, i) => {
        const previous = i === 0 ? null : rows[i - 1];
        const delta    = previous ? mb(row.installed) - mb(previous.installed) : 0;
        const change   = !previous ? '—'
            : Math.abs(delta) < 0.01 ? '±0.00'
            : `${delta > 0 ? '+' : ''}${delta.toFixed(2)}`;
        return `| \`${row.tag}\` | ${row.date} | **${fmt(row.installed)}** | ${change} | ${fmt(row.vsix)} | ${row.files} |`;
    }).join('\n');

    // `chartOrientation: horizontal` turns the category axis on its side, so the
    // version labels run down the left and read normally. Left as a vertical
    // chart they overlap each other once there are this many releases.
    return `## Installed size over time

Every published release. The figure is the **installed** size — the extension
folder once VS Code has unpacked it, which is what this issue is about — read
from each \`.vsix\`'s zip directory. Regenerated with
\`node scripts/size-history.js\`.

**Peak \`${peak.tag}\` ${fmt(peak.installed)} MB → current \`${latest.tag}\` ${fmt(latest.installed)} MB — down ${cut}%.**

\`\`\`mermaid
---
config:
    xyChart:
        chartOrientation: horizontal
        height: 900
        width: 760
---
xychart-beta
    title "Installed size by release (MB)"
    x-axis [${labels}]
    y-axis "Installed size (MB)" 0 --> ${axisTop}
    bar [${values}]
\`\`\`

<details>
<summary>The numbers behind the chart</summary>

| Release | Published | Installed (MB) | Change | Download (MB) | Files |
|---|---|---:|---:|---:|---:|
${table}

</details>

> **Installed** is the unpacked folder — the number in this issue's title.
> **Download** is the \`.vsix\`, which is a zip and so several times smaller; that
> is the figure the Marketplace shows. Both come from the published assets: the
> download size from the releases API, the installed size by reading each
> archive's central directory over a range request, so nothing has to be
> downloaded in full.
`;
}

(async () => {
    let releases;
    try {
        releases = JSON.parse((await get(API)).body);
    } catch (error) {
        console.error(`[asp] could not read the releases: ${error.message}`);
        process.exit(1);
    }

    const candidates = releases
        .map(release => {
            const asset = (release.assets ?? []).find(a => a.name.endsWith('.vsix'));
            return asset ? {
                tag:       release.tag_name,
                // Full timestamp for ordering, day for display: two releases can
                // share a date, and sorting on the truncated string left them in
                // the API's newest-first order — v0.2.5 before v0.2.4.
                published: release.published_at,
                date:      release.published_at.slice(0, 10),
                vsix:      asset.size,
                url:       asset.browser_download_url,
            } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.published.localeCompare(b.published));

    const rows = [];
    for (const row of candidates) {
        try {
            const { installed, files } = await installedSize(row.url, row.vsix);
            rows.push({ ...row, installed, files });
            process.stderr.write(`[asp] ${row.tag} ${fmt(installed)} MB installed\n`);
        } catch (error) {
            // One unreadable archive should not cost the whole chart.
            process.stderr.write(`[asp] ${row.tag} skipped — ${error.message}\n`);
        }
    }

    if (rows.length === 0) {
        console.error('[asp] no release could be measured — nothing to chart.');
        process.exit(1);
    }

    const markdown  = render(rows);
    const writeFlag = process.argv.indexOf('--write');

    if (writeFlag !== -1) {
        const target = process.argv[writeFlag + 1];
        if (!target) {
            console.error('[asp] --write needs a file path.');
            process.exit(1);
        }
        fs.writeFileSync(target, markdown, 'utf8');
        console.log(`[asp] wrote ${target} — ${rows.length} releases`);
    } else {
        process.stdout.write(markdown);
    }
})();
