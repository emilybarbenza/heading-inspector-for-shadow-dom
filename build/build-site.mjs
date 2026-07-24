#!/usr/bin/env node
/**
 * Assembles the static site that GitHub Pages serves: the landing page, the
 * live standalone demo (open shadow roots, runs the tool as page scripts), and
 * the drag-to-install bookmarklet page.
 *
 * Usage: node build/build-site.mjs
 * Output: dist/site/
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'site');

// Fresh output, and the bookmarklet build has to run first since we copy its page.
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
execFileSync(process.execPath, [join(root, 'build', 'build-bookmarklet.mjs')], { stdio: 'inherit' });

await cp(join(root, 'site', 'index.html'), join(out, 'index.html'));
await cp(join(root, 'dist', 'bookmarklet.html'), join(out, 'bookmarklet.html'));

// The demo references ../extension/walker.js and overlay.js, so keep the same
// relative layout the repo has.
await mkdir(join(out, 'demo'), { recursive: true });
await cp(join(root, 'demo', 'standalone.html'), join(out, 'demo', 'standalone.html'));
await mkdir(join(out, 'extension'), { recursive: true });
for (const f of ['walker.js', 'overlay.js']) {
  await cp(join(root, 'extension', f), join(out, 'extension', f));
}

console.log('dist/site ready: index.html, bookmarklet.html, demo/, extension/');
