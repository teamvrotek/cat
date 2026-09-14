export const KEY_IMAGE_INTERVAL_MS = 100;

/** Keep only the latest frame, with one SDK write in flight and at most ten starts per second. */
export function queueKeyImage(entry, image, options) {
  const { now, write, active = () => true, onError = () => {},
    schedule = globalThis.setTimeout, unschedule = globalThis.clearTimeout } = options;
  entry.nextImage = image;
  if (entry.rendering) return entry.rendering;
  const remaining = () => {
    const time = now();
    return entry.lastImageAt === undefined || time < entry.lastImageAt ? 0
      : Math.max(0, KEY_IMAGE_INTERVAL_MS - (time - entry.lastImageAt));
  };
  const cancelTimer = () => {
    if (entry.imageTimer !== undefined) entry.cancelImageTimer?.(entry.imageTimer);
    entry.imageTimer = undefined;
  };
  const defer = () => {
    if (!active() || entry.nextImage === null || entry.nextImage === entry.image || entry.imageTimer !== undefined) return;
    const wait = remaining();
    if (!wait) return;
    entry.cancelImageTimer = unschedule;
    entry.imageTimer = schedule(() => {
      entry.imageTimer = undefined;
      if (active() && entry.nextImage !== null) {
        // An unusually early timer can wait for the next regular render request.
        // Do not spin or retry when a suspended/test clock has not advanced.
        if (remaining() > 0) return;
        queueKeyImage(entry, entry.nextImage, options).catch(onError);
      }
    }, Math.ceil(wait));
    entry.imageTimer?.unref?.();
  };
  if (!active()) { cancelKeyImage(entry); return Promise.resolve(); }
  if (remaining() > 0) { defer(); return Promise.resolve(); }
  cancelTimer();
  const rendering = Promise.resolve().then(async () => {
    while (active() && entry.nextImage !== null && remaining() === 0) {
      const next = entry.nextImage;
      entry.nextImage = null;
      if (next === entry.image) continue;
      entry.lastImageAt = now();
      await write(next);
      entry.image = next;
    }
  });
  entry.rendering = rendering;
  rendering.finally(() => {
    if (entry.rendering === rendering) entry.rendering = null;
    defer();
  }).catch(() => {});
  return rendering;
}

export function cancelKeyImage(entry) {
  entry.nextImage = null;
  if (entry.imageTimer !== undefined) entry.cancelImageTimer?.(entry.imageTimer);
  entry.imageTimer = undefined;
}
