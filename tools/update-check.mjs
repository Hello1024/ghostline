/**
 * Does a deploy actually reach a browser that already has the app installed?
 *
 * This is the failure that produced "Peer is not defined": the service worker
 * served files from its cache indefinitely, so an updated page loaded against
 * stale modules. A fresh browser was fine, which is why every other test
 * passed. So the test has to install the app first, change the site underneath
 * it, and check what the browser sees on the next load.
 *
 *   node tools/update-check.mjs
 */
import { spawn } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8171;

let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.error('puppeteer-core is not installed — skipping the update check.');
  process.exit(0);
}

const problems = [];
const log = (...a) => console.log(' ', ...a);

// A throwaway copy of the site, so the deploy can be simulated by editing it.
const site = mkdtempSync(join(tmpdir(), 'ghostline-site-'));
for (const entry of ['index.html', 'sw.js', 'app.webmanifest', 'css', 'js', 'icons', 'vendor']) {
  cpSync(join(ROOT, entry), join(site, entry), { recursive: true });
}

const server = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs')], {
  cwd: site,
  env: { ...process.env, PORT: String(PORT), SERVE_ROOT: site },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 700));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  log('installing the app');
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Reload so the worker is actually in control of the page.
  await page.reload({ waitUntil: 'networkidle2' });
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  log(`service worker controlling the page: ${controlled}`);
  if (!controlled) problems.push('the service worker never took control, so this proves nothing');

  log('shipping a new version underneath it');
  const marker = `DEPLOYED_${Date.now()}`;
  for (const file of ['js/main.js', 'js/engine/constants.js', 'css/app.css']) {
    const path = join(site, file);
    writeFileSync(path, `/* ${marker} */\n${readFileSync(path, 'utf8')}`);
  }
  const html = join(site, 'index.html');
  writeFileSync(html, readFileSync(html, 'utf8').replace('<title>Ghostline</title>', `<title>Ghostline ${marker}</title>`));

  // Exactly one reload. Reloading twice lets a lazy background refresh catch
  // up and hides the bug; a player reloads once, sees a broken app, and stops.
  log('reloading once, as a player would');
  await page.reload({ waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 800));

  const seen = await page.evaluate(async (mark) => {
    // Fetched the way the page loads them, so this sees what the service
    // worker actually serves.
    const read = async (u) => {
      try { return (await (await fetch(u)).text()).includes(mark); }
      catch { return false; }
    };
    return {
      title: document.title,
      main: await read('./js/main.js'),
      constants: await read('./js/engine/constants.js'),
      css: await read('./css/app.css'),
      controlled: !!navigator.serviceWorker.controller,
    };
  }, marker);

  log(`title now: ${seen.title}`);
  log(`fresh main.js: ${seen.main}  constants.js: ${seen.constants}  app.css: ${seen.css}`);
  if (!seen.title.includes(marker)) problems.push('the browser is still showing the old index.html');
  // The dangerous state is not "old" but "mixed": new page, stale modules.
  const fresh = [seen.title.includes(marker), seen.main, seen.constants, seen.css];
  if (fresh.some(Boolean) && !fresh.every(Boolean)) {
    problems.push('the browser is running a MIX of old and new files — this is what breaks the app');
  }
  for (const [name, ok] of [['js/main.js', seen.main], ['js/engine/constants.js', seen.constants], ['css/app.css', seen.css]]) {
    if (!ok) problems.push(`${name} is still being served from a stale cache`);
  }
  if (!seen.controlled) problems.push('the service worker stopped controlling the page');
  if (errors.length) problems.push(`console errors after the update: ${errors.slice(0, 2).join(' | ')}`);

  log('shipping a deploy that changes the worker itself, as a real one does');
  const marker2 = `SW_DEPLOY_${Date.now()}`;
  const swPath = join(site, 'sw.js');
  writeFileSync(swPath, `/* ${marker2} */\n${readFileSync(swPath, 'utf8')}`);
  writeFileSync(join(site, 'js/main.js'), `/* ${marker2} */\n${readFileSync(join(site, 'js/main.js'), 'utf8')}`);
  writeFileSync(html, readFileSync(html, 'utf8').replace(/<title>[^<]*<\/title>/, `<title>Ghostline ${marker2}</title>`));

  await page.reload({ waitUntil: 'networkidle2' });
  // The new worker installs, claims the page, and the page reloads itself.
  await new Promise((r) => setTimeout(r, 3000));
  const after = await page.evaluate(async (mark) => ({
    title: document.title,
    main: (await (await fetch('./js/main.js')).text()).includes(mark),
    controlled: !!navigator.serviceWorker.controller,
  }), marker2);
  log(`after a worker-changing deploy: title "${after.title}", fresh main.js: ${after.main}`);
  if (!after.title.includes(marker2) || !after.main) {
    problems.push('a deploy that changes the service worker did not reach the page');
  }
  if (!after.controlled) problems.push('no worker in control after the update');

  // And it must still work offline, which is the whole reason for the cache.
  log('checking it still opens with the network gone');
  await page.setOfflineMode(true);
  const offline = await page.reload({ waitUntil: 'domcontentloaded' }).then(() => true).catch(() => false);
  const offlineTitle = offline ? await page.title() : null;
  log(`offline load: ${offline ? `ok — "${offlineTitle}"` : 'failed'}`);
  if (!offline) problems.push('the app no longer opens offline');
  await page.setOfflineMode(false);
} catch (err) {
  problems.push(`threw: ${err.message}`);
} finally {
  await browser.close();
  server.kill();
  rmSync(site, { recursive: true, force: true });
}

if (problems.length) {
  console.error('\nUPDATE CHECK FAILED');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('\nupdate check passed — a deploy reaches an installed app');
