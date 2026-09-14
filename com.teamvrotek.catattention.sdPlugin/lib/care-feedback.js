export const LITTER_HOLD_MS = 3_000;

/** Match Caffeine Tracker's three-second confirmation and two fade steps. */
export function getCleanedOpacity(elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs >= 3_000) return 0;
  return elapsedMs >= 2_700 ? 0.25 : elapsedMs >= 2_400 ? 0.65 : 1;
}
