/** Minute-by-minute view of one match: is the net actually closing? */
import { runMatch } from '../test/harness.mjs';
import * as geo from '../js/engine/geo.js';

const seed = process.argv[2] || 'bal-3';
let last = 0;
let start = 0;
const rows = [];
const { state } = runMatch({
  seed, minutes: 30, players: 7, hunters: 2,
  onTick(s, now) {
    if (!start) start = now;
    if (now - last < 60000) return;
    last = now;
    const gs = Object.values(s.players).filter((p) => p.role === 'ghost' && p.lat != null);
    const hs = Object.values(s.players).filter((p) => p.role === 'hunter' && p.lat != null);
    let sum = 0; let min = Infinity;
    for (const h of hs) {
      let best = Infinity;
      for (const g of gs) best = Math.min(best, geo.distance(h, g));
      if (Number.isFinite(best)) { sum += best; min = Math.min(min, best); }
    }
    rows.push({
      min: Math.round((now - start) / 60000),
      phase: s.phase,
      zone: Math.round(s.zone.sizeM),
      ghosts: gs.length,
      hunters: hs.length,
      meanNearestM: hs.length ? Math.round(sum / hs.length) : null,
      closestM: Number.isFinite(min) ? Math.round(min) : null,
      pulses: s.pulse.count,
    });
  },
});
console.table(rows);
console.log('outcome', state.outcome);
