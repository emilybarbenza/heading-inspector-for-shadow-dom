#!/usr/bin/env node
/**
 * Builds the two store upload packages from the one repo extension.
 *
 * The repo manifest is cross-browser (dual background keys plus a gecko id),
 * which real browsers handle fine, but store validators are pickier than
 * browsers. So each store gets a manifest with only its own keys:
 *   dist/chrome-store.zip   service_worker only, no browser_specific_settings
 *   dist/firefox-amo.zip    scripts only, keeps browser_specific_settings
 *
 * Usage: node build/build-store-zips.mjs
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, 'dist'), { recursive: true });

async function pack(name, patch) {
  const stage = join(tmpdir(), `hisd-pack-${name}`);
  await rm(stage, { recursive: true, force: true });
  await cp(join(root, 'extension'), stage, { recursive: true });
  const m = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
  patch(m);
  await writeFile(join(stage, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  const out = join(root, 'dist', `${name}.zip`);
  await rm(out, { force: true });
  execFileSync('zip', ['-qr', out, '.', '-x', '.*'], { cwd: stage });
  await rm(stage, { recursive: true, force: true });
  console.log(`dist/${name}.zip`);
}

await pack('chrome-store', (m) => {
  m.background = { service_worker: 'background.js' };
  delete m.browser_specific_settings;
});

await pack('firefox-amo', (m) => {
  m.background = { scripts: ['background.js'] };
});
