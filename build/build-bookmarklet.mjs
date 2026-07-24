#!/usr/bin/env node
/**
 * Builds a bookmarklet from the same walker + annotator source.
 *
 * Why this exists: extension installs are blocked by policy in a lot of
 * government and finance environments, which is often where you need to hand a
 * heading tool to someone else's dev team. The bookmarklet runs in the page's
 * own world, so chrome.dom isn't available and closed shadow roots are NOT
 * traversed. The overlay says so in the chip instead of quietly under-reporting.
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

// The two files are self-contained IIFEs that publish onto window. Wrapping and
// minifying keeps those side effects and strips the ~40% of the source that's
// comments and whitespace. Without it the bookmarklet is well past the ~64KB
// some browsers truncate.
const wrapped = `(function(){${parts.join('\n;\n')}})();`;
const { code } = await transform(wrapped, {
  minify: true,
  legalComments: 'none',
  target: 'es2020',
});

// The overlay's CSS lives in template literals, which esbuild can't see into,
// so its comments survive minification and ship inside a URL that has a size
// ceiling — a couple of KB of prose nobody will ever read. Every /* */ left in
// the minified bundle is necessarily inside one of those style strings, because
// esbuild has already removed the real JS comments. Parsing the result guards
// the assumption: if a future string literal ever contains /* */ and this strip
// mangles it, the build fails here instead of shipping a broken bookmarklet.
const lean = code.replace(/\/\*[\s\S]*?\*\//g, '');
try {
  // eslint-disable-next-line no-new-func -- parse check only; never executed.
  new Function(lean);
} catch (err) {
  console.error('ERROR: stripping CSS comments corrupted the bundle:', err.message);
  process.exit(1);
}

const bookmarklet = `javascript:${encodeURIComponent(lean)}`;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'bookmarklet.txt'), bookmarklet, 'utf8');

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Heading Inspector for Shadow DOM (bookmarklet)</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1rem; }
  a.bm { display: inline-block; padding: .5rem .9rem; border: 2px solid currentColor; border-radius: 4px; font-weight: 700; text-decoration: none; }
  code { background: #eef1f4; padding: .1em .3em; border-radius: 3px; }
</style>
</head>
<body>
<h1>Heading Inspector for Shadow DOM</h1>
<p>Drag this link to your bookmarks bar, then click it on any page to toggle heading outlines.</p>
<p><a class="bm" href="${bookmarklet.replace(/"/g, '&quot;')}">Heading outlines</a></p>
<h2>Limitations of the bookmarklet</h2>
<p>The bookmarklet runs in the page's own JavaScript world, so it can only reach
<strong>open</strong> shadow roots. Headings inside closed shadow roots are not found, and
the chip says <code>open roots only</code> when that is the case. Use the extension
when you need closed roots.</p>
<h2>Keys</h2>
<p><code>esc</code> hide the panel; again to close the tool &middot;
<code>alt+shift+p</code> hide or show the panel &middot;
<code>alt+shift+m</code> cycle label detail &middot;
<code>alt+shift+c</code> copy the outline as text &middot; <code>alt+click</code> a box to copy
that heading's selector chain.</p>
</body>
</html>
`;

await writeFile(join(outDir, 'bookmarklet.html'), page, 'utf8');

console.log(`dist/bookmarklet.txt   ${bookmarklet.length} chars`);
console.log('dist/bookmarklet.html  drag-to-install page');
// Fail, don't warn. CI runs this build, and a console.warn leaves the exit code
// at 0 — so a source file growing past the limit would ship a truncated,
// syntactically broken bookmarklet to GitHub Pages through a green pipeline.
if (bookmarklet.length > 60000) {
  console.error(
    `ERROR: bookmarklet is ${bookmarklet.length} chars; some browsers truncate past ~64KB.`
  );
  process.exitCode = 1;
}
