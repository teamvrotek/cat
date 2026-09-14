const minute = 60_000;

/** Real-time intervals, counted only while the matching care key is active. */
export const APPETITES = Object.freeze({
  light: Object.freeze({
    id: 'light', label: 'Light eater', description: 'Smaller appetite, with fewer meals, nibbles and litter visits.',
    mealMinMs: 120 * minute, mealMaxMs: 180 * minute,
    nibbleMinMs: 45 * minute, nibbleMaxMs: 75 * minute,
    litterMinMs: 90 * minute, litterMaxMs: 180 * minute,
  }),
  normal: Object.freeze({
    id: 'normal', label: 'Normal', description: 'Regular meals, occasional small nibbles and a normal litter routine.',
    mealMinMs: 90 * minute, mealMaxMs: 150 * minute,
    nibbleMinMs: 25 * minute, nibbleMaxMs: 45 * minute,
    litterMinMs: 60 * minute, litterMaxMs: 120 * minute,
  }),
  hungry: Object.freeze({
    id: 'hungry', label: 'Hungry', description: 'A bigger appetite, with more meals, nibbles and litter visits.',
    mealMinMs: 45 * minute, mealMaxMs: 90 * minute,
    nibbleMinMs: 15 * minute, nibbleMaxMs: 30 * minute,
    litterMinMs: 45 * minute, litterMaxMs: 90 * minute,
  }),
});

export const DEFAULT_APPETITE = 'normal';
