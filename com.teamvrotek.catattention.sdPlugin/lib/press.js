export const HOLD_MS = 700;

/** Fill to the hold threshold, then perform one action on release. */
export function createPressController({ holdMs = HOLD_MS, onTap = () => {}, onHold = () => {}, onChange = () => {} } = {}) {
  if (!Number.isFinite(holdMs) || holdMs <= 0) throw new RangeError('holdMs must be positive.');
  let startedAt = null;
  let owner = null;
  let held = false;
  let progress = 0;

  const snapshot = () => Object.freeze({ active: startedAt !== null, held, progress, owner });
  const notify = () => onChange(snapshot());
  const validTime = now => {
    if (!Number.isFinite(now) || now < 0) throw new RangeError('Use a finite, non-negative timestamp.');
  };
  const clear = () => { startedAt = null; owner = null; held = false; progress = 0; notify(); };

  const controller = {
    get snapshot() { return snapshot(); },
    start(now, source = 'default') {
      validTime(now);
      if (startedAt !== null) return false;
      startedAt = now;
      owner = source;
      held = false;
      progress = 0;
      notify();
      return true;
    },
    update(now) {
      validTime(now);
      if (startedAt === null || held) return snapshot();
      const next = Math.max(0, Math.min(1, (now - startedAt) / holdMs));
      const changed = progress !== next;
      progress = next;
      if (next === 1) {
        held = true;
        notify();
      } else if (changed) notify();
      return snapshot();
    },
    release(now, source = 'default') {
      validTime(now);
      if (startedAt === null || owner !== source) return false;
      controller.update(now);
      const shouldHold = held;
      clear();
      if (shouldHold) onHold();
      else onTap();
      return true;
    },
    cancel() {
      if (startedAt === null) return false;
      clear();
      return true;
    },
    activate() {
      if (startedAt !== null) return false;
      onTap();
      return true;
    },
  };
  return controller;
}

/** Bind pointer and keyboard input while preserving synthetic accessibility clicks. */
export function attachPressControls(element, { now = () => performance.now(), holdMs = HOLD_MS, onTap, onHold, onChange } = {}) {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  const controller = createPressController({ holdMs, onTap, onHold, onChange });
  const listeners = [];
  let holdTimer = null;
  let clickTimer = null;
  let suppressClick = false;
  let pointerId = null;

  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    listeners.push(() => target.removeEventListener(type, handler));
  };
  const clearHoldTimer = () => {
    if (holdTimer !== null) view.clearTimeout(holdTimer);
    holdTimer = null;
  };
  const suppressNativeClick = () => {
    suppressClick = true;
    if (clickTimer !== null) view.clearTimeout(clickTimer);
    clickTimer = view.setTimeout(() => { suppressClick = false; clickTimer = null; }, 0);
  };
  const releaseCapture = () => {
    const previousPointer = pointerId;
    pointerId = null;
    if (previousPointer !== null && element.hasPointerCapture?.(previousPointer)) element.releasePointerCapture(previousPointer);
  };
  const cancel = () => {
    clearHoldTimer();
    if (controller.cancel()) suppressNativeClick();
    releaseCapture();
  };
  const begin = owner => {
    if (!controller.start(now(), owner)) return false;
    holdTimer = view.setTimeout(() => {
      holdTimer = null;
      controller.update(now());
    }, holdMs);
    return true;
  };
  const finish = owner => {
    if (controller.snapshot.owner !== owner) return;
    clearHoldTimer();
    suppressNativeClick();
    controller.release(now(), owner);
    releaseCapture();
  };
  const keyOwner = event => event.key === ' ' || event.key === 'Spacebar' ? 'key:Space' : event.key === 'Enter' ? 'key:Enter' : null;

  listen(element, 'pointerdown', event => {
    if (event.button !== 0 || event.isPrimary === false) return;
    if (!begin(`pointer:${event.pointerId}`)) return;
    pointerId = event.pointerId;
    try { element.setPointerCapture?.(pointerId); } catch { cancel(); }
  });
  listen(element, 'pointerup', event => finish(`pointer:${event.pointerId}`));
  listen(element, 'pointercancel', event => {
    if (controller.snapshot.owner === `pointer:${event.pointerId}`) cancel();
  });
  listen(element, 'lostpointercapture', event => {
    if (controller.snapshot.owner === `pointer:${event.pointerId}`) cancel();
  });
  listen(element, 'keydown', event => {
    const owner = keyOwner(event);
    if (!owner) return;
    event.preventDefault();
    if (!event.repeat) begin(owner);
  });
  listen(element, 'keyup', event => {
    const owner = keyOwner(event);
    if (!owner) return;
    event.preventDefault();
    finish(owner);
  });
  listen(element, 'click', event => {
    event.preventDefault();
    if (suppressClick) { suppressClick = false; return; }
    if (event.detail === 0) controller.activate();
  });
  listen(element, 'contextmenu', event => { event.preventDefault(); cancel(); });
  listen(element, 'dragstart', event => { event.preventDefault(); cancel(); });
  listen(element, 'blur', cancel);
  listen(view, 'blur', cancel);
  listen(doc, 'visibilitychange', () => { if (doc.hidden) cancel(); });

  return {
    controller,
    cancel,
    destroy() {
      cancel();
      if (clickTimer !== null) view.clearTimeout(clickTimer);
      for (const remove of listeners) remove();
    },
  };
}
