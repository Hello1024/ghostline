/**
 * The parts of a PWA that break silently.
 *
 * A precache list that names a file which no longer exists, a script tag
 * pointing at a moved module, a manifest missing an icon — none of these throw
 * anywhere a developer will see. They just produce an app that will not
 * install, or worse, installs and then cannot start.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('every file the service worker precaches exists', () => {
  const sw = read('sw.js');
  const list = sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1];
  const paths = [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((p) => p !== './');
  assert.ok(paths.length > 20, `only ${paths.length} entries precached`);
  for (const p of paths) {
    assert.ok(existsSync(join(ROOT, p)), `precached but missing: ${p}`);
  }
});

test('every local module the app imports is precached', () => {
  const sw = read('sw.js');
  const precached = new Set([...sw.matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]));
  const walk = (dir) => readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
  const modules = walk('js').filter((f) => f.endsWith('.js'));
  const missing = modules.filter((m) => !precached.has(m));
  assert.deepEqual(missing, [], `these ship but are not precached: ${missing.join(', ')}`);
});

test('every path index.html references resolves', () => {
  const html = read('index.html');
  const refs = [
    ...[...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]),
  ].filter((h) => !/^(https?:|data:|#|mailto:)/.test(h));
  assert.ok(refs.length > 5);
  for (const ref of refs) {
    assert.ok(existsSync(join(ROOT, ref)), `index.html points at a missing file: ${ref}`);
  }
});

test('every module import resolves on disk', () => {
  const walk = (dir) => readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
  for (const file of walk('js')) {
    if (!file.endsWith('.js')) continue;
    const src = read(file);
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = resolve(ROOT, dirname(file), spec);
      assert.ok(existsSync(target), `${file} imports ${spec}, which does not exist`);
    }
  }
});

test('the manifest is valid and its icons are real', () => {
  const manifest = JSON.parse(read('app.webmanifest'));
  assert.ok(manifest.name && manifest.short_name);
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.start_url);
  assert.ok(manifest.icons.length >= 3);
  for (const icon of manifest.icons) {
    assert.ok(existsSync(join(ROOT, icon.src)), `manifest icon missing: ${icon.src}`);
  }
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'no maskable icon');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
});

test('the generated icons really are PNGs of the right size', () => {
  for (const [file, size] of [['icons/icon-192.png', 192], ['icons/icon-512.png', 512], ['icons/icon-maskable-512.png', 512]]) {
    const buf = readFileSync(join(ROOT, file));
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`);
    assert.equal(buf.readUInt32BE(16), size, `${file} width`);
    assert.equal(buf.readUInt32BE(20), size, `${file} height`);
  }
});

test('GitHub Pages will not run the site through Jekyll', () => {
  assert.ok(existsSync(join(ROOT, '.nojekyll')), 'missing .nojekyll: paths starting with _ would be dropped');
});

test('nothing is loaded from a CDN at runtime', () => {
  // Vendored on purpose: the game has to work on a bad signal in a side street,
  // and a third-party script tag is a dependency you cannot cache or trust.
  const html = read('index.html');
  const external = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(external, [], `index.html loads from the network: ${external.join(', ')}`);
});

test('the service worker leaves peer traffic and signalling alone', () => {
  const sw = read('sw.js');
  assert.match(sw, /url\.origin !== self\.location\.origin/, 'cross-origin requests are not excluded from caching');
});
