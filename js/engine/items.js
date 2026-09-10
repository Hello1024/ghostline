/**
 * Power-ups.
 *
 * Items are found in caches, held in a small inventory, and cost `charge` to
 * play — and charge is only earned by physically walking. So an ability is
 * two resources deep: you had to find it, and you had to have covered ground.
 * That is what stops a player parking on a bench with a full loadout.
 *
 * Each item's `apply` receives a context and mutates game state. Keeping the
 * effects here (rather than in a switch inside the engine) means adding an
 * item is a local change.
 */

import { ROLE } from './constants.js';
import * as geo from './geo.js';

/** @typedef {{state:any, player:any, rng:any, now:number, params:any, log:Function, addReveal:Function}} ItemCtx */

const S = 1000;

export const ITEMS = Object.freeze({
  // ---------------------------------------------------------------- ghost --
  cloak: {
    id: 'cloak', name: 'Cloak', glyph: '🫥', role: ROLE.GHOST, cost: 60, loot: 10,
    blurb: 'Vanish from the pulse, sonar and proximity for 90s. Drones still see you.',
    apply: ({ player, now }) => { player.fx.cloak = now + 90 * S; },
  },
  decoy: {
    id: 'decoy', name: 'Decoy', glyph: '👻', role: ROLE.GHOST, cost: 45, loot: 12,
    blurb: 'Leave a phantom that drifts and shows up in the next two pulses.',
    apply: ({ state, player, rng, now }) => {
      state.decoys.push({
        id: `dc${state.nextId++}`, by: player.id,
        lat: player.lat, lon: player.lon,
        drift: rng() * 360, until: now + 300 * S,
      });
    },
  },
  static: {
    id: 'static', name: 'Static', glyph: '📶', role: ROLE.GHOST, cost: 35, loot: 12,
    blurb: 'Smear your signal: your next pulse blob is three times wider.',
    apply: ({ player, now }) => { player.fx.static = now + 300 * S; },
  },
  scout: {
    id: 'scout', name: 'Scout', glyph: '🔭', role: ROLE.GHOST, cost: 50, loot: 10,
    blurb: 'See every hunter live for 20s.',
    apply: ({ state, player, now, addReveal }) => {
      player.fx.scout = now + 20 * S;
      for (const p of Object.values(state.players)) {
        if (p.role !== ROLE.HUNTER) continue;
        addReveal({ kind: 'scout', target: p.id, audience: player.id, blur: 0, live: true, until: now + 20 * S });
      }
    },
  },
  blink: {
    id: 'blink', name: 'Blink', glyph: '✨', role: ROLE.GHOST, cost: 25, loot: 9,
    // The one item that works while you are locked out — clearing a lockout is
    // its whole job, so the lockout must not be able to block it.
    ignoresLockout: true,
    blurb: 'Shed a blackout beacon or a ghost flag instantly, and take 40 charge.',
    apply: ({ state, player, now }) => {
      player.dark.flaggedUntil = 0;
      player.fx.lockout = 0;
      player.charge = Math.min(state.config.chargeMax, player.charge + 40);
      for (const r of state.reveals) {
        if (r.target === player.id && (r.kind === 'dark' || r.kind === 'flag')) r.until = now;
      }
    },
  },

  // --------------------------------------------------------------- hunter --
  sonar: {
    id: 'sonar', name: 'Sonar', glyph: '📡', role: ROLE.HUNTER, cost: 55, loot: 12,
    blurb: 'Snapshot every ghost within 400m, tight to 25m.',
    apply: ({ state, player, now, addReveal, log }) => {
      let hits = 0;
      for (const p of Object.values(state.players)) {
        if (p.role !== ROLE.GHOST || !p.lat) continue;
        if (p.fx.cloak > now) continue;
        if (geo.distance(player, p) > 400) continue;
        hits++;
        addReveal({ kind: 'sonar', target: p.id, audience: ROLE.HUNTER, blur: 25, live: false, until: now + 12 * S });
      }
      log({ type: 'sonar', by: player.id, hits });
    },
  },
  bloodhound: {
    id: 'bloodhound', name: 'Bloodhound', glyph: '🐕', role: ROLE.HUNTER, cost: 60, loot: 10,
    blurb: 'A bearing to the nearest ghost for 60s. Direction only — no distance.',
    apply: ({ player, now }) => { player.fx.bloodhound = now + 60 * S; },
  },
  dragnet: {
    id: 'dragnet', name: 'Dragnet', glyph: '🕸️', role: ROLE.HUNTER, cost: 60, loot: 14,
    blurb: 'For 45s your catch radius more than doubles and ghosts within 100m light up.',
    apply: ({ player, now }) => { player.fx.dragnet = now + 45 * S; },
  },
  drone: {
    id: 'drone', name: 'Drone', glyph: '🛸', role: ROLE.HUNTER, cost: 55, loot: 11,
    blurb: 'Park an eye anywhere within 600m: a live 150m circle for 45s. Beats cloak.',
    apply: ({ state, player, now, params, log }) => {
      let at = params && Number.isFinite(params.lat) ? { lat: params.lat, lon: params.lon } : { lat: player.lat, lon: player.lon };
      const d = geo.distance(player, at);
      if (d > 600) at = geo.destination(player, geo.bearing(player, at), 600);
      state.drones.push({ id: `dr${state.nextId++}`, by: player.id, lat: at.lat, lon: at.lon, radius: 150, until: now + 45 * S });
      log({ type: 'drone', by: player.id });
    },
  },

  // ----------------------------------------------------------------- both --
  trap: {
    id: 'trap', name: 'Tripwire', glyph: '🪤', role: 'any', cost: 40, loot: 12,
    blurb: 'Arms after 20s. Hunters snare ghosts (reveal); ghosts fry hunters (no abilities).',
    apply: ({ state, player, now }) => {
      state.traps.push({
        id: `tp${state.nextId++}`, by: player.id, role: player.role,
        lat: player.lat, lon: player.lon,
        armedAt: now + 20 * S, until: now + 15 * 60 * S, triggered: false,
      });
    },
  },
  overcharge: {
    id: 'overcharge', name: 'Overcharge', glyph: '🔋', role: 'any', cost: 0, loot: 14,
    blurb: 'Instant +100 charge.',
    apply: ({ state, player }) => {
      player.charge = Math.min(state.config.chargeMax, player.charge + 100);
    },
  },
});

export const ITEM_IDS = Object.freeze(Object.keys(ITEMS));

/** Items a given role is allowed to hold, with their loot weights. */
export function lootTable(role) {
  return ITEM_IDS
    .filter((id) => ITEMS[id].role === role || ITEMS[id].role === 'any')
    .map((id) => [id, ITEMS[id].loot]);
}

/** Draw one item for a role from the weighted loot table. */
export function rollLoot(role, rng) {
  const table = lootTable(role);
  return table.length ? rng.weighted(table) : null;
}

export function canHold(role, itemId) {
  const item = ITEMS[itemId];
  return !!item && (item.role === role || item.role === 'any');
}
