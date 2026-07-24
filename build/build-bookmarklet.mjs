#!/usr/bin/env node
/**
 * Builds a bookmarklet from the same walker + annotator source.
 *
 * Why this target exists: extension installs are blocked by policy in many
 * government and finance environments, which is exactly where you most need to
 * hand a heading tool to somebody else's dev team. The bookmarklet runs in the
 * page's own world, so chrome.dom is unavailable and closed shadow roots are
 * NOT traversed. The overlay labels that degradation in the chip rather than
 * silently under-reporting.
 *
 * Usage: node build/build-bookmarklet.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist');

const sources = ['extension/walker.js', 'extension/overlay.js'];
const parts = [];
for (const rel of sources) {
  parts.push(await readFile(join(root, rel), 'utf8'));
}

// The two files are self-contained IIFEs that publish onto window; wrapping and
// minifying preserves those side effects while stripping the ~40% of the source
// that is comments and whitespace. Without this the bookmarklet is well past the
// ~64KB some browsers truncate.
const wrapped = `(function(){${parts.join('\n;\n')}})();`;
const { code } = await transform(wrapped, {
  minify: true,
  legalComments: 'none',
  target: 'es2020',
});
const bookmarklet = `javascript:${encodeURIComponent(code)}`;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'bookmarklet.txt'), bookmarklet, 'utf8');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shadow Heading Outliner bookmarklet</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1rem; }
  a.bm { display: inline-block; padding: .5rem .9rem; border: 2px solid currentColor; border-radius: 4px; font-weight: 700; text-decoration: none; }
  code { background: #eef1f4; padding: .1em .3em; border-radius: 3px; }
</style>
</head>
<body>
<h1>Shadow Heading Outliner</h1>
<p>Drag this link to your bookmarks bar, then click it on any page to toggle heading outlines.</p>
<p><a class="bm" href="${bookmarklet.replace(/"/g, '&quot;')}">Heading outlines</a></p>
<h2>Limitations of the bookmarklet</h2>
<p>The bookmarklet runs in the page's own JavaScript world, so it can only reach
<strong>open</strong> shadow roots. Headings inside closed shadow roots are not found, and
the chip says <code>open roots only</code> when that is the case. Use the extension
when you need closed roots.</p>
<h2>Keys</h2>
<p><code>esc</code> close &middot; <code>alt+shift+m</code> cycle label detail &middot;
<code>alt+shift+c</code> copy the outline as text &middot; <code>alt+click</code> a box to copy
that heading's selector chain.</p>
</body>
</html>
`;

await writeFile(join(outDir, 'bookmarklet.html'), page, 'utf8');

console.log(`dist/bookmarklet.txt   ${bookmarklet.length} chars`);
console.log('dist/bookmarklet.html  drag-to-install page');
if (bookmarklet.length > 60000) {
  console.warn('WARNING: some browsers truncate bookmarklets past ~64KB.');
}
