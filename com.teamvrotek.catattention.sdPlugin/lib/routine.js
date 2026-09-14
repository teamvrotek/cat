import { FOOD_LOW_LEVEL, LITTER_CAPACITY } from './care-constants.js';
import { APPETITES, DEFAULT_APPETITE } from './appetite.js';

/** Optional, fictional household routines. Resource clocks run only while linked keys are active. */
export const ROUTINE_SCHEMA = 1;
export const ROUTINE_TIMING = Object.freeze({
  continuousGapMs: 60_000,
  firstMealMinMs: 60_000, firstMealMaxMs: 180_000,
  mealMinMs: APPETITES.normal.mealMinMs, mealMaxMs: APPETITES.normal.mealMaxMs,
  firstNibbleMinMs: 2 * 60_000, firstNibbleMaxMs: 5 * 60_000,
  nibbleMinMs: APPETITES.normal.nibbleMinMs, nibbleMaxMs: APPETITES.normal.nibbleMaxMs,
  firstLitterMinMs: 8 * 60_000, firstLitterMaxMs: 12 * 60_000,
  litterMinMs: APPETITES.normal.litterMinMs, litterMaxMs: APPETITES.normal.litterMaxMs,
  hungryAfterMs: 30 * 60_000, treatWindowMs: 10 * 60_000, fullTreatCount: 4,
  overfedTreatCount: 6, pukeDelayMs: 3_000, pukingMs: 6_000, pukeGroomMs: 20_000, pukeCooldownMs: 10 * 60_000,
  treatDigestionMs: 20 * 60_000, treatLitterMaxMs: 45 * 60_000,
  mealDigestionMs: 15 * 60_000, digestionMinMs: 10 * 60_000, litterRecoveryMs: 20 * 60_000,
  bowlEatingMs: 12_000, bowlNibbleMs: 4_000, mealPortion: 0.3, nibblePortion: 0.06, freshFoodDelayMs: 1_000,
  litterUsingMs: 15_000, litterGraceMs: 3_000, fullMs: 8_000,
  groomMinMs: 60_000, groomMaxMs: 120_000, napMinMs: 10 * 60_000, napMaxMs: 30 * 60_000,
});
const PERIODS = ['day', 'evening', 'night'];
const KINDS = ['bowl-eating', 'bowl-nibble', 'litter', 'full', 'grooming', 'nap', 'puking'];
const REASONS = ['day', 'food', 'treats', 'litter', 'overfed'];
const LEGACY_LITTER_MAX = { light: 300 * 60_000, normal: 300 * 60_000, hungry: 180 * 60_000 };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clamp = value => Math.min(1, Math.max(0, value));
const hasMeal = state => state.food.level > 1e-9;
const isEating = activity => ['bowl-eating', 'bowl-nibble'].includes(activity?.kind);
const legacyPortion = activity => activity.kind === 'bowl-nibble' ? 0.04 : 0.2;
const servingPortion = activity => activity.kind === 'bowl-nibble' ? ROUTINE_TIMING.nibblePortion : ROUTINE_TIMING.mealPortion;
const portion = activity => activity.foodPortion ?? legacyPortion(activity);
const appetiteOf = state => APPETITES[state.appetite ?? DEFAULT_APPETITE];
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const clone = state => ({ ...state, recentTreats: [...state.recentTreats], food: { ...state.food },
  litter: { ...state.litter }, digestion: { ...state.digestion }, activity: state.activity ? { ...state.activity } : null });
function assertTime(nowMs) {
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new RangeError('Routine time must be a finite, non-negative timestamp.');
}
function draw(state, minimum, maximum) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return minimum + Math.floor((state.seed / 0x100000000) * (Math.floor((maximum - minimum) / 1_000) + 1)) * 1_000;
}

export function createRoutine(nowMs, period, { seed = Math.floor(Math.random() * 0x100000000), appetite = DEFAULT_APPETITE } = {}) {
  assertTime(nowMs);
  if (!PERIODS.includes(period) || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Invalid routine seed or period.');
  if (!Object.hasOwn(APPETITES, appetite)) throw new RangeError('Choose a listed appetite.');
  const state = { updatedAtMs: nowMs, clockMs: 0, seed, period, appetite, recentTreats: [], pendingFull: null, pendingDay: period === 'day', activity: null,
    food: { active: false, level: 1, clockMs: 0, nextAtMs: 0, nextNibbleAtMs: 0, freshMealAtMs: null, emptyForMs: 0 },
    litter: { active: false, soil: 0, clockMs: 0, nextAtMs: 0, lastVisitAtMs: null },
    digestion: { version: 1, pendingPukeAtMs: null, pukeCooldownUntilMs: 0 } };
  state.food.nextAtMs = draw(state, ROUTINE_TIMING.firstMealMinMs, ROUTINE_TIMING.firstMealMaxMs);
  state.litter.nextAtMs = draw(state, ROUTINE_TIMING.firstLitterMinMs, ROUTINE_TIMING.firstLitterMaxMs);
  state.food.nextNibbleAtMs = draw(state, ROUTINE_TIMING.firstNibbleMinMs, ROUTINE_TIMING.firstNibbleMaxMs);
  return freeze(state);
}

/** Validate only the routine payload. Invalid routines never invalidate existing cat care. */
export function validateRoutine(payload) {
  const fail = () => { throw new RangeError('Saved cat routines are invalid.'); };
  if (!record(payload) || payload.schema !== ROUTINE_SCHEMA || !record(payload.state)) fail();
  const raw = payload.state;
  const appetite = raw.appetite === undefined ? DEFAULT_APPETITE : raw.appetite;
  if (!Object.hasOwn(APPETITES, appetite)) fail();
  const intervals = APPETITES[appetite];
  const finite = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  if (!finite(raw.updatedAtMs) || !finite(raw.clockMs) || !Number.isInteger(raw.seed) || raw.seed < 0 || raw.seed > 0xffffffff
    || !PERIODS.includes(raw.period) || typeof raw.pendingDay !== 'boolean' || ![null, 'food', 'treats'].includes(raw.pendingFull)) fail();
  if (!Array.isArray(raw.recentTreats) || raw.recentTreats.length > ROUTINE_TIMING.overfedTreatCount
    || raw.recentTreats.some((time, index) => !finite(time) || time > raw.clockMs || (index > 0 && time < raw.recentTreats[index - 1]))) fail();
  const food = raw.food, litter = raw.litter;
  if (!record(food) || typeof food.active !== 'boolean' || !Number.isFinite(food.level) || food.level < 0 || food.level > 1
    || !finite(food.clockMs) || food.clockMs > raw.clockMs || !finite(food.nextAtMs)
    || food.nextAtMs > food.clockMs + intervals.mealMaxMs
    || !finite(food.emptyForMs) || food.emptyForMs > food.clockMs) fail();
  // Existing 1.0 saves gain a short initial nibble wait without changing their
  // meal deadline, supplies, seed or accumulated visible time.
  const nextNibbleAtMs = food.nextNibbleAtMs === undefined
    ? food.clockMs + draw({ seed: raw.seed }, ROUTINE_TIMING.firstNibbleMinMs, ROUTINE_TIMING.firstNibbleMaxMs)
    : food.nextNibbleAtMs;
  if (!finite(nextNibbleAtMs) || nextNibbleAtMs > food.clockMs + intervals.nibbleMaxMs) fail();
  const freshMealAtMs = food.freshMealAtMs === undefined ? null : food.freshMealAtMs;
  if (freshMealAtMs !== null && (!finite(freshMealAtMs) || freshMealAtMs > food.clockMs + ROUTINE_TIMING.freshFoodDelayMs)) fail();
  const legacy = raw.digestion === undefined;
  const digestion = legacy ? { version: 1, pendingPukeAtMs: null, pukeCooldownUntilMs: 0 } : raw.digestion;
  if (!record(digestion) || digestion.version !== 1
    || (digestion.pendingPukeAtMs !== null && (!finite(digestion.pendingPukeAtMs) || digestion.pendingPukeAtMs > raw.clockMs + ROUTINE_TIMING.pukeDelayMs))
    || !finite(digestion.pukeCooldownUntilMs) || digestion.pukeCooldownUntilMs > raw.clockMs + ROUTINE_TIMING.pukeCooldownMs) fail();
  const lastVisitAtMs = litter?.lastVisitAtMs === undefined ? null : litter.lastVisitAtMs;
  if (!record(litter) || typeof litter.active !== 'boolean' || !Number.isInteger(litter.soil) || litter.soil < 0 || litter.soil > LITTER_CAPACITY
    || !finite(litter.clockMs) || litter.clockMs > raw.clockMs || !finite(litter.nextAtMs)
    || litter.nextAtMs > litter.clockMs + (legacy ? LEGACY_LITTER_MAX[appetite] : intervals.litterMaxMs)
    || (lastVisitAtMs !== null && (!finite(lastVisitAtMs) || lastVisitAtMs > litter.clockMs))) fail();
  let nextLitterAtMs = litter.nextAtMs;
  // Existing keys retain their first short visit. Later waits keep the same
  // remaining fraction of the new range, without resetting soil or clocks.
  if (legacy && !(litter.soil === 0 && litter.nextAtMs <= ROUTINE_TIMING.firstLitterMaxMs)) {
    nextLitterAtMs = litter.clockMs + Math.max(0, litter.nextAtMs - litter.clockMs) * intervals.litterMaxMs / LEGACY_LITTER_MAX[appetite];
  }
  let activity = null;
  if (raw.activity !== null) {
    const item = raw.activity;
    if (!record(item) || !KINDS.includes(item.kind) || !REASONS.includes(item.reason)
      || !finite(item.elapsedMs) || !finite(item.durationMs) || item.durationMs <= 0 || item.elapsedMs >= item.durationMs
      || !finite(item.groomMs) || !finite(item.napMs)) fail();
    if (item.elapsedMs > raw.clockMs
      || (isEating(item) && (item.reason !== 'food' || !food.active))
      || (item.kind === 'litter' && (item.reason !== 'litter' || !litter.active))
      || (item.kind === 'full' && !['food', 'treats'].includes(item.reason))
      || (item.kind === 'puking' && item.reason !== 'overfed')
      || (item.reason === 'overfed' && !['puking', 'grooming'].includes(item.kind))
      || (['grooming', 'nap'].includes(item.kind) && !['day', 'food', 'treats', 'overfed'].includes(item.reason))) fail();
    if (item.reason === 'overfed') {
      if (item.groomMs !== ROUTINE_TIMING.pukeGroomMs || item.napMs !== 0
        || item.durationMs !== (item.kind === 'puking' ? ROUTINE_TIMING.pukingMs : ROUTINE_TIMING.pukeGroomMs)) fail();
    } else if (['full', 'grooming', 'nap'].includes(item.kind)) {
      if (item.groomMs < ROUTINE_TIMING.groomMinMs || item.groomMs > ROUTINE_TIMING.groomMaxMs
        || item.napMs < ROUTINE_TIMING.napMinMs || item.napMs > ROUTINE_TIMING.napMaxMs
        || item.durationMs !== ({ full: ROUTINE_TIMING.fullMs, grooming: item.groomMs, nap: item.napMs })[item.kind]) fail();
    } else if (item.durationMs !== ({ 'bowl-eating': ROUTINE_TIMING.bowlEatingMs, 'bowl-nibble': ROUTINE_TIMING.bowlNibbleMs, litter: ROUTINE_TIMING.litterUsingMs })[item.kind]
      || item.groomMs !== 0 || item.napMs !== 0) fail();
    activity = Object.fromEntries(['kind', 'reason', 'elapsedMs', 'durationMs', 'groomMs', 'napMs'].map(key => [key, item[key]]));
    if (isEating(item)) {
      const foodPortion = portion(item);
      if (![legacyPortion(item), servingPortion(item)].includes(foodPortion)) fail();
      const freshFood = item.freshFood === undefined ? false : item.freshFood;
      if (typeof freshFood !== 'boolean' || (freshFood && item.kind !== 'bowl-eating')) fail();
      const consumedFood = item.consumedFood ?? 0;
      if (!Number.isFinite(consumedFood) || consumedFood < 0 || consumedFood > foodPortion + 1e-9
        || consumedFood > foodPortion * item.elapsedMs / item.durationMs + 1e-9) fail();
      activity.consumedFood = consumedFood;
      activity.foodPortion = foodPortion;
      activity.freshFood = freshFood;
    }
  }
  return freeze({ updatedAtMs: raw.updatedAtMs, clockMs: raw.clockMs, seed: raw.seed, period: raw.period, appetite,
    recentTreats: [...raw.recentTreats], pendingFull: raw.pendingFull, pendingDay: raw.pendingDay, activity,
    food: { ...Object.fromEntries(['active', 'level', 'clockMs', 'nextAtMs', 'emptyForMs'].map(key => [key, food[key]])), nextNibbleAtMs, freshMealAtMs },
    litter: { ...Object.fromEntries(['active', 'soil', 'clockMs'].map(key => [key, litter[key]])), nextAtMs: nextLitterAtMs, lastVisitAtMs },
    digestion: Object.fromEntries(['version', 'pendingPukeAtMs', 'pukeCooldownUntilMs'].map(key => [key, digestion[key]])) });
}

/** Restoring or rebasing a clock never consumes food, fills litter, or ages an empty bowl. */
export function restoreRoutine(payload, nowMs) {
  assertTime(nowMs);
  const state = clone(validateRoutine(payload));
  state.updatedAtMs = nowMs;
  finishFoodDigestion(state);
  state.food.active = false;
  state.litter.active = false;
  if (isEating(state.activity) || state.activity?.kind === 'litter') state.activity = null;
  return freeze(state);
}

function sequence(state, reason) {
  const groomMs = draw(state, ROUTINE_TIMING.groomMinMs, ROUTINE_TIMING.groomMaxMs);
  const napMs = draw(state, ROUTINE_TIMING.napMinMs, ROUTINE_TIMING.napMaxMs);
  state.activity = { kind: reason === 'day' ? 'grooming' : 'full', reason, elapsedMs: 0,
    durationMs: reason === 'day' ? groomMs : ROUTINE_TIMING.fullMs, groomMs, napMs };
  state.pendingFull = null;
  state.pendingDay = false;
}
function foodDue(state) { return state.food.active && hasMeal(state) && state.food.clockMs >= state.food.nextAtMs; }
function freshFoodDue(state) {
  return state.food.active && hasMeal(state) && state.food.freshMealAtMs !== null && state.food.clockMs >= state.food.freshMealAtMs;
}
function nibbleDue(state) { return state.food.active && hasMeal(state) && state.food.clockMs >= state.food.nextNibbleAtMs; }
function litterDue(state, allowLitter = true) { return allowLitter && state.litter.active && state.litter.soil < LITTER_CAPACITY && state.litter.clockMs >= state.litter.nextAtMs; }
function hastenLitter(state, reductionMs, maximumWaitMs = Infinity) {
  if (!state.litter.active || reductionMs <= 0) return;
  const litter = state.litter;
  const earliest = Math.max(litter.clockMs + ROUTINE_TIMING.digestionMinMs,
    litter.lastVisitAtMs === null ? 0 : litter.lastVisitAtMs + ROUTINE_TIMING.litterRecoveryMs);
  litter.nextAtMs = Math.min(litter.nextAtMs, Math.max(earliest,
    Math.min(litter.nextAtMs - reductionMs, litter.clockMs + maximumWaitMs)));
}
function finishFoodDigestion(state) {
  if (!isEating(state.activity)) return;
  // Digestion follows the amount eaten, including servings from older saves.
  hastenLitter(state, (state.activity.consumedFood ?? 0) / 0.2 * ROUTINE_TIMING.mealDigestionMs);
  state.activity.consumedFood = 0;
}
/** Brief overfeeding responses and overdue litter visits can interrupt a mood. */
export function routinePriority(state, { allowFreshFood = true, allowLitter = true } = {}) {
  return state.activity?.reason === 'overfed'
    || (state.digestion.pendingPukeAtMs !== null && state.clockMs >= state.digestion.pendingPukeAtMs)
    || state.activity?.kind === 'litter'
    || (litterDue(state, allowLitter) && state.litter.clockMs >= state.litter.nextAtMs + ROUTINE_TIMING.litterGraceMs)
    || (allowFreshFood && (state.activity?.freshFood || freshFoodDue(state)));
}
function selectActivity(state, blocked, allowFreshFood, allowLitter) {
  if (state.digestion.pendingPukeAtMs !== null && state.clockMs >= state.digestion.pendingPukeAtMs) {
    finishFoodDigestion(state);
    state.activity = { kind: 'puking', reason: 'overfed', elapsedMs: 0, durationMs: ROUTINE_TIMING.pukingMs,
      groomMs: ROUTINE_TIMING.pukeGroomMs, napMs: 0 };
    state.digestion.pendingPukeAtMs = null;
    state.pendingFull = null;
    return;
  }
  if (state.activity?.reason === 'overfed') return;
  if (state.activity?.kind === 'litter') return;
  // The grace belongs to this visit's deadline. More treats cannot renew it.
  if (litterDue(state, allowLitter) && state.litter.clockMs >= state.litter.nextAtMs + ROUTINE_TIMING.litterGraceMs) {
    finishFoodDigestion(state);
    state.activity = { kind: 'litter', reason: 'litter', elapsedMs: 0, durationMs: ROUTINE_TIMING.litterUsingMs, groomMs: 0, napMs: 0 };
    return;
  }
  if (allowFreshFood && freshFoodDue(state) && !isEating(state.activity)) {
    state.pendingFull = null;
    state.pendingDay = false;
    state.activity = null;
    startMeal(state, true);
    return;
  }
  if (blocked && !routinePriority(state, { allowFreshFood, allowLitter })) return;
  if ((state.activity?.kind === 'nap' && (foodDue(state) || litterDue(state, allowLitter) || nibbleDue(state) || state.pendingFull))
    || (state.pendingFull && state.activity?.reason === 'day')) state.activity = null;
  if (state.activity) return;
  if (state.pendingFull) { sequence(state, state.pendingFull); return; }
  if (state.pendingDay) { sequence(state, 'day'); return; }
  if (foodDue(state) && state.food.freshMealAtMs === null) startMeal(state);
  else if (litterDue(state, allowLitter)) state.activity = { kind: 'litter', reason: 'litter', elapsedMs: 0, durationMs: ROUTINE_TIMING.litterUsingMs, groomMs: 0, napMs: 0 };
  else if (nibbleDue(state) && state.food.freshMealAtMs === null) {
    state.food.freshMealAtMs = null;
    state.activity = { kind: 'bowl-nibble', reason: 'food', elapsedMs: 0, durationMs: ROUTINE_TIMING.bowlNibbleMs,
      groomMs: 0, napMs: 0, consumedFood: 0, foodPortion: ROUTINE_TIMING.nibblePortion, freshFood: false };
  }
}
function startMeal(state, freshFood = false) {
  state.food.freshMealAtMs = null;
  state.activity = { kind: 'bowl-eating', reason: 'food', elapsedMs: 0, durationMs: ROUTINE_TIMING.bowlEatingMs,
    groomMs: 0, napMs: 0, consumedFood: 0, foodPortion: ROUTINE_TIMING.mealPortion, freshFood };
}
function completeActivity(state) {
  const activity = state.activity;
  const intervals = appetiteOf(state);
  finishFoodDigestion(state);
  if (activity.kind === 'bowl-eating') {
    state.food.nextAtMs = state.food.clockMs + draw(state, intervals.mealMinMs, intervals.mealMaxMs);
    state.food.nextNibbleAtMs = state.food.clockMs + draw(state, intervals.nibbleMinMs, intervals.nibbleMaxMs);
    state.pendingFull = 'food';
    state.activity = null;
  } else if (activity.kind === 'bowl-nibble') {
    state.food.nextNibbleAtMs = state.food.clockMs + draw(state, intervals.nibbleMinMs, intervals.nibbleMaxMs);
    state.activity = null;
  } else if (activity.kind === 'litter') {
    state.litter.soil = Math.min(LITTER_CAPACITY, state.litter.soil + 1);
    state.litter.lastVisitAtMs = state.litter.clockMs;
    state.litter.nextAtMs = state.litter.clockMs + draw(state, intervals.litterMinMs, intervals.litterMaxMs);
    state.activity = null;
  } else if (activity.kind === 'puking') {
    state.activity = { ...activity, kind: 'grooming', elapsedMs: 0, durationMs: ROUTINE_TIMING.pukeGroomMs };
  } else if (activity.kind === 'full') {
    state.activity = { ...activity, kind: 'grooming', elapsedMs: 0, durationMs: activity.groomMs };
  } else if (activity.kind === 'grooming' && activity.reason !== 'overfed') {
    state.activity = { ...activity, kind: 'nap', elapsedMs: 0, durationMs: activity.napMs };
  } else state.activity = null;
}

/** Small event-driven updates, with a hard bound and no catch-up penalties after suspension. */
export function advanceRoutine(input, nowMs, { period = input.period, blocked = false, paused = false, allowFreshFood = true, allowLitter = true } = {}) {
  assertTime(nowMs);
  if (!PERIODS.includes(period)) throw new RangeError('Invalid routine period.');
  const state = clone(input);
  const gap = nowMs - state.updatedAtMs;
  let remaining = paused || gap < 0 || gap > ROUTINE_TIMING.continuousGapMs ? 0 : gap;
  state.updatedAtMs = nowMs;
  if (period !== state.period && period === 'day' && !['full', 'grooming', 'nap'].includes(state.activity?.kind)) state.pendingDay = true;
  state.period = period;
  for (let transitions = 0; transitions < 16; transitions++) {
    selectActivity(state, blocked, allowFreshFood, allowLitter);
    if (remaining <= 0) break;
    const activityBlocked = blocked && !routinePriority(state, { allowFreshFood, allowLitter });
    let step = remaining;
    if (state.digestion.pendingPukeAtMs !== null && state.digestion.pendingPukeAtMs > state.clockMs) {
      step = Math.min(step, state.digestion.pendingPukeAtMs - state.clockMs);
    }
    if (allowLitter && state.litter.active && state.litter.soil < LITTER_CAPACITY
      && state.litter.nextAtMs + ROUTINE_TIMING.litterGraceMs > state.litter.clockMs) {
      step = Math.min(step, state.litter.nextAtMs + ROUTINE_TIMING.litterGraceMs - state.litter.clockMs);
    }
    if (allowFreshFood && state.food.active && hasMeal(state) && state.food.freshMealAtMs > state.food.clockMs) {
      step = Math.min(step, state.food.freshMealAtMs - state.food.clockMs);
    }
    if (!activityBlocked) {
      if (state.activity) step = Math.min(step, state.activity.durationMs - state.activity.elapsedMs);
      if (isEating(state.activity) && hasMeal(state)) step = Math.min(step, state.food.level * state.activity.durationMs / portion(state.activity));
      if (!state.activity || state.activity.kind === 'nap') {
        if (state.food.active && hasMeal(state) && state.food.nextAtMs > state.food.clockMs) step = Math.min(step, state.food.nextAtMs - state.food.clockMs);
        if (state.food.active && hasMeal(state) && state.food.nextNibbleAtMs > state.food.clockMs) step = Math.min(step, state.food.nextNibbleAtMs - state.food.clockMs);
        if (state.litter.active && state.litter.soil < LITTER_CAPACITY && state.litter.nextAtMs > state.litter.clockMs) step = Math.min(step, state.litter.nextAtMs - state.litter.clockMs);
      }
    }
    state.clockMs += step;
    if (state.food.active) {
      state.food.clockMs += step;
      if (!hasMeal(state)) state.food.emptyForMs += step;
      if (!activityBlocked && isEating(state.activity)) {
        const before = state.food.level;
        state.food.level = Math.max(0, Math.round((state.food.level - portion(state.activity) * step / state.activity.durationMs) * 1e12) / 1e12);
        if (!hasMeal(state)) state.food.level = 0;
        if (state.litter.active) state.activity.consumedFood += before - state.food.level;
      }
    }
    if (state.litter.active) state.litter.clockMs += step;
    if (state.activity && !activityBlocked) state.activity.elapsedMs += step;
    remaining -= step;
    if (state.activity && state.activity.elapsedMs >= state.activity.durationMs) completeActivity(state);
  }
  state.recentTreats = state.recentTreats.filter(time => state.clockMs - time <= ROUTINE_TIMING.treatWindowMs);
  return freeze(state);
}

export function setRoutineCompanions(input, { food = false, litter = false } = {}) {
  if (typeof food !== 'boolean' || typeof litter !== 'boolean') throw new RangeError('Companion visibility must be boolean.');
  const state = clone(input);
  if (!food || !litter) finishFoodDigestion(state);
  state.food.active = food;
  state.litter.active = litter;
  if ((!food && isEating(state.activity)) || (!litter && state.activity?.kind === 'litter')) state.activity = null;
  return freeze(state);
}

/** Keep the remaining fraction of each maximum wait when appetite changes.
 * Supplies, logical clocks and any visit already in progress remain untouched.
 * The next ordinary advance decides whether a visit can begin.
 */
export function setRoutineAppetite(input, appetite) {
  if (!Object.hasOwn(APPETITES, appetite)) throw new RangeError('Choose a listed appetite.');
  if (input.appetite === appetite) return input;
  const state = clone(input);
  const previous = appetiteOf(input), next = APPETITES[appetite];
  const rescale = (resource, deadline, oldMaximum, newMaximum) => {
    const remaining = Math.max(0, resource[deadline] - resource.clockMs);
    if (remaining > 0) resource[deadline] = resource.clockMs + Math.max(1, remaining * newMaximum / oldMaximum);
  };
  rescale(state.food, 'nextAtMs', previous.mealMaxMs, next.mealMaxMs);
  rescale(state.food, 'nextNibbleAtMs', previous.nibbleMaxMs, next.nibbleMaxMs);
  rescale(state.litter, 'nextAtMs', previous.litterMaxMs, next.litterMaxMs);
  if (state.litter.lastVisitAtMs !== null) {
    state.litter.nextAtMs = Math.max(state.litter.nextAtMs, state.litter.lastVisitAtMs + ROUTINE_TIMING.litterRecoveryMs);
  }
  state.appetite = appetite;
  return freeze(state);
}
export function recordRoutineTreat(input) {
  const state = clone(input);
  state.recentTreats = state.recentTreats.filter(time => state.clockMs - time <= ROUTINE_TIMING.treatWindowMs);
  state.recentTreats.push(state.clockMs);
  state.recentTreats = state.recentTreats.slice(-ROUTINE_TIMING.overfedTreatCount);
  hastenLitter(state, ROUTINE_TIMING.treatDigestionMs, ROUTINE_TIMING.treatLitterMaxMs);
  if (state.recentTreats.length >= ROUTINE_TIMING.overfedTreatCount
    && state.clockMs >= state.digestion.pukeCooldownUntilMs
    && state.digestion.pendingPukeAtMs === null && state.activity?.reason !== 'overfed') {
    state.digestion.pendingPukeAtMs = state.clockMs + ROUTINE_TIMING.pukeDelayMs;
    state.digestion.pukeCooldownUntilMs = state.clockMs + ROUTINE_TIMING.pukeCooldownMs;
    state.pendingFull = null;
  } else if (state.recentTreats.length === ROUTINE_TIMING.fullTreatCount) {
    if (!state.activity || state.activity.reason === 'day' || state.activity.kind === 'nap') state.pendingFull = 'treats';
  }
  return freeze(state);
}
export function refillRoutine(input) {
  const state = clone(input);
  const interested = state.food.active && state.food.level <= FOOD_LOW_LEVEL;
  state.food.level = 1;
  state.food.emptyForMs = 0;
  if (interested && !isEating(state.activity) && state.food.freshMealAtMs === null) {
    state.food.freshMealAtMs = state.food.clockMs + ROUTINE_TIMING.freshFoodDelayMs;
  }
  return freeze(state);
}
export function cleanRoutineLitter(input) {
  const state = clone(input);
  state.litter.soil = 0;
  return freeze(state);
}

export function routineFrame(state, { blocked = false, allowFreshFood = true, allowLitter = true } = {}) {
  const suppressed = blocked && !routinePriority(state, { allowFreshFood, allowLitter });
  const activity = suppressed ? null : state.activity;
  const progress = activity ? clamp(activity.elapsedMs / activity.durationMs) : 0;
  const eating = isEating(activity);
  const mealKind = eating ? activity.kind === 'bowl-nibble' ? 'nibble' : 'meal' : null;
  const companions = {
    food: { active: state.food.active, level: state.food.level,
      emptySinceMs: state.food.active && !hasMeal(state) ? state.updatedAtMs - state.food.emptyForMs : null,
      eating: Boolean(state.food.active && eating), mealKind, progress: eating ? progress : 0 },
    litter: { active: state.litter.active, soil: state.litter.soil,
      using: Boolean(state.litter.active && activity?.kind === 'litter'), progress: activity?.kind === 'litter' ? progress : 0 },
  };
  const base = { routineMode: null, routineReason: null, groomPart: null, mealKind: null, mealProgress: 0, companions };
  if (suppressed) return base;
  if (activity) {
    const mode = activity.kind === 'nap' ? 'asleep' : eating ? 'bowl-eating' : activity.kind;
    return { ...base, mode, routineMode: eating ? 'bowl-eating' : activity.kind, stage: `routine-${activity.kind}`,
      routineReason: activity.reason === 'overfed' ? 'overfeeding' : activity.reason,
      variant: ['nap', 'grooming'].includes(activity.kind) ? 'sleep' : 'calm',
      gesture: activity.kind === 'grooming' ? 'groom' : activity.kind === 'nap' ? 'sleepy-smile' : 'knead',
      affectionate: false, overloadWarning: false, effectProgress: progress,
      groomPart: activity.kind === 'grooming' ? ['left-paw', 'right-paw', 'tail'][Math.min(2, Math.floor(progress * 3))] : null,
      mealKind, mealProgress: eating ? progress : 0,
      elapsedMs: activity.elapsedMs, nextChangeInMs: activity.durationMs - activity.elapsedMs };
  }
  if (state.food.active && !hasMeal(state) && state.food.emptyForMs >= ROUTINE_TIMING.hungryAfterMs) {
    return { ...base, mode: 'hungry', routineMode: 'hungry', stage: 'waiting-for-food', gesture: 'side-eye', variant: 'calm', affectionate: false };
  }
  if (state.litter.active && state.litter.soil >= LITTER_CAPACITY) {
    return { ...base, mode: 'dirty-litter', routineMode: 'dirty-litter', stage: 'waiting-for-clean-litter', gesture: 'side-eye', variant: 'calm', affectionate: false };
  }
  return base;
}

/** Project a physical shared supply without changing the cat's clocks or serving. */
export function projectRoutineSupplies(input, { foodLevel, foodEmptyForMs, litterSoil } = {}) {
  const state = clone(input);
  if (foodLevel !== undefined) {
    if (!Number.isFinite(foodLevel) || foodLevel < 0 || foodLevel > 1) throw new RangeError('Invalid food level.');
    state.food.level = foodLevel;
  }
  if (foodEmptyForMs !== undefined) {
    if (!Number.isFinite(foodEmptyForMs) || foodEmptyForMs < 0) throw new RangeError('Invalid empty-bowl time.');
    state.food.emptyForMs = Math.min(state.food.clockMs, foodEmptyForMs);
  }
  if (litterSoil !== undefined) {
    if (!Number.isInteger(litterSoil) || litterSoil < 0 || litterSoil > LITTER_CAPACITY) throw new RangeError('Invalid litter level.');
    state.litter.soil = litterSoil;
  }
  return freeze(state);
}

/** A shared low-bowl refill invites a meal without manufacturing another bowl. */
export function inviteRoutineMeal(input) {
  const state = clone(input);
  if (state.food.active && hasMeal(state) && !isEating(state.activity) && state.food.freshMealAtMs === null) {
    state.food.freshMealAtMs = state.food.clockMs + ROUTINE_TIMING.freshFoodDelayMs;
  }
  return freeze(state);
}
