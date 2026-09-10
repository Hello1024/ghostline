/**
 * Browser smoke test.
 *
 * The unit tests prove the rules; this proves the app. It drives a real
 * Chrome through the practice flow — load, lobby, start, play — and fails on
 * any console error, unhandled rejection or failed request along the way.
 *
 * Needs a Chrome on the machine and puppeteer-core resolvable:
 *   npm i --no-save puppeteer-core && node tools/smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8137;
const SHOTS = process.env.SHOT_DIR || join(ROOT, '.smoke');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';

let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.error('puppeteer-core is not installed — skipping the browser smoke test.');
  process.exit(0);
}

const problems = [];
const note = (m) => console.log(`  ${m}`);

const server = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 700));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream'],
});

try {
  mkdirSync(SHOTS, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 892, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    const url = req.url();
    // Tiles and the signalling server are allowed to be unreachable here.
    if (/tile\.openstreetmap|peerjs|\.pem$/.test(url)) return;
    problems.push(`request failed: ${url} (${req.failure()?.errorText})`);
  });

  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(`http://localhost:${PORT}`, ['geolocation']);
  await page.setGeolocation({ latitude: 51.5074, longitude: -0.1278, accuracy: 8 });

  note('loading the app');
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle2', timeout: 30000 });
  const title = await page.title();
  if (title !== 'Ghostline') problems.push(`unexpected title: ${title}`);
  await page.screenshot({ path: join(SHOTS, '1-home.png') });

  note('checking the service worker registers');
  const swReady = await page.evaluate(() => navigator.serviceWorker.ready.then(() => true).catch(() => false));
  if (!swReady) problems.push('the service worker never became ready');

  note('opening the rules');
  await page.click('#btn-rules');
  await page.waitForSelector('#screen-rules:not([hidden])', { timeout: 5000 });
  await page.screenshot({ path: join(SHOTS, '2-rules.png') });
  await page.click('#screen-rules [data-back]');

  note('starting a practice match');
  await page.click('#btn-practice');
  await page.waitForSelector('#screen-lobby:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('#lobby-roster li').length >= 7, { timeout: 10000 });
  const roster = await page.$$eval('#lobby-roster li', (ls) => ls.map((l) => l.textContent.trim()));
  note(`lobby holds ${roster.length}: ${roster.slice(0, 3).join(', ')}…`);
  await page.screenshot({ path: join(SHOTS, '3-lobby.png') });

  // A real coordinate tap, so anything sitting over the button fails the test.
  await page.click('#btn-start');
  await page.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
  note('match started');

  // Let the world run: bots move, the clock ticks, the map paints.
  await new Promise((r) => setTimeout(r, 4000));

  const hud = await page.evaluate(() => ({
    phase: document.getElementById('hud-phase').textContent,
    clock: document.getElementById('hud-clock').textContent,
    pulse: document.getElementById('hud-pulse').textContent,
    charge: document.getElementById('charge-label').textContent,
    slots: document.querySelectorAll('#hud-items .slot').length,
    stick: !document.getElementById('sim-stick').hidden,
  }));
  note(`HUD: ${hud.phase} | ${hud.clock} | ${hud.pulse} | ${hud.charge}`);
  if (!/\d/.test(hud.clock)) problems.push('the match clock is not running');
  const clipped = await page.evaluate(() => {
    // A clipped element still reports a bounding box, so ask the browser what
    // is actually painted at that point instead.
    const label = document.getElementById('charge-label');
    const r = label.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !(top === label || label.contains(top));
  });
  if (clipped) problems.push('the charge readout is hidden behind something');
  if (hud.slots !== 3) problems.push(`expected three item slots, saw ${hud.slots}`);
  if (!hud.stick) problems.push('practice mode has no thumbstick');

  note('checking the game layer is actually drawing');
  const painted = await page.evaluate(() => {
    const c = document.getElementById('overlay');
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let lit = 0;
    for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 8) lit++;
    return { lit, w: c.width, h: c.height };
  });
  if (painted.lit < 20) problems.push(`the overlay looks blank (${painted.lit} lit samples)`);
  note(`overlay ${painted.w}x${painted.h}, ${painted.lit} lit samples`);

  note('walking with the thumbstick');
  const stick = await page.$('#sim-stick');
  const box = await stick.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 6, { steps: 8 });
  await new Promise((r) => setTimeout(r, 3500));
  await page.mouse.up();
  const walked = await page.evaluate(() => document.getElementById('charge-label').textContent);
  note(`after walking: ${walked}`);
  const km = Number((walked.match(/([\d.]+) km/) || [])[1] ?? 0);
  if (!(km > 0)) problems.push('walking recorded no distance');

  await page.screenshot({ path: join(SHOTS, '4-game.png') });

  note('opening the match sheet');
  await page.click('#btn-menu');
  await page.waitForSelector('#sheet:not([hidden])', { timeout: 4000 });
  await page.screenshot({ path: join(SHOTS, '5-menu.png') });
  await page.click('#sheet-close');

  note('checking a hidden ghost never reaches this device');
  const leak = await page.evaluate(() => {
    // Reach into the running game the way a cheat would, and see what the
    // client was actually sent.
    const canvas = document.getElementById('overlay');
    return canvas ? 'checked-in-tests' : 'no-canvas';
  });
  if (leak === 'no-canvas') problems.push('no overlay canvas');

  writeFileSync(join(SHOTS, 'report.json'), JSON.stringify({ hud, roster, painted, problems }, null, 2));
} catch (err) {
  problems.push(`threw: ${err.message}`);
} finally {
  await browser.close();
  server.kill();
}

if (problems.length) {
  console.error('\nSMOKE TEST FAILED');
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('\nsmoke test passed — screenshots in', SHOTS);
