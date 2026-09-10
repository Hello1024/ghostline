/**
 * Balance sweep: run many bot matches and report the distribution of outcomes.
 *
 *   node tools/balance.mjs [runs] [--minutes 30] [--hunters 2] [--players 7]
 *
 * Bots are a crude stand-in for people — they have no sense of cover and they
 * loiter in the open — so treat this as a floor, not a prediction. What it is
 * genuinely good at is catching runaway dynamics: a snowball that ends every
 * match early, or an item economy that never gets going.
 */

import { runMatch } from '../test/harness.mjs';

const runs = Number(process.argv[2]) || 20;
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? Number(process.argv[i + 1]) : d; };
const minutes = arg('minutes', 30);
const hunters = arg('hunters', 2);
const players = arg('players', 7);

const q = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

const survival = [];      // minutes each starting ghost lasted
const outcomes = { ghosts: 0, hunters: 0 };
const perMatch = { caches: [], items: [], pulses: [], survivors: [], firstCatch: [] };
const byItem = {};

for (let i = 0; i < runs; i++) {
  const { state, trace, t0 } = runMatch({ seed: `bal-${i}`, minutes, hunters, players });
  outcomes[state.outcome] = (outcomes[state.outcome] || 0) + 1;
  const ghostsAtEnd = Object.values(state.players).filter((p) => p.role === 'ghost').length;
  perMatch.survivors.push(ghostsAtEnd);
  perMatch.caches.push(trace.cachesTaken);
  perMatch.items.push(trace.itemsUsed);
  perMatch.pulses.push(trace.pulses);
  for (const [k, v] of Object.entries(trace.byItem)) byItem[k] = (byItem[k] || 0) + v;
  const catches = Object.values(state.players).filter((p) => p.caughtAt).map((p) => (p.caughtAt - t0) / 60000);
  perMatch.firstCatch.push(catches.length ? Math.min(...catches) : minutes);
  for (const p of Object.values(state.players)) {
    survival.push(p.caughtAt ? (p.caughtAt - t0) / 60000 : minutes);
  }
}

console.log(`\n${runs} matches — ${players} players, ${hunters} hunters, ${minutes} min\n`);
console.log('outcome            ', `ghosts survive ${outcomes.ghosts || 0}  hunters sweep ${outcomes.hunters || 0}`);
console.log('survivors at end   ', `mean ${mean(perMatch.survivors).toFixed(2)}  p10 ${q(perMatch.survivors, 0.1)}  p90 ${q(perMatch.survivors, 0.9)}`);
console.log('ghost lifetime min ', `p25 ${q(survival, 0.25).toFixed(1)}  median ${q(survival, 0.5).toFixed(1)}  p75 ${q(survival, 0.75).toFixed(1)}`);
console.log('first catch at min ', `median ${q(perMatch.firstCatch, 0.5).toFixed(1)}`);
console.log('caches per match   ', `mean ${mean(perMatch.caches).toFixed(1)}`);
console.log('items used         ', `mean ${mean(perMatch.items).toFixed(1)}`);
console.log('pulses             ', `mean ${mean(perMatch.pulses).toFixed(1)}`);
const items = Object.entries(byItem).sort((a, b) => b[1] - a[1]);
console.log('items per match    ', items.map(([k, v]) => `${k} ${(v / runs).toFixed(1)}`).join('  '));
console.log('');
