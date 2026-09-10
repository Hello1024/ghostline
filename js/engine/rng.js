/**
 * Deterministic PRNG (mulberry32).
 *
 * The engine must be reproducible: same seed + same intent stream => same
 * state, so a desync between host and a replay is detectable. The generator
 * state lives inside the game state object, and `mkRng` reads/writes it in
 * place so a caller can never forget to persist it.
 */

/** Hash an arbitrary string into a 32-bit seed. */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Bind a generator to `holder[key]`, mutating it on every draw.
 * @returns {{(): number, int(n:number):number, range(a:number,b:number):number,
 *            pick<T>(arr:T[]):T, weighted<T>(entries:[T,number][]):T, bool(p:number):boolean}}
 */
export function mkRng(holder, key = 'rngState') {
  const next = () => {
    let t = (holder[key] = (holder[key] + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.range = (a, b) => a + next() * (b - a);
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.bool = (p = 0.5) => next() < p;
  next.weighted = (entries) => {
    let total = 0;
    for (const e of entries) total += e[1];
    if (total <= 0) return entries.length ? entries[0][0] : undefined;
    let r = next() * total;
    for (const [value, weight] of entries) {
      r -= weight;
      if (r <= 0) return value;
    }
    return entries[entries.length - 1][0];
  };
  return next;
}

/** A short, human-shoutable lobby code (no vowels => no accidental words). */
export function lobbyCode(rng) {
  const alphabet = 'BCDFGHJKLMNPQRSTVWXZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += alphabet[rng.int(alphabet.length)];
  return out;
}
