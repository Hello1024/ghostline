/**
 * The display layer's sharp edges.
 *
 * Player names arrive from other people's devices and end up inside
 * innerHTML, so escaping is a real boundary rather than a nicety, and it is
 * the kind of thing that quietly regresses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHud, renderScoreboard, escapeHtml, mmss } from '../js/ui/hud.js';
import { cleanName } from '../js/net/protocol.js';

/** Just enough of an element for the renderers to write into. */
const stub = () => ({
  innerHTML: '', textContent: '', hidden: false, className: '', dataset: {},
  style: {}, classList: { toggle() {}, add() {}, remove() {} },
  addEventListener() {},
});

test('mmss formats and floors at zero', () => {
  assert.equal(mmss(0), '0:00');
  assert.equal(mmss(-5000), '0:00');
  assert.equal(mmss(65_000), '1:05');
  assert.equal(mmss(1_800_000), '30:00');
  assert.equal(mmss(3_599_000), '59:59');
});

test('escapeHtml neutralises every dangerous character', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml(`"'&<>`), '&quot;&#39;&amp;&lt;&gt;');
  assert.equal(escapeHtml('plain'), 'plain');
});

test('the scoreboard escapes names it was handed', () => {
  const table = stub();
  renderScoreboard(table, [
    { id: 'a', name: '<script>bad()</script>', role: 'ghost', score: 10, catches: 0, caches: 1, distanceM: 1234, darkS: 3, jumps: 1 },
    { id: 'b', name: 'Ana', role: 'hunter', score: 5, catches: 2, caches: 0, distanceM: 900, darkS: 0, jumps: 0 },
  ], {});
  assert.ok(!table.innerHTML.includes('<script>'), 'a script tag reached the page');
  assert.ok(table.innerHTML.includes('&lt;script&gt;'));
  assert.ok(table.innerHTML.includes('Ana'));
  assert.ok(table.innerHTML.includes('1.23km'), 'distance not shown in km');
  assert.ok(table.innerHTML.includes('⚑1'), 'a flagged player is not marked');
});

test('the event feed escapes names before writing them into the page', () => {
  const els = Object.fromEntries(
    ['phase', 'clock', 'pulse', 'chargeFill', 'chargeLabel', 'items', 'alert', 'feed'].map((k) => [k, stub()]),
  );
  const hud = createHud(els, { onUseItem() {} });
  const view = {
    players: [{ id: 'x', name: '<b>oops</b>' }, { id: 'y', name: 'Ben' }],
  };
  const line = hud.describe({ type: 'caught', who: 'x', by: 'y' }, view);
  assert.ok(!line.includes('<b>'), `unescaped name in the feed: ${line}`);
  assert.ok(line.includes('&lt;b&gt;oops&lt;/b&gt;'));
  assert.ok(line.includes('Ben'));
});

test('a name that is nothing but markup still leaves something readable', () => {
  // The wire layer trims and strips control characters; the display layer
  // escapes. Between them a hostile name is inert but still shows as text.
  const hostile = cleanName('<img src=x onerror=alert(1)>');
  assert.ok(hostile.length <= 16);
  const rendered = escapeHtml(hostile);
  assert.ok(!rendered.includes('<'), `markup survived: ${rendered}`);
});

test('the HUD renders a whole view without touching a real DOM', () => {
  const els = Object.fromEntries(
    ['phase', 'clock', 'pulse', 'chargeFill', 'chargeLabel', 'items', 'alert', 'feed'].map((k) => [k, stub()]),
  );
  const hud = createHud(els, { onUseItem() {} });
  const now = 1_700_000_000_000;
  const view = {
    t: now, phase: 'hunt', endsAt: now + 600_000,
    pulse: { nextAt: now + 30_000, lastAt: now - 10_000, count: 3 },
    config: { chargeMax: 200, inventorySize: 3, oobGraceS: 20 },
    proximity: { level: 'none' }, bearing: null,
    me: {
      id: 'me', role: 'ghost', charge: 120, items: ['cloak', 'decoy'], fx: { cloak: 0, lockout: 0 },
      distanceM: 2400, dark: { active: false, flaggedUntil: 0, totalMs: 0 }, outsideM: 0, oobSince: 0,
      convertAt: 0,
    },
    players: [{ id: 'me', name: 'Me' }],
    feed: [{ id: 1, type: 'pulse', n: 3 }],
  };
  assert.doesNotThrow(() => hud.render(view, now));
  assert.equal(els.clock.textContent, '10:00');
  assert.equal(els.pulse.textContent, 'pulse 0:30');
  assert.ok(els.chargeFill.style.width === '60%', els.chargeFill.style.width);
  assert.ok(els.items.innerHTML.includes('Cloak'));
  assert.ok(els.items.innerHTML.includes('empty'), 'the third slot is not shown as empty');
});
