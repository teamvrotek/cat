/** Small, independent social episodes. Cat care and household clocks remain separate. */
export const SOCIAL_SCHEMA = 1;
export const SOCIAL_PLAY_ATTENTION_RELIEF = 0.06;
export const SOCIAL_TIMING = Object.freeze({
  continuousGapMs: 60_000,
  firstPlayMinMs: 3 * 60_000, firstPlayMaxMs: 6 * 60_000,
  playMinMs: 15 * 60_000, playMaxMs: 35 * 60_000,
  playingMs: 15_000, squabblingMs: 6_000, grumpyMs: 120_000,
  jealousyDelayMs: 4_000, jealousyMs: 90_000, jealousyCooldownMs: 180_000,
  recentlyTreatedMs: 10_000,
});
const T = SOCIAL_TIMING;
const PLAY_MODES = new Set(['content', 'happy', 'waiting', 'grumpy', 'zoomies', 'settling', 'love']);
const PROTECTED_MODES = new Set(['asleep', 'sleepy', 'eating', 'guarding', 'bowl-eating', 'full',
  'grooming', 'puking', 'litter', 'hungry', 'dirty-litter', 'attack', 'angry', 'warning',
  'enough', 'overstimulated', 'recovering', 'playfight']);
const JEALOUSY_PROTECTED_MODES = new Set([...PROTECTED_MODES].filter(mode => !['asleep', 'sleepy'].includes(mode)));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const clone = state => ({ ...state, pair: state.pair ? { ...state.pair } : null,
  jealousy: state.jealousy ? { ...state.jealousy } : null });
function assertTime(nowMs) {
  if (!finite(nowMs)) throw new RangeError('Social time must be a finite, non-negative timestamp.');
}
function draw(state, minimum, maximum) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return minimum + Math.floor(state.seed / 0x100000000 * ((maximum - minimum) / 1_000 + 1)) * 1_000;
}
const pairDuration = pair => T.playingMs + (pair.willFight ? T.squabblingMs + T.grumpyMs : 0);
const aftermath = state => state.pair?.willFight && state.clockMs - state.pair.startedAtMs >= T.playingMs + T.squabblingMs;

/** Return a bounded company benefit, regardless of how many extra cats are present. */
export function companyAttentionScale(count) {
  return Number.isFinite(count) && count >= 2 ? 0.65 : 1;
}

export function createSocial(nowMs, { seed = Math.floor(Math.random() * 0x100000000) } = {}) {
  assertTime(nowMs);
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Invalid social seed.');
  const state = { updatedAtMs: nowMs, clockMs: 0, playClockMs: 0, seed, nextPlayAtMs: 0,
    pair: null, jealousy: null, treatedUntilMs: 0, jealousyCooldownUntilMs: 0, completedPlays: 0 };
  state.nextPlayAtMs = draw(state, T.firstPlayMinMs, T.firstPlayMaxMs);
  return freeze(state);
}

/** Accept only bounded persisted fields; never import care or arbitrary object properties. */
export function validateSocial(payload) {
  const fail = () => { throw new RangeError('Saved cat social state is invalid.'); };
  if (!record(payload) || payload.schema !== SOCIAL_SCHEMA || !record(payload.state)) fail();
  const raw = payload.state;
  if (!finite(raw.updatedAtMs) || !finite(raw.clockMs) || !finite(raw.playClockMs) || raw.playClockMs > raw.clockMs
    || !Number.isInteger(raw.seed) || raw.seed < 0 || raw.seed > 0xffffffff
    || !finite(raw.nextPlayAtMs) || raw.nextPlayAtMs > raw.playClockMs + T.playMaxMs
    || !finite(raw.treatedUntilMs) || raw.treatedUntilMs > raw.clockMs + T.recentlyTreatedMs
    || !finite(raw.jealousyCooldownUntilMs) || raw.jealousyCooldownUntilMs > raw.clockMs + T.jealousyCooldownMs
    || !Number.isSafeInteger(raw.completedPlays) || raw.completedPlays < 0) fail();
  let pair = null, jealousy = null;
  if (raw.pair !== null) {
    const item = raw.pair;
    if (!record(item) || !identifier(item.partnerId) || !finite(item.startedAtMs) || item.startedAtMs > raw.clockMs
      || typeof item.willFight !== 'boolean' || typeof item.rewarded !== 'boolean'
      || raw.clockMs - item.startedAtMs >= pairDuration(item)
      || item.rewarded !== (raw.clockMs - item.startedAtMs >= T.playingMs)) fail();
    pair = { partnerId: item.partnerId, startedAtMs: item.startedAtMs, willFight: item.willFight, rewarded: item.rewarded };
  }
  if (raw.jealousy !== null) {
    const item = raw.jealousy;
    if (!record(item) || !identifier(item.sourceId) || !finite(item.triggeredAtMs) || item.triggeredAtMs > raw.clockMs
      || item.startsAtMs !== item.triggeredAtMs + T.jealousyDelayMs
      || item.endsAtMs !== item.startsAtMs + T.jealousyMs || item.endsAtMs <= raw.clockMs
      || raw.jealousyCooldownUntilMs < item.endsAtMs) fail();
    jealousy = { sourceId: item.sourceId, triggeredAtMs: item.triggeredAtMs, startsAtMs: item.startsAtMs, endsAtMs: item.endsAtMs };
  }
  return freeze({ updatedAtMs: raw.updatedAtMs, clockMs: raw.clockMs, playClockMs: raw.playClockMs,
    seed: raw.seed, nextPlayAtMs: raw.nextPlayAtMs, pair, jealousy,
    treatedUntilMs: raw.treatedUntilMs, jealousyCooldownUntilMs: raw.jealousyCooldownUntilMs,
    completedPlays: raw.completedPlays });
}

export function serializeSocial(state) {
  return { schema: SOCIAL_SCHEMA, state: JSON.parse(JSON.stringify(state)) };
}

/** Restart and clock changes preserve the remaining episode instead of simulating an absence. */
export function restoreSocial(payload, nowMs) {
  assertTime(nowMs);
  return freeze({ ...validateSocial(payload), updatedAtMs: nowMs });
}

/** Ordinary active time drives jealousy; only visible company advances the play schedule. */
export function advanceSocial(input, nowMs, { paused = false, companyCount = 1 } = {}) {
  assertTime(nowMs);
  const state = clone(input);
  const gap = nowMs - state.updatedAtMs;
  const elapsed = paused || gap < 0 || gap > T.continuousGapMs ? 0 : gap;
  state.updatedAtMs = nowMs;
  state.clockMs += elapsed;
  if (companyAttentionScale(companyCount) < 1) state.playClockMs += elapsed;
  if (state.pair) {
    const age = state.clockMs - state.pair.startedAtMs;
    if (age >= T.playingMs && !state.pair.rewarded) {
      state.pair.rewarded = true;
      state.completedPlays = Math.min(Number.MAX_SAFE_INTEGER, state.completedPlays + 1);
    }
    if (age >= pairDuration(state.pair)) state.pair = null;
  }
  if (state.jealousy && state.clockMs >= state.jealousy.endsAtMs) state.jealousy = null;
  return freeze(state);
}

export function socialPlayReady(state, { mode = 'content', blocked = false } = {}) {
  return !blocked && PLAY_MODES.has(mode) && state.pair === null && state.jealousy === null
    && state.playClockMs >= state.nextPlayAtMs;
}

/** Root chooses an eligible same-page pair once, then applies both returned states together. */
export function startSocialPair(left, right, leftId, rightId) {
  if (!identifier(leftId) || !identifier(rightId) || leftId === rightId) throw new RangeError('Choose two distinct cats.');
  if (!socialPlayReady(left) || !socialPlayReady(right)) throw new RangeError('Both cats must be ready to play.');
  const a = clone(left), b = clone(right);
  // Combining both seeds keeps the shared outcome identical despite independent clocks.
  const mixed = (Math.imul((left.seed + right.seed) >>> 0, 1664525) + 1013904223) >>> 0;
  const willFight = mixed / 0x100000000 < 0.2;
  for (const [state, partnerId] of [[a, rightId], [b, leftId]]) {
    state.pair = { partnerId, startedAtMs: state.clockMs, willFight, rewarded: false };
    state.nextPlayAtMs = state.playClockMs + draw(state, T.playMinMs, T.playMaxMs);
  }
  return Object.freeze({ left: freeze(a), right: freeze(b) });
}

/** Break up active play; a completed disagreement keeps its own brief cooling time. */
export function cancelSocialPair(state) {
  if (!state.pair || aftermath(state)) return state;
  return freeze({ ...state, pair: null });
}

/** A completed hold rewards its recipient and only notifies cats that actually saw it. */
export function recordSocialTreat(input, { received = false, sourceId } = {}) {
  const state = clone(input);
  if (received) {
    state.jealousy = null;
    state.treatedUntilMs = state.clockMs + T.recentlyTreatedMs;
    if (aftermath(state)) state.pair = null;
  } else {
    if (!identifier(sourceId)) throw new RangeError('A witnessed treat needs a cat identifier.');
    if (state.jealousy || state.clockMs < state.treatedUntilMs || state.clockMs < state.jealousyCooldownUntilMs) return input;
    state.jealousy = { sourceId, triggeredAtMs: state.clockMs,
      startsAtMs: state.clockMs + T.jealousyDelayMs,
      endsAtMs: state.clockMs + T.jealousyDelayMs + T.jealousyMs };
    state.jealousyCooldownUntilMs = state.clockMs + T.jealousyCooldownMs;
  }
  return freeze(state);
}

/** Only an overlay. Busy care scenes and all underlying care meters retain priority. */
export function socialFrame(state, { mode, blocked = false } = {}) {
  if (blocked) return null;
  if (state.jealousy && state.clockMs >= state.jealousy.startsAtMs) {
    if (JEALOUSY_PROTECTED_MODES.has(mode)) return null;
    const elapsed = state.clockMs - state.jealousy.startsAtMs;
    return { mode: 'jealous', socialKind: 'jealousy', socialPartnerId: state.jealousy.sourceId,
      phase: elapsed % 2_800 / 2_800, effectProgress: Math.min(1, elapsed / T.jealousyMs) };
  }
  if (PROTECTED_MODES.has(mode)) return null;
  if (!state.pair) return null;
  const elapsed = state.clockMs - state.pair.startedAtMs;
  const frame = { socialPartnerId: state.pair.partnerId };
  if (elapsed < T.playingMs) return { ...frame, mode: 'playing-together', socialKind: 'play',
    phase: elapsed % 1_000 / 1_000, effectProgress: elapsed / T.playingMs };
  if (state.pair.willFight && elapsed < T.playingMs + T.squabblingMs) return { ...frame,
    mode: 'squabbling', socialKind: 'squabble', phase: (elapsed - T.playingMs) % 600 / 600,
    effectProgress: (elapsed - T.playingMs) / T.squabblingMs };
  if (state.pair.willFight) return { ...frame, mode: 'social-grumpy', socialKind: 'grumpy',
    phase: (elapsed - T.playingMs - T.squabblingMs) % 2_800 / 2_800,
    effectProgress: (elapsed - T.playingMs - T.squabblingMs) / T.grumpyMs };
  return null;
}
