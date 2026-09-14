import { createCatState, getPeriod, giveAttention, giveTreat, resolveCatState, setTemperament, TEMPERAMENTS, CAT_TIMING } from './lib/behavior.js';
import { MODES } from './lib/renderer.js';
import { CARE_SCHEMA, isRecord, normalizeConfig } from './config.js';
import { LITTER_CAPACITY } from './lib/care-constants.js';
import { ROUTINE_SCHEMA, ROUTINE_TIMING, createRoutine, restoreRoutine, validateRoutine, advanceRoutine,
  setRoutineCompanions, setRoutineAppetite, recordRoutineTreat, refillRoutine, cleanRoutineLitter, routineFrame, routinePriority, projectRoutineSupplies, inviteRoutineMeal } from './lib/routine.js';

const PERIODS = ['day', 'evening', 'night'];
const VARIANTS = ['sleep', 'calm', 'wild'];
const GESTURES = ['slow-blink', 'headbutt', 'cheek-rub', 'knead', 'sleepy-smile', 'pounce', 'side-eye', 'shield', 'withdraw', 'groom'];
const MODES_SET = new Set(MODES.map(mode => mode.id));
const COUNTER = value => Number.isSafeInteger(value) && value >= 0;
const copy = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const pick = (object, fields) => Object.fromEntries(fields.map(field => [field, object[field]]));

export function periodAt(nowMs, schedule) {
  const date = new Date(nowMs);
  return getPeriod(date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 + date.getMilliseconds() / 60_000, schedule);
}

function nextBoundary(afterMs, schedule) {
  const date = new Date(afterMs);
  let next = Infinity;
  for (let day = 0; day < 3; day++) {
    for (const time of Object.values(schedule)) {
      const [hour, minute] = time.split(':').map(Number);
      const candidate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + day, hour, minute).getTime();
      if (candidate > afterMs && candidate < next) next = candidate;
    }
  }
  return next;
}

/** Exact recent schedule boundaries, with at most two days of work after a long absence. */
export function advanceCare(state, nowMs, config, attentionScale = 1) {
  const end = Math.max(nowMs, state.updatedAtMs);
  let current = state;
  if (end - current.updatedAtMs > 48 * 60 * 60_000) {
    const recent = end - 48 * 60 * 60_000;
    current = resolveCatState(current, recent, current.period, { attentionScale }).state;
    current = resolveCatState(current, recent, periodAt(recent, config.schedule), { attentionScale }).state;
  }
  let boundary = nextBoundary(current.updatedAtMs, config.schedule);
  for (let count = 0; boundary <= end && count < 12; count++) {
    current = resolveCatState(current, boundary, periodAt(boundary, config.schedule), { attentionScale }).state;
    boundary = nextBoundary(boundary, config.schedule);
  }
  return resolveCatState(current, end, periodAt(end, config.schedule), { attentionScale });
}

/** Whitelist persisted care, checking every timestamp, meter, counter and effect enum. */
export function validateCare(care, nowMs) {
  const fail = () => { throw new RangeError('Saved cat care is invalid.'); };
  if (!isRecord(care) || care.schema !== CARE_SCHEMA || !isRecord(care.state)) fail();
  const raw = care.state;
  const fields = ['createdAtMs', 'updatedAtMs', 'period', 'periodStartedAtMs', 'routineStartedAtMs', 'routineStartMode', 'temperament', 'demoSpeed', 'energy', 'attentionNeed', 'stimulation', 'affection', 'careStage', 'lastAttentionAtMs', 'attentionCount', 'treatCount', 'tapEffect', 'treat', 'recoveryContext', 'touchBurst', 'anger', 'careStageUntilMs'];
  const state = pick(raw, fields);
  // Existing 1.0 keys acquire the new mood fields without losing their care.
  state.touchBurst = raw.touchBurst === undefined ? null : raw.touchBurst;
  state.anger = raw.anger === undefined ? null : raw.anger;
  state.careStageUntilMs = raw.careStageUntilMs === undefined ? 0 : raw.careStageUntilMs;
  const timestamp = value => Number.isFinite(value) && value >= 0 && value <= nowMs + 300_000;
  for (const field of ['createdAtMs', 'updatedAtMs', 'periodStartedAtMs', 'routineStartedAtMs']) if (!timestamp(state[field]) || state[field] > state.updatedAtMs) fail();
  if (!PERIODS.includes(state.period) || !Object.hasOwn(TEMPERAMENTS, state.temperament) || state.demoSpeed !== 1) fail();
  if (![null, 'asleep', 'content', 'zoomies'].includes(state.routineStartMode)) fail();
  if (state.lastAttentionAtMs !== null && (!timestamp(state.lastAttentionAtMs) || state.lastAttentionAtMs > state.updatedAtMs)) fail();
  for (const field of ['energy', 'attentionNeed', 'stimulation', 'affection']) if (!Number.isFinite(state[field]) || state[field] < 0 || state[field] > 1) fail();
  if (!['normal', 'warning', 'enough', 'overstimulated', 'recovering'].includes(state.careStage)) fail();
  if (!COUNTER(state.attentionCount) || !COUNTER(state.treatCount)) fail();
  const deadline = value => Number.isFinite(value) && value >= 0 && value <= state.updatedAtMs + 300_000;
  if (!deadline(state.careStageUntilMs) || state.careStageUntilMs > state.updatedAtMs + 8_000) fail();
  if (state.touchBurst !== null) {
    const burst = state.touchBurst;
    if (!isRecord(burst) || !Number.isInteger(burst.count) || burst.count < 1 || burst.count > 16
      || !timestamp(burst.lastAtMs) || burst.lastAtMs !== state.lastAttentionAtMs || burst.lastAtMs > state.updatedAtMs) fail();
    state.touchBurst = pick(burst, ['count', 'lastAtMs']);
  }
  if (state.anger !== null) {
    const anger = state.anger;
    if (!isRecord(anger) || !['overload', 'attack'].includes(anger.level)
      || !timestamp(anger.startedAtMs) || anger.startedAtMs > state.updatedAtMs
      || !deadline(anger.calmAtMs) || !deadline(anger.attackUntilMs) || !deadline(anger.minCalmAtMs)
      || anger.attackUntilMs < anger.startedAtMs || anger.minCalmAtMs < anger.attackUntilMs
      || anger.calmAtMs < anger.minCalmAtMs || anger.calmAtMs > state.updatedAtMs + 190_000
      || anger.attackUntilMs - anger.startedAtMs !== (anger.level === 'attack' ? 10_000 : 0)
      || typeof anger.treatHelpUsed !== 'boolean'
      || !PERIODS.includes(anger.period) || !VARIANTS.includes(anger.variant)) fail();
    state.anger = pick(anger, ['level', 'startedAtMs', 'calmAtMs', 'attackUntilMs', 'minCalmAtMs', 'treatHelpUsed', 'period', 'variant']);
  }
  if (state.tapEffect !== null) {
    const effect = state.tapEffect;
    if (!isRecord(effect) || !timestamp(effect.startedAtMs) || effect.startedAtMs > state.updatedAtMs || ![2_000, CAT_TIMING.attentionHappyMs].includes(effect.endsAtMs - effect.startedAtMs)
      || !MODES_SET.has(effect.sourceMode) || !VARIANTS.includes(effect.variant) || !GESTURES.includes(effect.gesture) || !['happy', 'playfight'].includes(effect.mode)) fail();
    state.tapEffect = pick(effect, ['startedAtMs', 'endsAtMs', 'sourceMode', 'variant', 'gesture', 'mode']);
  }
  if (state.treat !== null) {
    const treat = state.treat;
    if (!isRecord(treat) || !timestamp(treat.startedAtMs) || treat.startedAtMs > state.updatedAtMs || treat.mealEndsAtMs !== treat.startedAtMs + 3_000
      || treat.groomEndsAtMs !== treat.mealEndsAtMs + 2_000 || !VARIANTS.includes(treat.variant)
      || treat.loveEndsAtMs !== treat.groomEndsAtMs + ({ sleep: 30_000, calm: 45_000, wild: 20_000 })[treat.variant]
      || !PERIODS.includes(treat.period) || !MODES_SET.has(treat.sourceMode)
      || !['protective', 'tube-grab', 'affectionate', 'sleepy', 'eager'].includes(treat.startStyle)
      || treat.returnMode !== ({ sleep: 'asleep', calm: 'content', wild: 'zoomies' })[treat.variant]) fail();
    const disturbed = treat.disturbed === undefined ? false : treat.disturbed;
    const calmApplied = treat.calmApplied === undefined ? state.updatedAtMs >= treat.mealEndsAtMs : treat.calmApplied;
    if (typeof disturbed !== 'boolean' || typeof calmApplied !== 'boolean' || (calmApplied && state.updatedAtMs < treat.mealEndsAtMs)) fail();
    state.treat = { ...pick(treat, ['startedAtMs', 'mealEndsAtMs', 'groomEndsAtMs', 'loveEndsAtMs', 'period', 'sourceMode', 'startStyle', 'variant', 'returnMode']), disturbed, calmApplied };
  }
  if (state.recoveryContext !== null) {
    if (!isRecord(state.recoveryContext) || !PERIODS.includes(state.recoveryContext.period) || !VARIANTS.includes(state.recoveryContext.variant)) fail();
    state.recoveryContext = pick(state.recoveryContext, ['period', 'variant']);
  }
  if (['overstimulated', 'recovering'].includes(state.careStage) && !state.recoveryContext) fail();
  return freeze(copy(state));
}

/** Keep remaining mood durations when the computer clock moves backwards. */
function restoreCare(care, nowMs) {
  const savedAt = care?.state?.updatedAtMs;
  if (!Number.isFinite(savedAt) || savedAt <= nowMs) return validateCare(care, nowMs);
  // Validate structure at its own saved time before rebasing, never repair a
  // valid angry cat into a happy one solely because the wall clock changed.
  const state = copy(validateCare(care, savedAt));
  const shift = savedAt - nowMs;
  const move = (object, fields) => {
    if (!object) return;
    for (const field of fields) if (object[field] !== null && object[field] !== undefined) object[field] = Math.max(0, object[field] - shift);
  };
  move(state, ['createdAtMs', 'updatedAtMs', 'periodStartedAtMs', 'routineStartedAtMs', 'lastAttentionAtMs', 'careStageUntilMs']);
  move(state.tapEffect, ['startedAtMs', 'endsAtMs']);
  move(state.treat, ['startedAtMs', 'mealEndsAtMs', 'groomEndsAtMs', 'loveEndsAtMs']);
  move(state.touchBurst, ['lastAtMs']);
  move(state.anger, ['startedAtMs', 'calmAtMs', 'attackUntilMs', 'minCalmAtMs']);
  return validateCare({ schema: CARE_SCHEMA, state }, nowMs);
}

const routineBlocked = state => Boolean(state.anger || state.treat || state.careStage !== 'normal'
  || (state.tapEffect && state.updatedAtMs < state.tapEffect.endsAtMs));
const freshFoodAllowed = state => !(state.anger && state.updatedAtMs < state.anger.attackUntilMs)
  && !(state.treat && state.updatedAtMs < state.treat.groomEndsAtMs);
const routineOptions = (state, allowLitter = true) => ({ period: state.period, blocked: routineBlocked(state), allowFreshFood: freshFoodAllowed(state), allowLitter });

function nextCareEvent(state, schedule) {
  const after = state.updatedAtMs;
  const candidates = [nextBoundary(after, schedule), state.tapEffect?.endsAtMs, state.treat?.mealEndsAtMs,
    state.treat?.groomEndsAtMs, state.treat?.loveEndsAtMs, state.anger?.attackUntilMs,
    state.anger?.calmAtMs, state.careStageUntilMs];
  if (state.careStage !== 'normal' && state.stimulation > 0) {
    const threshold = ['overstimulated', 'recovering'].includes(state.careStage) ? 0.16 : 0.34;
    // Advance just past an inclusive pressure threshold to resume a paused routine.
    candidates.push(after + TEMPERAMENTS[state.temperament].recoveryMs * Math.log(state.stimulation / threshold) + 0.001);
  }
  return Math.min(...candidates.filter(value => Number.isFinite(value) && value > after));
}

export function createSession(settings = {}, nowMs = Date.now(), { routineSeed } = {}) {
  let companyScale = 1, allowLitter = true;
  const normalized = normalizeConfig(settings);
  let config = normalized.config;
  let message = normalized.issues.join(' ');
  let state;
  if (isRecord(settings) && Object.hasOwn(settings, 'care')) {
    try { state = restoreCare(settings.care, nowMs); }
    catch {
      state = createCatState(nowMs, periodAt(nowMs, config.schedule), { temperament: config.temperament });
      const old = settings.care?.state;
      state = Object.freeze({ ...state, attentionCount: COUNTER(old?.attentionCount) ? old.attentionCount : 0, treatCount: COUNTER(old?.treatCount) ? old.treatCount : 0 });
      message = 'Saved care was repaired for this key. Valid attention and treat counts were kept.';
    }
  } else state = createCatState(nowMs, periodAt(nowMs, config.schedule), { temperament: config.temperament });
  state = advanceCare(state, nowMs, config, companyScale).state;
  if (state.temperament !== config.temperament) state = setTemperament(state, config.temperament, nowMs);
  let routine;
  const freshRoutine = now => createRoutine(now, periodAt(now, config.schedule), { appetite: config.appetite, ...(routineSeed === undefined ? {} : { seed: routineSeed }) });
  if (isRecord(settings) && Object.hasOwn(settings, 'routine')) {
    try { routine = restoreRoutine(settings.routine, nowMs); }
    catch { routine = freshRoutine(nowMs); message = [message, 'Saved household routines were repaired for this key. Cat care and counts were preserved.'].filter(Boolean).join(' '); }
  } else routine = freshRoutine(nowMs);
  routine = setRoutineAppetite(routine, config.appetite);
  const frameFrom = result => {
    const overlay = routineFrame(routine, routineOptions(state, allowLitter));
    return { ...result, ...overlay, ...(overlay.routineMode ? { phase: (routine.clockMs % 3_000) / 3_000 } : {}) };
  };

  const session = {
    checkpoint() { return { config, state, routine, message }; },
    restoreCheckpoint(snapshot) { ({ config, state, routine, message } = snapshot); },
    projectSupplies(supplies) { routine = projectRoutineSupplies(routine, supplies); },
    setLitterAccess(value) { allowLitter = Boolean(value); },
    setCompanyScale(value) { companyScale = Math.max(0.5, Math.min(1, Number(value) || 1)); },
    relieveAttention(amount) { state = Object.freeze({ ...state, attentionNeed: Math.max(0, state.attentionNeed - Math.max(0, amount)) }); },
    get config() { return config; },
    get state() { return state; },
    get routine() { return routine; },
    get message() { return message; },
    /** Read the accounted state without moving care or shared resource clocks. */
    frame() { return frameFrom(resolveCatState(state, state.updatedAtMs, state.period, { attentionScale: companyScale })); },
    advance(now, { paused = false } = {}) {
      if (!Number.isFinite(now) || now < 0) throw new RangeError('Cat time must be a finite, non-negative timestamp.');
      // A backwards wall-clock correction shifts remaining care deadlines once.
      // The routine's negative gap pauses this update, then its active clock
      // resumes normally on the next tick instead of waiting for wall time.
      if (now < state.updatedAtMs) state = restoreCare({ schema: CARE_SCHEMA, state }, now);
      let result = advanceCare(state, state.updatedAtMs, config, companyScale);
      state = result.state;
      const settleCare = end => {
        result = advanceCare(state, end, config, companyScale);
        state = result.state;
        if (routinePriority(routine, { allowFreshFood: freshFoodAllowed(state), allowLitter }) && (state.treat || state.tapEffect)) {
          // Overfeeding, due litter and fresh food replace remaining treat/love
          // visuals. Anger, stimulation, counters and base mood clocks survive.
          state = Object.freeze({ ...state, treat: null, tapEffect: null });
          result = advanceCare(state, state.updatedAtMs, config, companyScale);
          state = result.state;
        }
      };
      settleCare(state.updatedAtMs);
      const gap = now - routine.updatedAtMs;
      if (paused || gap < 0 || gap > ROUTINE_TIMING.continuousGapMs || routine.updatedAtMs !== state.updatedAtMs) {
        result = advanceCare(state, now, config, companyScale);
        state = result.state;
        routine = advanceRoutine(routine, now, { ...routineOptions(state, allowLitter), paused: true });
        settleCare(state.updatedAtMs);
      } else {
        // Split only at actual care and schedule events. Frame frequency does not
        // change the amount of quiet time available to household activities.
        for (let count = 0; state.updatedAtMs < now && count < 24; count++) {
          const nextPuke = routine.digestion.pendingPukeAtMs === null ? Infinity
            : routine.updatedAtMs + Math.max(0, routine.digestion.pendingPukeAtMs - routine.clockMs);
          const nextRecovery = routine.activity?.reason === 'overfed' || routine.activity?.kind === 'litter'
            ? routine.updatedAtMs + routine.activity.durationMs - routine.activity.elapsedMs : Infinity;
          const nextLitter = allowLitter && routine.litter.active && routine.litter.soil < LITTER_CAPACITY
            && routine.activity?.reason !== 'overfed' && routine.activity?.kind !== 'litter'
            ? routine.updatedAtMs + Math.max(0, routine.litter.nextAtMs + ROUTINE_TIMING.litterGraceMs - routine.litter.clockMs) : Infinity;
          const nextFresh = freshFoodAllowed(state) && routine.food.active && routine.food.freshMealAtMs !== null
            && routine.food.freshMealAtMs > routine.food.clockMs
            ? routine.updatedAtMs + routine.food.freshMealAtMs - routine.food.clockMs : Infinity;
          const end = Math.min(now, nextCareEvent(state, config.schedule), nextPuke, nextRecovery, nextLitter, nextFresh);
          routine = advanceRoutine(routine, end, routineOptions(state, allowLitter));
          settleCare(end);
          routine = advanceRoutine(routine, end, routineOptions(state, allowLitter));
        }
        routine = advanceRoutine(routine, now, routineOptions(state, allowLitter));
        settleCare(state.updatedAtMs);
      }
      return frameFrom(result);
    },
    attention(now) { session.advance(now); state = giveAttention(state, now, periodAt(Math.max(now, state.updatedAtMs), config.schedule)); return session.advance(now); },
    treat(now) { session.advance(now); state = giveTreat(state, now, periodAt(Math.max(now, state.updatedAtMs), config.schedule)); routine = recordRoutineTreat(routine); return session.advance(now); },
    setCompanions(companions, now) { session.advance(now); routine = setRoutineCompanions(routine, companions); return session.advance(now); },
    inviteFood(now) { session.advance(now); routine = inviteRoutineMeal(routine); return session.advance(now); },
    refill(now) { session.advance(now); routine = refillRoutine(routine); return session.advance(now); },
    cleanLitter(now) { session.advance(now); routine = cleanRoutineLitter(routine); return session.advance(now); },
    updateConfig(patch, now, { strict = true } = {}) {
      const normalizedPatch = normalizeConfig(patch, config, { strict });
      session.advance(now);
      config = normalizedPatch.config;
      routine = setRoutineAppetite(routine, config.appetite);
      if (state.temperament !== config.temperament) state = setTemperament(state, config.temperament, now);
      message = normalizedPatch.issues.join(' ');
      return session.advance(now);
    },
    applyExternal(raw, now) {
      session.updateConfig(raw, now, { strict: false });
      if (isRecord(raw) && Object.hasOwn(raw, 'care')) {
        try { validateCare(raw.care, now); }
        catch { message = 'Invalid saved care was repaired for this key. Its current care and counts were preserved.'; }
      }
      if (isRecord(raw) && Object.hasOwn(raw, 'routine')) {
        try { validateRoutine(raw.routine); }
        catch { message = [message, 'Invalid saved routines were ignored for this key. Its current household routine was preserved.'].filter(Boolean).join(' '); }
      }
      return session.advance(now);
    },
    reset(now) {
      const companions = { food: routine.food.active, litter: routine.litter.active };
      state = createCatState(now, periodAt(now, config.schedule), { temperament: config.temperament });
      routine = setRoutineCompanions(freshRoutine(now), companions);
      message = '';
      return session.advance(now);
    },
    serialize() { return copy({ ...config, care: { schema: CARE_SCHEMA, state }, routine: { schema: ROUTINE_SCHEMA, state: routine } }); },
  };
  return session;
}
