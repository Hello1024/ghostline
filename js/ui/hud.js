/**
 * The heads-up display.
 *
 * Everything here is derived from the fog-of-war view, so the screen can never
 * show more than the player is entitled to know. The job is to make three
 * things unmissable while walking: how long is left, when the next pulse
 * lands, and whether you are about to be punished for something.
 */

import { ITEMS } from '../engine/items.js';
import { PHASE } from '../engine/constants.js';

const PHASE_LABEL = {
  lobby: 'Lobby',
  scatter: 'HEAD START',
  hunt: 'HUNT',
  collapse: 'CLOSING IN',
  over: 'Over',
};

export function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createHud(els, { onUseItem }) {
  let lastFeedId = -1;

  els.items.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-item]');
    if (btn && !btn.disabled) onUseItem?.(btn.dataset.item);
  });

  function render(view, now = view?.t ?? Date.now()) {
    if (!view) return;
    const me = view.me;

    // --- phase and clocks -------------------------------------------------
    els.phase.textContent = view.phase === PHASE.SCATTER && me.role === 'hunter'
      ? 'WAIT AT THE START'
      : PHASE_LABEL[view.phase] || view.phase;
    els.phase.classList.toggle('hot', view.phase === PHASE.COLLAPSE);

    els.clock.textContent = mmss(view.endsAt - now);
    els.clock.classList.toggle('hot', view.endsAt - now < 120_000);

    const toPulse = view.pulse.nextAt ? view.pulse.nextAt - now : null;
    els.pulse.textContent = toPulse == null ? 'pulse —' : `pulse ${mmss(toPulse)}`;
    els.pulse.classList.toggle('hot', toPulse != null && toPulse < 15_000);

    // --- charge -----------------------------------------------------------
    const pct = Math.round((me.charge / view.config.chargeMax) * 100);
    els.chargeFill.style.width = `${pct}%`;
    els.chargeLabel.textContent = `${Math.round(me.charge)} charge · ${(me.distanceM / 1000).toFixed(2)} km`;

    // --- inventory --------------------------------------------------------
    renderItems(els.items, view, now);

    // --- the one line that matters right now ------------------------------
    const alert = chooseAlert(view, now);
    if (alert) {
      els.alert.hidden = false;
      els.alert.textContent = alert.text;
      els.alert.className = `alert ${alert.tone}`;
    } else {
      els.alert.hidden = true;
    }

    // --- recent events ----------------------------------------------------
    const fresh = view.feed.filter((e) => e.id > lastFeedId);
    if (fresh.length) {
      lastFeedId = view.feed[view.feed.length - 1].id;
      els.feed.innerHTML = view.feed.slice(-3).map((e) => `<div>${describe(e, view)}</div>`).join('');
    }
  }

  function renderItems(root, view, now) {
    const slots = [];
    const size = view.config.inventorySize;
    for (let i = 0; i < size; i++) {
      const id = view.me.items[i];
      if (!id) {
        slots.push('<button class="slot empty" disabled><span class="glyph">·</span>empty</button>');
        continue;
      }
      const item = ITEMS[id];
      if (!item) continue;
      const affordable = view.me.charge >= item.cost;
      const locked = view.me.fx.lockout > now && !item.ignoresLockout;
      const usable = affordable && !locked && view.phase !== 'over';
      slots.push(
        `<button class="slot ${usable ? 'ready' : ''}" data-item="${item.id}" ${usable ? '' : 'disabled'}>
           <span class="glyph">${item.glyph}</span>${item.name}
           <span class="cost">${item.cost ? `${item.cost}⚡` : 'free'}</span>
         </button>`,
      );
    }
    const html = slots.join('');
    if (root.dataset.html !== html) {
      root.innerHTML = html;
      root.dataset.html = html;
    }
  }

  /** Pick the single most urgent thing to say. Order matters. */
  function chooseAlert(view, now) {
    const me = view.me;
    if (me.role === 'spectator') return { tone: 'warn', text: 'Caught — watching from here' };
    if (me.convertAt > now) return { tone: 'warn', text: `Caught! Joining the hunt in ${mmss(me.convertAt - now)}` };
    if (me.dark.active) return { tone: '', text: 'SCREEN AWAY — you are being broadcast' };
    if (me.dark.flaggedUntil > now) return { tone: '', text: `FLAGGED — lit up for ${mmss(me.dark.flaggedUntil - now)}` };
    if (me.outsideM > 0) {
      const grace = me.oobSince ? Math.max(0, view.config.oobGraceS * 1000 - (now - me.oobSince)) : 0;
      return { tone: grace > 0 ? 'warn' : '', text: `OUT OF BOUNDS — ${me.outsideM}m outside${grace > 0 ? ` (${Math.ceil(grace / 1000)}s)` : ''}` };
    }
    if (me.fx.lockout > now) return { tone: 'warn', text: `Abilities down for ${mmss(me.fx.lockout - now)}` };
    // During the head start nobody can be tagged, so a proximity alarm would
    // only be crying wolf while the pack is still standing together.
    const live = view.phase !== PHASE.SCATTER;
    if (live && view.proximity.level === 'contact') {
      return { tone: '', text: me.role === 'hunter' ? 'CONTACT — hold them' : 'CAUGHT IN THE OPEN — move!' };
    }
    if (live && view.proximity.level === 'near') {
      return { tone: 'warn', text: me.role === 'hunter' ? 'Something is very close' : 'Someone is very close' };
    }
    if (me.fx.cloak > now) return { tone: 'good', text: `Cloaked — ${mmss(me.fx.cloak - now)}` };
    if (live && view.proximity.level === 'far') return { tone: 'warn', text: me.role === 'hunter' ? 'Movement nearby' : 'You are not alone out here' };
    if (view.phase === 'scatter' && me.role === 'ghost') return { tone: 'good', text: 'Head start — get away from the pack' };
    if (view.phase === 'scatter' && me.role === 'hunter') return { tone: 'warn', text: 'Stay at the start until the whistle' };
    return null;
  }

  function describe(e, view) {
    // Names come from other people's devices and land in innerHTML, so they
    // are escaped at the point of use rather than trusted at the point of entry.
    const name = (id) => escapeHtml(view.players.find((p) => p.id === id)?.name || 'someone');
    switch (e.type) {
      case 'pulse': return `Pulse ${e.n} swept the field`;
      case 'caught': return `${name(e.who)} was caught by ${name(e.by)}`;
      case 'cache': return e.item ? `Cache opened — ${ITEMS[e.item]?.name ?? e.item}` : 'Cache opened — charge';
      case 'use': return `Used ${ITEMS[e.item]?.name ?? e.item}`;
      case 'cloaked': return 'The pulse swept past you';
      case 'flag': return `${name(e.who)} moved ${e.metres}m with the screen off`;
      case 'trapped': return `${name(e.who)} tripped a wire`;
      case 'fried': return `${name(e.who)} walked into a tripwire`;
      case 'jump': return 'Impossible movement ignored';
      case 'sonar': return `Sonar: ${e.hits} contact${e.hits === 1 ? '' : 's'}`;
      case 'drone': return 'Drone deployed';
      case 'phase': return PHASE_LABEL[e.phase] || e.phase;
      case 'start': return 'The match has begun';
      case 'over': return 'Time';
      default: return e.type;
    }
  }

  return { render, describe };
}

/** The end-of-match table. */
export function renderScoreboard(table, board, view) {
  const rows = board.map((r, i) => `
    <tr>
      <td>${i + 1}. ${escapeHtml(r.name)}</td>
      <td><span class="tag ${r.role}">${r.role}</span></td>
      <td>${r.score}</td>
      <td>${(r.distanceM / 1000).toFixed(2)}km</td>
      <td>${r.caches}</td>
      <td>${r.catches}</td>
      <td>${r.darkS}s${r.jumps ? ` ⚑${r.jumps}` : ''}</td>
    </tr>`).join('');
  table.innerHTML = `
    <thead><tr><th>Player</th><th>Side</th><th>Score</th><th>Walked</th><th>Loot</th><th>Catches</th><th>Dark</th></tr></thead>
    <tbody>${rows}</tbody>`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
